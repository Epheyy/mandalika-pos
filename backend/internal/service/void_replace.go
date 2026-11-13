package service

// Stock: these writers move outlet_variant_stock through voidCore (restock) and createOrderTx (the
// replacement sale), so they bump the outlet stock counter themselves, once, as the last statement.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
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
	switch {
	case forced:
		if err := checkLockedAmounts(repl, ap.Total); err != nil {
			return VoidResult{}, err
		}
		target := ap.Total
		repl.CorrectionTarget = &target
	case in.ReplacementAtOriginalTotal:
		target := ap.Total
		repl.CorrectionTarget = &target
	default:
		repl.CorrectionTarget = nil // an editable replacement never carries a caller-chosen total
	}
	same, err := sameCustomerKeeper(ctx, tx, ap.CustomerID, repl.CustomerID)
	if err != nil {
		return VoidResult{}, err
	}
	repl.PointsDeduction = 0 // never taken from the caller
	if same {
		prior, err := priorPointsDeduction(ctx, tx, in.OrderID)
		if err != nil {
			return VoidResult{}, err
		}
		repl.PointsDeduction = int(ap.Forgiven) + prior
	}
	repl.deductionOut = &ap.ReplDeducted
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

// ReplacementOverride is what the Backoffice form changes on a replacement: the payment lines and the
// customer. Everything else is copied from the original sale.
type ReplacementOverride struct {
	Tenders    json.RawMessage // nil = the original's payment lines
	CustomerID *string         // nil = the original's customer; "" = no customer
}

var errReplaceBundleBackoffice = apperr.New(apperr.Rejected,
	"Transaksi dengan bundle tidak dapat diganti lewat Backoffice. Buat penggantinya di POS.")

// VoidAndReplaceDirect is the Backoffice "Batalkan & perbaiki": the replacement is the original sale
// re-created from its stored lines (with the override applied), in the same transaction as the void.
// The replacement key is "bo:<clientVoidUuid>:replacement", so a retry replays.
func (s *OrderService) VoidAndReplaceDirect(ctx context.Context, in VoidInput, ov ReplacementOverride) (VoidResult, error) {
	if in.Mode != VoidModeReplace || in.ClientVoidUUID == "" {
		return VoidResult{}, ErrVoidReplacementInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return VoidResult{}, err
	}
	defer tx.Rollback(ctx)
	repl, err := replacementFromOriginal(ctx, tx, in.OutletID, in.OrderID, ov, "bo:"+in.ClientVoidUUID+":replacement")
	if err != nil {
		return VoidResult{}, err
	}
	res, err := s.VoidAndReplaceTx(ctx, tx, in, repl)
	if err != nil {
		return VoidResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VoidResult{}, err
	}
	return res, nil
}

