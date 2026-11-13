package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/write"
)

// laterVoid is a cancelled order read under its row lock, with the void that cancelled it.
type laterVoid struct {
	row        voidOrderRow
	voidID     string
	mode       string
	hasFollow  bool
	origTotal  int64
	cancelled  bool
	hasVoidRow bool
}

// lockLaterVoid locks the cancelled original FOR UPDATE and reads its void row and followup. Both
// "Buat pengganti" and "Tandai tanpa pengganti" start here, so they serialise on the order row.
func lockLaterVoid(ctx context.Context, tx pgx.Tx, outletID, orderID string) (laterVoid, error) {
	var lv laterVoid
	if _, err := uuid.Parse(orderID); err != nil {
		return lv, ErrVoidNotFound
	}
	o := &lv.row
	err := tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id::text, points_earned, points_redeemed, discount_code,
		        COALESCE(applied_discount_codes,'[]'::jsonb), round(total)::bigint, payment_method,
		        device_id::text, shift_id::text, void_id::text, created_at, business_date::text
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`, orderID, outletID).
		Scan(&o.status, &o.orderNumber, &o.custID, &o.earned, &o.redeemed, &o.discountCode, &o.appliedCodes,
			&o.total, &o.paymentMethod, &o.deviceID, &o.shiftID, &o.voidID, &o.createdAt, &o.businessDate)
	if errors.Is(err, pgx.ErrNoRows) {
		return lv, ErrVoidNotFound
	}
	if err != nil {
		return lv, err
	}
	lv.cancelled = o.status == "cancelled" && o.voidID != nil
	lv.origTotal = o.total
	if !lv.cancelled {
		return lv, nil
	}
	err = tx.QueryRow(ctx, `SELECT id::text, mode FROM order_voids WHERE order_id=$1`, orderID).Scan(&lv.voidID, &lv.mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return lv, nil // an fsmigrate-imported cancelled order has no void row
	}
	if err != nil {
		return lv, err
	}
	lv.hasVoidRow = true
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM order_void_followups WHERE void_id=$1)`, lv.voidID).Scan(&lv.hasFollow); err != nil {
		return lv, err
	}
	return lv, nil
}

// open reports whether the void still waits for a replacement or a "tanpa pengganti" mark.
func (lv laterVoid) open() bool {
	return lv.cancelled && lv.hasVoidRow && lv.mode == string(VoidModeLater) && !lv.hasFollow
}

// CreateReplacementOrder is "Buat pengganti": the replacement of an older sale that was voided with
// mode "later". It is a sale of its own transaction, pinned to the voided sale's business day and
// shift, whose amounts always equal what the original received. A resend after a lost ack finds the
// replacement key in processed_keys first and answers Duplicate with the stored id, so it never
// reaches the "already replaced" refusal.
func (s *OrderService) CreateReplacementOrder(ctx context.Context, in CreateOrderInput, canVoidAny bool, today string) (CreateOrderResult, error) {
	if len(in.Items) == 0 {
		return CreateOrderResult{}, ErrNoItems
	}
	if in.OutletID == "" {
		return CreateOrderResult{}, ErrNoOutlet
	}
	if _, err := uuid.Parse(in.ReplacesOrderID); err != nil {
		return CreateOrderResult{}, ErrVoidReplacementInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return CreateOrderResult{}, err
	}
	defer tx.Rollback(ctx)

	var existing string
	err = tx.QueryRow(ctx, `SELECT order_id FROM processed_keys WHERE idempotency_key=$1`, in.IdempotencyKey).Scan(&existing)
	if err == nil {
		return CreateOrderResult{OrderID: existing, Duplicate: true}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CreateOrderResult{}, fmt.Errorf("idempotency check: %w", err)
	}
	if !canVoidAny {
		return CreateOrderResult{}, ErrVoidForbidden
	}

	if err := lockVoidAndReplacement(ctx, tx, nil, "", in); err != nil {
		return CreateOrderResult{}, err
	}
	lv, err := lockLaterVoid(ctx, tx, in.OutletID, in.ReplacesOrderID)
	if err != nil {
		return CreateOrderResult{}, err
	}
	if !lv.open() {
		return CreateOrderResult{}, ErrVoidReplacementInvalid
	}
	vin := VoidInput{OutletID: in.OutletID, OrderID: in.ReplacesOrderID}
	facts, err := loadVoidFacts(ctx, tx, true, vin, lv.row)
	if err != nil {
		return CreateOrderResult{}, err
	}
	if today != "" {
		facts.Today = today
	}
	window := facts.WindowDays
	if window <= 0 {
		window = DefaultVoidWindowDays
	}
	if voidAgeDays(facts.BusinessDate, facts.Today) > window {
		return CreateOrderResult{}, errVoidOutsideWindow(window)
	}

	in.ReplacesOrderID, in.ShiftID, in.BusinessDate = vin.OrderID, facts.ShiftID, facts.BusinessDate
	if err := checkLockedAmounts(in, lv.origTotal); err != nil {
		return CreateOrderResult{}, err
	}
	target := lv.origTotal
	in.CorrectionTarget = &target

	res, err := s.createOrderTx(ctx, tx, in)
	if err != nil {
		return CreateOrderResult{}, err
	}
	if res.Duplicate {
		return CreateOrderResult{}, ErrVoidReplacementInvalid
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_void_followups (void_id, kind, replacement_order_id, actor, actor_name)
		 VALUES ($1,'replacement',$2,NULLIF($3,'')::uuid,NULLIF($4,''))`,
		lv.voidID, res.OrderID, in.CashierID, in.CashierName); err != nil {
		return CreateOrderResult{}, fmt.Errorf("insert void followup: %w", err)
	}
	if replacementNeedsDelta(facts.ShiftStatus == "closed", facts) {
		replTenders, err := loadVoidTenders(ctx, tx, res.OrderID)
		if err != nil {
			return CreateOrderResult{}, err
		}
		rows := shiftCorrectionRows("", nil, res.OrderID, toTenderAmounts(replTenders))
		if err := insertShiftCorrections(ctx, tx, facts.ShiftID, lv.voidID, rows); err != nil {
			return CreateOrderResult{}, err
		}
	}
	seqs, err := write.BumpStockSeq(ctx, tx, in.OutletID)
	if err != nil {
		return CreateOrderResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateOrderResult{}, fmt.Errorf("commit: %w", err)
	}
	if seq := seqs[strings.ToLower(strings.TrimSpace(in.OutletID))]; seq > 0 {
		res.StockSeq = &seq
	}
	return res, nil
}

// MarkVoidNoReplacement records "Tandai tanpa pengganti" on a void made with mode "later": one
// insert-only followup row. It never edits the audit row.
func (s *OrderService) MarkVoidNoReplacement(ctx context.Context, outletID, orderID, userID, userName, note string) error {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > MaxVoidNoteRunes {
		return ErrVoidReasonInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	lv, err := lockLaterVoid(ctx, tx, outletID, orderID)
	if err != nil {
		return err
	}
	if !lv.open() {
		return ErrVoidReplacementInvalid
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_void_followups (void_id, kind, actor, actor_name, note)
		 VALUES ($1,'no_replacement',NULLIF($2,'')::uuid,NULLIF($3,''),NULLIF($4,''))`,
		lv.voidID, userID, userName, note); err != nil {
		return fmt.Errorf("insert void followup: %w", err)
	}
	return tx.Commit(ctx)
}
