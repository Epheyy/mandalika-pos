package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/ledger"
	"github.com/mandalika/pos-backend/internal/tenderlines"
	"github.com/mandalika/pos-backend/internal/write"
)

// voidTender is one original payment line, stored on the audit row.
type voidTender struct {
	Method string `json:"method"`
	Amount int64  `json:"amount"`
}

// voidItem is one sale stock movement the void looked at.
type voidItem struct {
	Key, OrderItemID, ProductID, Size string
	Qty                               int
	Choice                            string // restock | skip_counted | gone
	CountedID                         string
}

// voidApplied is everything voidCore did, for the audit insert (and, in Phase 2, the replacement).
type voidApplied struct {
	OrderID       string
	Facts         voidFacts
	Authority     VoidAuthority
	OrderNumber   string
	Total         int64
	PaymentMethod string
	Tenders       []voidTender
	Items         []voidItem
	Clawed        int64
	Forgiven      int64
	Restored      int64
	Spend         int64
	VisitReversed bool
	CodesReleased []string
	CustomerID    string
	// Replay is set when the same (device, client void uuid) already voided this order: nothing
	// was written and the stored outcome is returned.
	Replay *VoidResult
}

// VoidOrder voids one sale in its own transaction.
func (s *OrderService) VoidOrder(ctx context.Context, in VoidInput) (VoidResult, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return VoidResult{}, err
	}
	defer tx.Rollback(ctx)
	res, err := s.VoidOrderTx(ctx, tx, in)
	if err != nil {
		return VoidResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VoidResult{}, err
	}
	return res, nil
}

// VoidOrderTx is THE void, inside a caller-owned transaction (the keyed /sync/batch path commits
// it with its operation receipt). It has its own write path: it never writes order_refunds and
// never calls RefundLinesTx, because every money reader and the shift aggregation read refund rows
// as money paid out. Modes none and later; replace is VoidAndReplaceTx.
//
// Lock order (A42, extended): discount codes -> customer -> the order row FOR UPDATE -> the
// shift row FOR SHARE (serialises with CloseShiftTx's FOR UPDATE) -> stock rows in
// (product, size) order -> BumpStockSeq last.
func (s *OrderService) VoidOrderTx(ctx context.Context, tx pgx.Tx, in VoidInput) (VoidResult, error) {
	// "replace" goes through VoidAndReplaceTx. "later" is a Backoffice void whose replacement (or
	// "tanpa pengganti") is recorded afterwards; here it is a plain void with that mode on the audit row.
	switch in.Mode {
	case "":
		in.Mode = VoidModeNone
	case VoidModeNone, VoidModeLater:
	default:
		return VoidResult{}, ErrVoidReplacementInvalid
	}
	voidID := uuid.NewString()
	ap, err := voidCore(ctx, tx, in, voidID, nil)
	if err != nil {
		return VoidResult{}, err
	}
	if ap.Replay != nil {
		return *ap.Replay, nil
	}
	if err := insertVoidAudit(ctx, tx, in, voidID, "", ap); err != nil {
		return VoidResult{}, err
	}
	if voidCountedInClose(ap.Facts) {
		rows := shiftCorrectionRows(in.OrderID, toTenderAmounts(ap.Tenders), "", nil)
		if err := insertShiftCorrections(ctx, tx, ap.Facts.ShiftID, voidID, rows); err != nil {
			return VoidResult{}, err
		}
	}
	if _, err := write.BumpStockSeq(ctx, tx, in.OutletID); err != nil {
		return VoidResult{}, err
	}
	return VoidResult{VoidID: voidID, OrderID: in.OrderID, Authority: ap.Authority, AfterClose: ap.Facts.ShiftStatus == "closed"}, nil
}

// voidOrderRow is the order as voidCore reads it under its row lock.
type voidOrderRow struct {
	status, orderNumber, paymentMethod string
	custID, discountCode, deviceID     *string
	shiftID, voidID                    *string
	appliedCodes                       []string
	earned, redeemed, total            int64
	createdAt                          time.Time
	businessDate                       string
}