// replacementFromOriginal rebuilds the sale input of an order from its stored rows. Promotions are
// not stored on the order, so they are not re-evaluated: VoidAndReplaceTx forces the total to the
// original's for every Backoffice replacement and any gap lands in "Penyesuaian koreksi". Applied
// discount codes, the manual discount and surcharge, redeemed points and notes are copied. These
// reads are unlocked: voidCore re-reads the order under its row lock and decides eligibility.
func replacementFromOriginal(ctx context.Context, tx pgx.Tx, outletID, orderID string, ov ReplacementOverride, key string) (CreateOrderInput, error) {
	in := CreateOrderInput{IdempotencyKey: key, OrderUUID: uuid.NewString(), OutletID: outletID, Offline: true}
	var cust, custName, discType, surchType, discCode, notes, salesmanID, salesmanName, label *string
	var discVal, surchVal *float64
	var codes []string
	var breakdown []byte
	var redeemed int
	err := tx.QueryRow(ctx,
		`SELECT customer_id::text, customer_name, discount_type, discount_value, surcharge_type, surcharge_value,
		        discount_code, COALESCE(applied_discount_codes,'[]'::jsonb), points_redeemed, notes,
		        salesman_id::text, salesman_name, discount_label, discount_breakdown, cashier_id::text, cashier_name
		   FROM orders WHERE id=$1 AND outlet_id=$2`, orderID, outletID).
		Scan(&cust, &custName, &discType, &discVal, &surchType, &surchVal, &discCode, &codes, &redeemed, &notes,
			&salesmanID, &salesmanName, &label, &breakdown, &in.CashierID, &in.CashierName)
	if errors.Is(err, pgx.ErrNoRows) {
		return in, ErrVoidNotFound
	}
	if err != nil {
		return in, err
	}
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	in.CustomerID, in.CustomerName, in.SalesmanID, in.SalesmanName = deref(cust), deref(custName), deref(salesmanID), deref(salesmanName)
	in.Notes, in.DiscountCode, in.DiscountCodes = deref(notes), deref(discCode), codes
	in.DiscountLabel, in.DiscountBreakdown = deref(label), breakdown
	in.ManualKind, in.SurchargeKind = DiscountKind(deref(discType)), DiscountKind(deref(surchType))
	if discVal != nil {
		in.ManualValue = *discVal
	}
	if surchVal != nil {
		in.Surcharge = *surchVal
	}
	in.PointsRedeemed = redeemed
	if ov.CustomerID != nil {
		if *ov.CustomerID != in.CustomerID {
			in.CustomerName, in.PointsRedeemed = "", 0 // another customer cannot spend these points
		}
		in.CustomerID = *ov.CustomerID
	}

	rows, err := tx.Query(ctx,
		`SELECT product_id::text, product_name, variant_size, price, quantity, subtotal, is_bundle, bundle_group IS NOT NULL
		   FROM order_items WHERE order_id=$1 ORDER BY line_no NULLS LAST, id`, orderID)
	if err != nil {
		return in, err
	}
	defer rows.Close()
	for rows.Next() {
		var it OrderItem
		var inSet bool
		if err := rows.Scan(&it.ProductID, &it.ProductName, &it.VariantSize, &it.Price, &it.Quantity, &it.Subtotal, &it.IsBundle, &inSet); err != nil {
			return in, err
		}
		if inSet {
			return in, errReplaceBundleBackoffice
		}
		in.Items = append(in.Items, it)
	}
	if err := rows.Err(); err != nil {
		return in, err
	}
	rows.Close()

	if len(ov.Tenders) > 0 {
		in.Tenders = ov.Tenders
		return in, nil
	}
	orig, err := loadVoidTenders(ctx, tx, orderID)
	if err != nil {
		return in, err
	}
	type tl struct {
		Method string  `json:"method"`
		Amount float64 `json:"amount"`
	}
	lines := make([]tl, len(orig))
	for i, t := range orig {
		lines[i] = tl{t.Method, float64(t.Amount)}
	}
	if in.Tenders, err = json.Marshal(lines); err != nil {
		return in, err
	}
	return in, nil
}

// sameCustomerKeeper reports whether the voided sale's customer (already a keeper id, "" = none) and
// the replacement's customer are the same live customer after merges.
func sameCustomerKeeper(ctx context.Context, tx pgx.Tx, origKeeper, replCustomer string) (bool, error) {
	if origKeeper == "" || replCustomer == "" {
		return false, nil
	}
	if _, err := uuid.Parse(replCustomer); err != nil {
		return false, nil
	}
	keeper, err := resolveMergedCustomer(ctx, tx, replCustomer)
	if err != nil {
		return false, err
	}
	return keeper == origKeeper, nil
}

// priorPointsDeduction is the deduction already recorded for an order that was itself a replacement
// (on the void row or the followup that created it). Voiding that replacement claws back its
// already-reduced earn, so the write-off carries on to the next replacement: without it a chain of
// replacements would hand the written-off points back.
func priorPointsDeduction(ctx context.Context, tx pgx.Tx, orderID string) (int, error) {
	var n int
	err := tx.QueryRow(ctx,
		`SELECT COALESCE((SELECT replacement_points_deducted FROM order_voids WHERE replacement_order_id=$1),
		                 (SELECT replacement_points_deducted FROM order_void_followups WHERE replacement_order_id=$1), 0)`,
		orderID).Scan(&n)
	return n, err
}
