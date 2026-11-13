package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/write"
)

// conflictTx answers the order INSERT with a failure, like a lost same-key race or an unrelated busy.
type conflictTx struct {
	*inputTestTx
	insertErr error
}

func (tx *conflictTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if tx.insertErr != nil && containsInsertOrders(sql) {
		return inputTestRow(func(...any) error { return tx.insertErr })
	}
	return tx.inputTestTx.QueryRow(ctx, sql, args...)
}

func containsInsertOrders(sql string) bool {
	const needle = "INSERT INTO orders ("
	for i := 0; i+len(needle) <= len(sql); i++ {
		if sql[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func (tx *conflictTx) Commit(ctx context.Context) error   { return tx.inputTestTx.Commit(ctx) }
func (tx *conflictTx) Rollback(ctx context.Context) error { return tx.inputTestTx.Rollback(ctx) }

func TestCreateOrderTxLeavesCommitToCaller(t *testing.T) {
	tx := &inputTestTx{allowWrites: true, stock: 5}
	res, err := (&OrderService{}).createOrderTx(context.Background(), tx, ordinaryInput())
	if err != nil || res.OrderID != "accepted-original" || res.Duplicate {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if tx.commits != 0 {
		t.Fatalf("createOrderTx committed %d times", tx.commits)
	}
	for _, q := range tx.queries {
		if containsStr(q, "INSERT INTO outlet_stock_seq") {
			t.Fatal("createOrderTx bumped the outlet stock counter; the caller owns that")
		}
	}
}

func containsStr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestCreateOrderTxKeyConflictIsSentinel(t *testing.T) {
	pg := &pgconn.PgError{Code: "23505", ConstraintName: "orders_idempotency_key_key"}
	tx := &conflictTx{inputTestTx: &inputTestTx{allowWrites: true, stock: 5}, insertErr: pg}
	_, err := (&OrderService{}).createOrderTx(context.Background(), tx, ordinaryInput())
	if !errors.Is(err, errOrderKeyConflict) || strings.Contains(err.Error(), "23505") {
		t.Fatalf("err = %v, want the bare errOrderKeyConflict", err)
	}
	if code, _ := apperr.CodeOf(err); code != apperr.Busy {
		t.Fatalf("code = %v, want busy", code)
	}
	if tx.commits != 0 {
		t.Fatal("conflict must not commit")
	}
}

// A Busy that is not the key-conflict sentinel is returned as is: replayAfterConflict (which needs
// the pool, nil here) must not run.
func TestCreateOrderCoreReplaysOnlyKeyConflict(t *testing.T) {
	busy := apperr.Wrap(apperr.Busy, write.ErrBusy)
	tx := &conflictTx{inputTestTx: &inputTestTx{allowWrites: true, stock: 5}, insertErr: busy}
	_, _, _, err := (&OrderService{}).createOrder(context.Background(), ordinaryInput(),
		func(context.Context) (pgx.Tx, error) { return tx, nil })
	if !errors.Is(err, busy) || errors.Is(err, errOrderKeyConflict) {
		t.Fatalf("err = %v, want the other busy untouched", err)
	}
}

func TestCorrectionTargetSetsTotal(t *testing.T) {
	// priced 120000 (100000 + 20% tax... use tax 20): target 100000 -> total 100000, correction -20000.
	in := ordinaryInput()
	target := int64(100000)
	in.CorrectionTarget = &target
	in.ReplacesOrderID = "00000000-0000-4000-8000-0000000000b1"
	in.BusinessDate = "2026-11-05"
	in.Offline = true
	tx := &inputTestTx{allowWrites: true, stock: 5, taxRate: 20}
	res, err := (&OrderService{}).createOrderTx(context.Background(), tx, in)
	if err != nil || res.OrderID == "" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	// orders INSERT args: total $21 -> [20], then replaces_order_id, business_date, correction_amount.
	if got := tx.orderArgs[20].(float64); got != 100000 {
		t.Fatalf("total = %v, want 100000", got)
	}
	if got := tx.orderArgs[44].(int64); got != -20000 {
		t.Fatalf("correction_amount = %v, want -20000", got)
	}
	if tx.orderArgs[42] == nil || tx.orderArgs[43] == nil {
		t.Fatalf("replaces/business_date not written: %v %v", tx.orderArgs[42], tx.orderArgs[43])
	}
}

func TestReplacementFieldsValidated(t *testing.T) {
	neg := int64(-1)
	cases := map[string]func(*CreateOrderInput){
		"replacesOrderId": func(in *CreateOrderInput) { in.ReplacesOrderID = "nope" },
		"businessDate":    func(in *CreateOrderInput) { in.BusinessDate = "05/11/2026" },
		"negativeTarget":  func(in *CreateOrderInput) { in.CorrectionTarget = &neg },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			in := ordinaryInput()
			change(&in)
			if err := ValidateSaleInput(in); !errors.Is(err, ErrSaleInput) {
				t.Fatalf("err = %v, want ErrSaleInput", err)
			}
		})
	}
	ok := ordinaryInput()
	ok.ReplacesOrderID, ok.BusinessDate = "00000000-0000-4000-8000-0000000000b1", "2026-11-05"
	if err := ValidateSaleInput(ok); err != nil {
		t.Fatalf("valid replacement fields rejected: %v", err)
	}
}