// voidCore does everything of a void except the audit insert and the stock-seq bump. extraStock
// is reserved for Phase 2: the replacement's items join the sorted stock lock set.
func voidCore(ctx context.Context, tx pgx.Tx, in VoidInput, voidID string, extraStock []OrderItem) (voidApplied, error) {
	var ap voidApplied
	reason, note, err := NormalizeVoidReason(string(in.Reason), in.Note)
	if err != nil {
		return ap, err
	}
	in.Reason, in.Note = reason, note
	if in.Source != VoidSourcePOS && in.Source != VoidSourceBackoffice {
		return ap, ErrVoidReplacementInvalid
	}
	if _, err := uuid.Parse(in.OrderID); err != nil {
		return ap, ErrVoidNotFound
	}
	if _, err := uuid.Parse(in.OutletID); err != nil {
		return ap, ErrVoidNotFound
	}

	// A42: enter the global lock order (codes -> customer) before the order row. The order's
	// codes are immutable and its customer only changes by a merge: read them unlocked, lock, then
	// lock the order and verify the customer did not move (Busy: nothing applied, caller retries).
	var preCust, preDiscountCode *string
	var preCodes []string
	err = tx.QueryRow(ctx,
		`SELECT customer_id::text, discount_code, COALESCE(applied_discount_codes,'[]'::jsonb)
		   FROM orders WHERE id=$1 AND outlet_id=$2`, in.OrderID, in.OutletID).Scan(&preCust, &preDiscountCode, &preCodes)
	if errors.Is(err, pgx.ErrNoRows) {
		return ap, ErrVoidNotFound
	}
	if err != nil {
		return ap, err
	}
	preRestore := preCodes
	if len(preRestore) == 0 && preDiscountCode != nil && *preDiscountCode != "" {
		preRestore = []string{*preDiscountCode}
	}
	lockedCodes, err := lockCodes(ctx, tx, preRestore, false)
	if err != nil {
		return ap, err
	}
	keeper := ""
	if preCust != nil && *preCust != "" {
		if keeper, err = lockResolvedCustomer(ctx, tx, *preCust); err != nil {
			return ap, err
		}
	}

	var o voidOrderRow
	err = tx.QueryRow(ctx,
		`SELECT status, order_number, customer_id::text, points_earned, points_redeemed, discount_code,
		        COALESCE(applied_discount_codes,'[]'::jsonb), round(total)::bigint, payment_method,
		        device_id::text, shift_id::text, void_id::text, created_at, business_date::text
		   FROM orders WHERE id=$1 AND outlet_id=$2 FOR UPDATE`, in.OrderID, in.OutletID).
		Scan(&o.status, &o.orderNumber, &o.custID, &o.earned, &o.redeemed, &o.discountCode, &o.appliedCodes,
			&o.total, &o.paymentMethod, &o.deviceID, &o.shiftID, &o.voidID, &o.createdAt, &o.businessDate)
	if errors.Is(err, pgx.ErrNoRows) {
		return ap, ErrVoidNotFound
	}
	if err != nil {
		return ap, err
	}
	if (o.custID == nil) != (preCust == nil) || (o.custID != nil && *o.custID != *preCust) {
		return ap, apperr.Wrap(apperr.Busy, write.ErrBusy)
	}

	// Replay: the same tablet or Backoffice void uuid already voided this order. Runs before the
	// status checks because the replayed void is why the order is cancelled now.
	if in.DeviceID != "" && in.ClientVoidUUID != "" {
		res, found, rerr := replayedVoid(ctx, tx, in.OrderID, in.DeviceID, in.ClientVoidUUID)
		if rerr != nil {
			return ap, rerr
		}
		if found {
			ap.Replay = &res
			return ap, nil
		}
	}

	facts, err := loadVoidFacts(ctx, tx, true, in, o)
	if err != nil {
		return ap, err
	}
	if err := checkVoidEligible(facts); err != nil {
		return ap, err
	}
	authority, err := decideVoidAuthority(facts, in)
	if err != nil {
		return ap, err
	}
	ap.OrderID = in.OrderID
	ap.Facts, ap.Authority = facts, authority
	ap.OrderNumber, ap.Total, ap.PaymentMethod, ap.CustomerID = o.orderNumber, o.total, o.paymentMethod, keeper

	if ap.Tenders, err = loadVoidTenders(ctx, tx, in.OrderID); err != nil {
		return ap, err
	}
	if ap.Items, err = planVoidStock(ctx, tx, in, o, extraStock); err != nil {
		return ap, err
	}
	if err := restockVoidLines(ctx, tx, in, voidID, o.orderNumber, ap.Items); err != nil {
		return ap, err
	}
	if err := reverseVoidCustomer(ctx, tx, in, o, keeper, &ap); err != nil {
		return ap, err
	}
	if ap.CodesReleased, err = releaseVoidCodes(ctx, tx, o, lockedCodes); err != nil {
		return ap, err
	}

	// The status flip last among the order writes. void_id's FK is deferred: the audit row is
	// inserted by the caller afterwards, in this same transaction.
	tag, err := tx.Exec(ctx, `UPDATE orders SET status='cancelled', void_id=$2 WHERE id=$1 AND status='completed'`, in.OrderID, voidID)
	if err != nil {
		return ap, fmt.Errorf("cancel order: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ap, ErrVoidAlreadyVoided
	}
	return ap, nil
}

// loadVoidFacts reads the shift, refund and setting facts the pure rules decide on, locking the
// order's shift FOR SHARE so the void serialises with CloseShiftTx.
func loadVoidFacts(ctx context.Context, tx voidQuerier, lock bool, in VoidInput, o voidOrderRow) (voidFacts, error) {
	share := ""
	if lock {
		share = " FOR SHARE"
	}
	f := voidFacts{
		Status: o.status, HasVoid: o.voidID != nil, OutletID: in.OutletID,
		CreatedAt: o.createdAt, BusinessDate: o.businessDate,
	}
	if o.deviceID != nil {
		f.DeviceID = *o.deviceID
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM order_refunds WHERE order_id=$1`, in.OrderID).Scan(&f.RefundCount); err != nil {
		return f, err
	}
	if err := tx.QueryRow(ctx,
		`SELECT (now() AT TIME ZONE COALESCE((SELECT timezone FROM outlets WHERE id=$1),'Asia/Jakarta'))::date::text,
		        (SELECT void_window_days FROM app_settings WHERE id=1)`, in.OutletID).Scan(&f.Today, &f.WindowDays); err != nil {
		return f, err
	}
	if o.shiftID != nil && *o.shiftID != "" {
		f.ShiftID = *o.shiftID
		if err := tx.QueryRow(ctx, `SELECT status, closed_at FROM shifts WHERE id=$1`+share, f.ShiftID).Scan(&f.ShiftStatus, &f.ShiftClosedAt); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return f, fmt.Errorf("lock sale shift: %w", err)
		}
	}
	if f.ShiftStatus == "closed" {
		// A replacement booked as a correction counts in the closed shift although it was created
		// after the close (decision C).
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM shift_corrections WHERE order_id=$1 AND kind='replacement')`, in.OrderID).
			Scan(&f.HasReplacementCorrection); err != nil {
			return f, err
		}
	}
	if _, err := uuid.Parse(in.CallerShiftID); err == nil {
		if in.CallerShiftID == f.ShiftID {
			f.CallerShiftStatus = f.ShiftStatus
			if err := tx.QueryRow(ctx, `SELECT opened_at FROM shifts WHERE id=$1`, in.CallerShiftID).Scan(&f.CallerShiftOpenedAt); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return f, err
			}
		} else {
			err := tx.QueryRow(ctx, `SELECT status, opened_at FROM shifts WHERE id=$1 AND outlet_id=$2`+share, in.CallerShiftID, in.OutletID).
				Scan(&f.CallerShiftStatus, &f.CallerShiftOpenedAt)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return f, fmt.Errorf("lock caller shift: %w", err)
			}
		}
	}
	return f, nil
}

