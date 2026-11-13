package service

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/write"
)

// VoidAndReplace voids one sale and records its replacement in one transaction of its own (the
// Backoffice path). The tablet's keyed /sync/batch path uses VoidAndReplaceTx inside its receipt.
func (s *OrderService) VoidAndReplace(ctx context.Context, in VoidInput, repl CreateOrderInput) (VoidResult, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return VoidResult{}, err
	}
	defer tx.Rollback(ctx)
	res, err := s.VoidAndReplaceTx(ctx, tx, in, repl)
	if err != nil {
		return VoidResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VoidResult{}, err
	}
	return res, nil
}

// VoidAndReplaceTx is "Batalkan & perbaiki": the void and its replacement commit together or not at
// all. Lock order (A42, extended): codes and customers of BOTH sales (one pass each) -> the original
// order row -> its shift FOR SHARE -> stock rows of both sales in one sorted pass -> the replacement
// insert -> BumpStockSeq last, once. The replacement takes the original's business day and shift, so
// the money stays on the day it was taken; on a closed shift both sides are booked as correction rows.
func (s *OrderService) VoidAndReplaceTx(ctx context.Context, tx pgx.Tx, in VoidInput, repl CreateOrderInput) (VoidResult, error) {
	if in.Mode != VoidModeReplace || len(repl.Items) == 0 {
		return VoidResult{}, ErrVoidReplacementInvalid
	}
	if err := lockVoidUnion(ctx, tx, in, repl); err != nil {
		return VoidResult{}, err
	}

	voidID := uuid.NewString()
	ap, err := voidCore(ctx, tx, in, voidID, repl.Items)
	if err != nil {
		return VoidResult{}, err
	}
	if ap.Replay != nil {
		return *ap.Replay, nil // an applied void replays; never reach the sale core again
	}

	shiftOpen := ap.Facts.ShiftID != "" && ap.Facts.ShiftStatus == "open"
	forced := !(ap.Authority == VoidOwnShift && in.Source == VoidSourcePOS && shiftOpen)
	repl = pinReplacement(repl, ap)
	if forced {
		if err := checkLockedAmounts(repl, ap.Total); err != nil {
			return VoidResult{}, err
		}
		target := ap.Total
		repl.CorrectionTarget = &target
	}
	created, err := s.createOrderTx(ctx, tx, repl)
	if err != nil {
		return VoidResult{}, err
	}
	if created.Duplicate {
		return VoidResult{}, ErrVoidReplacementInvalid // the replacement key already names another sale
	}
	if err := insertVoidAudit(ctx, tx, in, voidID, created.OrderID, ap); err != nil {
		return VoidResult{}, err
	}

	var origSide, replSide []tenderAmount
	if voidCountedInClose(ap.Facts) {
		origSide = toTenderAmounts(ap.Tenders)
	}
	if replacementNeedsDelta(ap.Facts.ShiftStatus == "closed", ap.Facts) {
		replTenders, err := loadVoidTenders(ctx, tx, created.OrderID)
		if err != nil {
			return VoidResult{}, err
		}
		replSide = toTenderAmounts(replTenders)
	}
	rows := shiftCorrectionRows(in.OrderID, origSide, created.OrderID, replSide)
	if err := insertShiftCorrections(ctx, tx, ap.Facts.ShiftID, voidID, rows); err != nil {
		return VoidResult{}, err
	}
	if _, err := write.BumpStockSeq(ctx, tx, in.OutletID); err != nil {
		return VoidResult{}, err
	}
	return VoidResult{
		VoidID: voidID, OrderID: in.OrderID, ReplacementOrderID: created.OrderID,
		Authority: ap.Authority, AfterClose: ap.Facts.ShiftStatus == "closed",
	}, nil
}

// lockVoidUnion reads the original's codes and customer (unlocked: they are immutable apart from a
// customer merge, which voidCore re-verifies under the order lock) and takes the union of both
// sales' codes and customers before anything else.
func lockVoidUnion(ctx context.Context, tx pgx.Tx, in VoidInput, repl CreateOrderInput) error {
	var preCust, preDiscountCode *string
	var preCodes []string
	err := tx.QueryRow(ctx,
		`SELECT customer_id::text, discount_code, COALESCE(applied_discount_codes,'[]'::jsonb)
		   FROM orders WHERE id=$1 AND outlet_id=$2`, in.OrderID, in.OutletID).Scan(&preCust, &preDiscountCode, &preCodes)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // voidCore reports ErrVoidNotFound
	}
	if err != nil {
		return err
	}
	if len(preCodes) == 0 && preDiscountCode != nil && *preDiscountCode != "" {
		preCodes = []string{*preDiscountCode}
	}
	origCust := ""
	if preCust != nil {
		origCust = *preCust
	}
	return lockVoidAndReplacement(ctx, tx, preCodes, origCust, repl)
}

// pinReplacement forces the replacement onto the original's outlet, shift and business day.
func pinReplacement(repl CreateOrderInput, ap voidApplied) CreateOrderInput {
	repl.ReplacesOrderID = ap.OrderID
	repl.ShiftID = ap.Facts.ShiftID
	repl.BusinessDate = ap.Facts.BusinessDate
	repl.OutletID = ap.Facts.OutletID
	return repl
}

// checkLockedAmounts refuses a replacement whose payment lines do not add up to what the original
// received: the amounts are not editable once the original's shift is closed (or for any
// Backoffice replacement), so the money cannot move.
func checkLockedAmounts(repl CreateOrderInput, origTotal int64) error {
	lines, present, err := parseTenders(repl.Tenders)
	if err != nil {
		return err
	}
	if !present {
		lines = []TenderLine{{Method: repl.PaymentMethod, Amount: repl.AmountPaid}}
	}
	var sum int64
	for _, l := range lines {
		sum += toCents(l.Amount)
	}
	if sum != origTotal*100 {
		return errVoidAmountsLocked(formatRupiahID(origTotal))
	}
	return nil
}

// formatRupiahID writes a whole-rupiah amount with Indonesian thousand separators (300.000).
func formatRupiahID(v int64) string {
	neg := v < 0
	if neg {
		v = -v
	}
	s := strconv.FormatInt(v, 10)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

func toTenderAmounts(ts []voidTender) []tenderAmount {
	out := make([]tenderAmount, len(ts))
	for i, t := range ts {
		out[i] = tenderAmount{Method: t.Method, Amount: t.Amount}
	}
	return out
}

// insertShiftCorrections appends the correction rows of a closed shift (never updated afterwards).
func insertShiftCorrections(ctx context.Context, tx pgx.Tx, shiftID, voidID string, rows []shiftCorrection) error {
	for _, r := range rows {
		if _, err := tx.Exec(ctx,
			`INSERT INTO shift_corrections (shift_id, void_id, order_id, kind, method, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
			shiftID, voidID, r.OrderID, r.Kind, r.Method, r.Amount); err != nil {
			return fmt.Errorf("insert shift correction: %w", err)
		}
	}
	return nil
}