func loadVoidTenders(ctx context.Context, tx pgx.Tx, orderID string) ([]voidTender, error) {
	rows, err := tx.Query(ctx,
		`SELECT tl.method, round(tl.amount)::bigint FROM orders o `+tenderlines.Lateral+` WHERE o.id=$1 ORDER BY tl.seq`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []voidTender{}
	for rows.Next() {
		var t voidTender
		if err := rows.Scan(&t.Method, &t.Amount); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// planVoidStock reads the sale's own ledger movements (giveaway included), locks their stock rows
// (with extraStock, sorted) and decides each line: restock, skip_counted (an approved stock count
// already corrected it) or gone (variant and stock row both deleted). ORDER BY is the stock-row
// apply order: keep it.
func planVoidStock(ctx context.Context, tx pgx.Tx, in VoidInput, o voidOrderRow, extraStock []OrderItem) ([]voidItem, error) {
	rows, err := tx.Query(ctx,
		`SELECT dedupe_key, product_id::text, variant_size, -qty
		   FROM stock_movements
		  WHERE kind='sale' AND ref_type='order' AND ref_id=$1 AND qty < 0
		  ORDER BY product_id, variant_size, dedupe_key`, in.OrderID)
	if err != nil {
		return nil, err
	}
	var items []voidItem
	for rows.Next() {
		var it voidItem
		if err := rows.Scan(&it.Key, &it.ProductID, &it.Size, &it.Qty); err != nil {
			rows.Close()
			return nil, err
		}
		if id, ok := strings.CutPrefix(it.Key, "sale:"); ok {
			it.OrderItemID = id
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		var needed bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=$1 AND NOT oi.is_bundle
			          AND NOT EXISTS (SELECT 1 FROM sale_stock_exceptions x
			                           WHERE x.order_item_id = oi.id AND x.kind='unresolved_variant'))`, in.OrderID).Scan(&needed); err != nil {
			return nil, err
		}
		if needed {
			return nil, ErrVoidNoMovements
		}
		return nil, nil
	}

	lockSet := make([]OrderItem, 0, len(items)+len(extraStock))
	for _, it := range items {
		lockSet = append(lockSet, OrderItem{ProductID: it.ProductID, VariantSize: it.Size})
	}
	lockSet = append(lockSet, extraStock...)
	if err := lockStockRowsSorted(ctx, tx, in.OutletID, lockSet); err != nil {
		return nil, err
	}

	for i := range items {
		it := &items[i]
		var live bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id=$1 AND pv.size=$2)
			     OR EXISTS (SELECT 1 FROM outlet_variant_stock s WHERE s.outlet_id=$3 AND s.product_id=$1 AND s.variant_size=$2)`,
			it.ProductID, it.Size, in.OutletID).Scan(&live); err != nil {
			return nil, err
		}
		if !live {
			it.Choice = "gone"
			continue
		}
		counted, err := voidCountedAfter(ctx, tx, in.OutletID, it.ProductID, it.Size, o.createdAt)
		if err != nil {
			return nil, err
		}
		it.CountedID = counted
		it.Choice = string(VoidStockRestock)
		if counted == "" {
			continue
		}
		// An approved stock count covered this item after the sale: restocking blindly would correct
		// the stock twice. The user must choose; a void with no choice (offline) is refused whole.
		switch in.StockChoices[it.Key] {
		case VoidStockSkipCounted:
			it.Choice = string(VoidStockSkipCounted)
		case VoidStockRestock:
		default:
			return nil, ErrVoidCountNeedsChoice
		}
	}
	return items, nil
}

// voidCountedAfter returns the latest stock count of the outlet that counted this item after the sale
// moved its stock, or "". A count still open (in progress, awaiting approval) counts too: it applies
// actual minus the baseline taken at counting time, so restocking now would be corrected a second time
// when it completes. A line only counts once it has a counted_at (open) or the count has completed_at. saleCreatedAt is the server's orders.created_at, when the
// stock row was decremented (never client_created_at).
func voidCountedAfter(ctx context.Context, tx voidQuerier, outletID, productID, size string, saleCreatedAt time.Time) (string, error) {
	var id string
	err := tx.QueryRow(ctx,
		`SELECT c.id::text
		   FROM stock_counts c JOIN stock_count_items i ON i.stock_count_id = c.id
		  WHERE c.outlet_id=$1 AND c.status NOT IN ('planned','cancelled') AND i.product_id=$2 AND i.variant_size=$3
		    AND i.actual_qty IS NOT NULL AND COALESCE(i.counted_at, c.completed_at) > $4
		  ORDER BY COALESCE(i.counted_at, c.completed_at) DESC, c.id LIMIT 1`,
		outletID, productID, size, saleCreatedAt).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// restockVoidLines returns the restock lines to stock and writes the ledger document of kind
// 'void' (held for the ERP until Phase 5). Plain upserts in the locked order, then ledger reads.
func restockVoidLines(ctx context.Context, tx pgx.Tx, in VoidInput, voidID, orderNumber string, items []voidItem) error {
	doc := ledger.Document{
		Key: "void:" + voidID, Kind: ledger.KindVoid,
		LocationType: ledger.LocOutlet, LocationID: in.OutletID,
		RefType: "order", RefID: in.OrderID, RefNumber: orderNumber, Actor: in.UserID,
		OccurredAt: time.Now(),
	}
	for _, it := range items {
		if it.Choice != string(VoidStockRestock) {
			continue
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			   VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size)
			   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
			in.OutletID, it.ProductID, it.Size, it.Qty); err != nil {
			return fmt.Errorf("restock void line: %w", err)
		}
		doc.Lines = append(doc.Lines, ledger.Line{
			ProductID: it.ProductID, VariantSize: it.Size, Qty: it.Qty, RefLine: it.OrderItemID,
			DedupeKey:          "void:" + voidID + ":" + it.Key,
			RefundOfMovementID: ledger.MovementID(it.Key),
		})
	}
	if len(doc.Lines) == 0 {
		return nil // stockless void: no outbox row; Phase 5 backfills from order_voids.erp_document_key
	}
	_, err := ledger.RecordDeltas(ctx, tx, doc)
	return err
}

// reverseVoidCustomer undoes the sale's customer effects as if the sale never happened: redeemed
// points are given back FIRST, then earned points are clawed back (floored at the balance including
// the restored points; the shortfall is recorded as forgiven), spend drops by the sale and the visit
// is removed (unlike a refund, the voided sale never happened). Restoring first makes the reversal
// exact whenever balance + redeemed >= earned. last_visit moves back when this sale was the latest.
func reverseVoidCustomer(ctx context.Context, tx pgx.Tx, in VoidInput, o voidOrderRow, keeper string, ap *voidApplied) error {
	if keeper == "" {
		return nil
	}
	var bal int
	err := tx.QueryRow(ctx, `SELECT points FROM customers WHERE id=$1 FOR UPDATE`, keeper).Scan(&bal)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // a customer created on a device and not synced yet: nothing to reverse
	}
	if err != nil {
		return fmt.Errorf("load points for void: %w", err)
	}
	afterRestore := int64(bal) + o.redeemed
	clawed := int64(write.PointsClawback(int(afterRestore), int(o.earned)))
	ap.Clawed, ap.Forgiven, ap.Restored = clawed, o.earned-clawed, o.redeemed
	newBal := afterRestore - clawed
	if o.redeemed > 0 {
		if err := write.InsertPointTx(ctx, tx, write.PointTxRow{
			CustomerID: keeper, Type: "void", Points: int(o.redeemed), BalanceAfter: int(afterRestore),
			Reason:  fmt.Sprintf("Pengembalian poin tukar dari transaksi dibatalkan %s", o.orderNumber),
			OrderID: in.OrderID, ByID: in.UserID, ByName: in.UserName,
		}); err != nil {
			return fmt.Errorf("ledger void restore: %w", err)
		}
	}
	if clawed > 0 {
		if err := write.InsertPointTx(ctx, tx, write.PointTxRow{
			CustomerID: keeper, Type: "void", Points: -int(clawed), BalanceAfter: int(newBal),
			Reason:  fmt.Sprintf("Pembatalan poin dari transaksi dibatalkan %s", o.orderNumber),
			OrderID: in.OrderID, ByID: in.UserID, ByName: in.UserName,
		}); err != nil {
			return fmt.Errorf("ledger void clawback: %w", err)
		}
	}
	if clawed > 0 || o.redeemed > 0 {
		if _, err := tx.Exec(ctx, `UPDATE customers SET points=$2 WHERE id=$1`, keeper, int(newBal)); err != nil {
			return fmt.Errorf("update points on void: %w", err)
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE customers SET total_spent = GREATEST(total_spent - $2, 0), visit_count = GREATEST(visit_count - 1, 0) WHERE id=$1`,
		keeper, o.total); err != nil {
		return fmt.Errorf("reverse customer spend and visit: %w", err)
	}
	// last_visit: the sale set it to now(), which equals orders.created_at (same transaction). When it
	// still equals that, this sale was the latest visit (it already overwrote any older value, imported
	// or not): move it back to the latest remaining non-voided order, or NULL when there is none (the
	// customer has not visited). A later visit (a different value) is never touched.
	if _, err := tx.Exec(ctx,
		`UPDATE customers c SET last_visit =
		        (SELECT max(x.created_at) FROM orders x
		          WHERE x.customer_id = c.id AND x.id <> $2 AND x.status IN ('completed','partially_refunded','refunded'))
		  WHERE c.id = $1 AND c.last_visit = $3`, keeper, in.OrderID, o.createdAt); err != nil {
		return fmt.Errorf("reverse customer last_visit: %w", err)
	}
	ap.Spend, ap.VisitReversed = o.total, true
	return nil
}

// releaseVoidCodes gives back each applied discount code's use, in the order the rows were locked.
func releaseVoidCodes(ctx context.Context, tx pgx.Tx, o voidOrderRow, locked []string) ([]string, error) {
	restore := o.appliedCodes
	if len(restore) == 0 && o.discountCode != nil && *o.discountCode != "" {
		restore = []string{*o.discountCode}
	}
	count := make(map[string]int, len(restore))
	for _, c := range restore {
		if c != "" {
			count[c]++
		}
	}
	released := []string{}
	for _, code := range locked {
		for i := 0; i < count[code]; i++ {
			if _, err := tx.Exec(ctx,
				`UPDATE discount_codes SET usage_count = GREATEST(usage_count - 1, 0) WHERE code=$1`, code); err != nil {
				return nil, fmt.Errorf("release discount usage: %w", err)
			}
			released = append(released, code)
		}
	}
	return released, nil
}

// replayedVoid rebuilds the outcome of an earlier void with the same (device, client void uuid).
// The uuid is unique across orders, so a row on another order is a mismatch, never a replay.
func replayedVoid(ctx context.Context, tx pgx.Tx, orderID, deviceID, clientUUID string) (VoidResult, bool, error) {
	var res VoidResult
	var rOrder string
	var repl *string
	err := tx.QueryRow(ctx,
		`SELECT id::text, order_id::text, replacement_order_id::text, authority, after_close
		   FROM order_voids WHERE device_id=$1 AND client_void_uuid=$2::uuid`, deviceID, clientUUID).
		Scan(&res.VoidID, &rOrder, &repl, &res.Authority, &res.AfterClose)
	if errors.Is(err, pgx.ErrNoRows) {
		return VoidResult{}, false, nil
	}
	if err != nil {
		return VoidResult{}, false, err
	}
	if rOrder != orderID {
		return VoidResult{}, false, ErrVoidReplacementInvalid
	}
	res.OrderID, res.Replayed = rOrder, true
	if repl != nil {
		res.ReplacementOrderID = *repl
	}
	return res, true, nil
}

// insertVoidAudit writes the append-only audit row and its per-line choices.
func insertVoidAudit(ctx context.Context, tx pgx.Tx, in VoidInput, voidID, replacementID string, ap voidApplied) error {
	tenders, err := json.Marshal(ap.Tenders)
	if err != nil {
		return err
	}
	codes, err := json.Marshal(ap.CodesReleased)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_voids (id, order_id, outlet_id, business_date, shift_id, after_close, counted_in_close,
		        source, authority, mode, replacement_order_id, reason_code, note, voided_by, voided_by_name,
		        device_id, client_void_uuid, original_total, original_payment_method, original_tenders,
		        points_clawed, points_forgiven, points_restored, spend_reversed, visit_reversed, codes_released,
		        erp_document_key)
		 VALUES ($1,$2,$3,$4::date,NULLIF($5,'')::uuid,$6,$7,$8,$9,$10,NULLIF($11,'')::uuid,$12,NULLIF($13,''),
		        NULLIF($14,'')::uuid,NULLIF($15,''),NULLIF($16,''),NULLIF($17,'')::uuid,$18,$19,$20::jsonb,
		        $21,$22,$23,$24,$25,$26::jsonb,$27)`,
		voidID, in.OrderID, in.OutletID, ap.Facts.BusinessDate, ap.Facts.ShiftID, ap.Facts.ShiftStatus == "closed",
		voidCountedInClose(ap.Facts), string(in.Source), string(ap.Authority), string(in.Mode), replacementID,
		string(in.Reason), in.Note, in.UserID, in.UserName, in.DeviceID, in.ClientVoidUUID, ap.Total, ap.PaymentMethod,
		string(tenders), ap.Clawed, ap.Forgiven, ap.Restored, ap.Spend, ap.VisitReversed, string(codes), "void:"+voidID); err != nil {
		return fmt.Errorf("insert order_voids: %w", err)
	}
	for _, it := range ap.Items {
		if _, err := tx.Exec(ctx,
			`INSERT INTO order_void_items (void_id, movement_key, order_item_id, product_id, variant_size, qty, choice, counted_stock_count_id)
			 VALUES ($1,$2,NULLIF($3,'')::uuid,$4,$5,$6,$7,NULLIF($8,'')::uuid)`,
			voidID, it.Key, it.OrderItemID, it.ProductID, it.Size, it.Qty, it.Choice, it.CountedID); err != nil {
			return fmt.Errorf("insert order_void_items: %w", err)
		}
	}
	return nil
}

// voidQuerier is the read surface shared by a transaction (the void) and the pool (the preview).
type voidQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}
