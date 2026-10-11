package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// A04 capture-time envelope. Opt-in only, same isolation contract as the other
// PostgreSQL gates: a freshly-created loopback cluster, verified data directory,
// empty database. Every case speaks raw JSON over HTTP so the gate compiles (and
// fails behaviourally) against code that predates the envelope.
func TestCaptureEnvelopePostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_EV_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56448 || cfg.ConnConfig.Database != "mandalika_ev_synthetic" || cfg.ConnConfig.User != "ev_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_EV_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("test cluster directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	// Subtests share these helpers; failures must target the running subtest.
	cur := t
	sub := func(name string, fn func(t *testing.T)) {
		t.Run(name, func(st *testing.T) {
			prev := cur
			cur = st
			defer func() { cur = prev }()
			fn(st)
		})
	}
	exec := func(sql string, args ...any) {
		cur.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			cur.Fatal(err)
		}
	}
	count := func(sql string, args ...any) (n int) {
		cur.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			cur.Fatal(err)
		}
		return
	}
	const (
		outX     = "00000000-0000-4000-8e00-000000000001"
		outY     = "00000000-0000-4000-8e00-000000000002"
		outW     = "00000000-0000-4000-8e00-000000000003"
		outV     = "00000000-0000-4000-8e00-000000000004"
		userX    = "00000000-0000-4000-8e00-000000000011"
		userY    = "00000000-0000-4000-8e00-000000000012"
		adminU   = "00000000-0000-4000-8e00-000000000013"
		product  = "00000000-0000-4000-8e00-000000000021"
		device   = "evdev"
		ghostUID = "00000000-0000-4000-8e00-0000000000ff"
	)
	const pin = "4321"
	pinHash, err := auth.HashPassword(pin)
	if err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'EV outlet X'),($2,'EV outlet Y'),($3,'EV outlet W'),($4,'EV outlet V')`, outX, outY, outW, outV)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
		($1,'x@example.invalid','x','EV cashier X','cashier',$3),
		($2,'y@example.invalid','x','EV cashier Y','cashier',$4)`, userX, userY, outX, outY)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,receive_pin_hash) VALUES($1,'adm@example.invalid','x','EV admin','admin',$2)`, adminU, pinHash)
	exec(`INSERT INTO products(id,name) VALUES($1,'EV product')`, product)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,1000,'EV')`, product)
	for _, o := range []string{outX, outY} {
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',1000)`, o, product)
	}
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("EV-INTEGRATION-SYNTHETIC-KEY")
	issue := func(user, role, outlet string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, []string{"create_order", "process_refund"})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokX, tokAdmin := issue(userX, "cashier", outX), issue(adminU, "admin", "")
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap).Get("/sync/version", h.SyncVersion)

	type result struct {
		Key       string `json:"idempotencyKey"`
		Status    string `json:"status"`
		OrderID   string `json:"orderId"`
		Code      string `json:"code"`
		Retryable *bool  `json:"retryable"`
		Error     string `json:"error"`
	}
	// flush posts one batch item; header = X-Outlet-Id ("" = none).
	flush := func(token, header string, item map[string]any) result {
		cur.Helper()
		raw, err := json.Marshal(map[string]any{"items": []any{item}})
		if err != nil {
			cur.Fatal(err)
		}
		r := httptest.NewRequest("POST", "/sync/batch", bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		if header != "" {
			r.Header.Set("X-Outlet-Id", header)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out struct {
			Data struct {
				Results []result `json:"results"`
			} `json:"data"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Data.Results) != 1 {
			cur.Fatalf("batch %d %s", w.Code, w.Body.String())
		}
		return out.Data.Results[0]
	}
	envelope := func(outlet, user, dev, shift string) map[string]any {
		e := map[string]any{"v": 1, "outletId": outlet, "userId": user, "deviceId": dev, "capturedAt": time.Now().UTC().Format(time.RFC3339)}
		if shift != "" {
			e["shiftId"] = shift
		}
		return e
	}
	seq := 0
	orderPayload := func(extra map[string]any) map[string]any {
		seq++
		p := map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8e02-%012d", seq), "paymentMethod": "cash", "amountPaid": 100000,
			"items": []map[string]any{{"productId": product, "productName": "EV product", "variantSize": "110ml", "price": 100000, "quantity": 1, "subtotal": 100000}},
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}
	item := func(typ, name string, payload map[string]any, env map[string]any) map[string]any {
		it := map[string]any{"type": typ, "idempotencyKey": device + ":" + name, "payload": payload}
		if env != nil {
			it["envelope"] = env
		}
		return it
	}
	stock := func(outlet string) int {
		return count(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='110ml'`, outlet, product)
	}
	orderOutlet := func(name string) string {
		cur.Helper()
		var o string
		if err := pool.QueryRow(ctx, `SELECT outlet_id::text FROM orders WHERE idempotency_key=$1`, device+":"+name).Scan(&o); err != nil {
			cur.Fatalf("order %s: %v", name, err)
		}
		return o
	}
	// snapshot of everything a refused item must not touch.
	type effects struct{ orders, receipts, keys, shifts, flows, stockX, stockY int }
	snap := func() effects {
		return effects{
			count(`SELECT count(*) FROM orders`), count(`SELECT count(*) FROM operation_receipts`),
			count(`SELECT count(*) FROM processed_keys`), count(`SELECT count(*) FROM shifts`),
			count(`SELECT count(*) FROM cash_flows`), stock(outX), stock(outY),
		}
	}
	wantMismatch := func(name string, r result, before effects) {
		cur.Helper()
		if r.Status != "error" || r.Code != "actor_mismatch" || r.Retryable == nil || *r.Retryable {
			cur.Fatalf("%s: want non-retryable actor_mismatch, got %+v", name, r)
		}
		if after := snap(); after != before {
			cur.Fatalf("%s: a refused item had effects: before=%+v after=%+v", name, before, after)
		}
	}
	wantOK := func(name string, r result) {
		cur.Helper()
		if r.Status != "ok" {
			cur.Fatalf("%s: want ok, got %+v", name, r)
		}
	}

	sub("0 /sync/version without an outlet is 403, not 500", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/sync/version", nil)
		r.Header.Set("Authorization", "Bearer "+tokAdmin)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("status=%d %s", w.Code, w.Body.String())
		}
	})
	sub("1 A04 scenario: captured at X, flushed with header Y, lands at X", func(t *testing.T) {
		beforeX, beforeY := stock(outX), stock(outY)
		wantOK("order", flush(tokAdmin, outY, item("order", "a04", orderPayload(nil), envelope(outX, adminU, device, ""))))
		if got := orderOutlet("a04"); got != outX {
			t.Fatalf("order landed at %s, want captured outlet %s", got, outX)
		}
		if stock(outX) != beforeX-1 || stock(outY) != beforeY {
			t.Fatalf("stock X %d->%d, Y %d->%d", beforeX, stock(outX), beforeY, stock(outY))
		}
	})
	sub("2 cross-user envelope is actor_mismatch with zero effects", func(t *testing.T) {
		before := snap()
		r := flush(tokX, "", item("order", "cross", orderPayload(nil), envelope(outX, userY, device, "")))
		wantMismatch("order as other user", r, before)
		wantMismatch("shift_open as other user", flush(tokX, "", item("shift_open", "cross-open", map[string]any{"startingCash": 1}, envelope(outX, userY, device, ""))), before)
	})
	sub("3 reassigned cashier: stored outlet is the authority, not the token", func(t *testing.T) {
		exec(`UPDATE users SET outlet_id=$1 WHERE id=$2`, outY, userX)
		defer exec(`UPDATE users SET outlet_id=$1 WHERE id=$2`, outX, userX)
		before := snap()
		wantMismatch("captured at the old outlet", flush(tokX, "", item("order", "reassigned-old", orderPayload(nil), envelope(outX, userX, device, ""))), before)
		wantOK("captured at the new outlet", flush(tokX, "", item("order", "reassigned-new", orderPayload(nil), envelope(outY, userX, device, ""))))
		if got := orderOutlet("reassigned-new"); got != outY {
			t.Fatalf("order landed at %s, want %s", got, outY)
		}
	})
	sub("4 unknown or malformed outlet is actor_mismatch", func(t *testing.T) {
		before := snap()
		wantMismatch("unknown uuid", flush(tokAdmin, outX, item("order", "unk", orderPayload(nil), envelope(ghostUID, adminU, device, ""))), before)
		const outOff = "00000000-0000-4000-8e00-0000000000d1"
		exec(`INSERT INTO outlets(id,name,is_active) VALUES($1,'EV inactive',false)`, outOff)
		wantMismatch("inactive outlet", flush(tokAdmin, outX, item("order", "inactive", orderPayload(nil), envelope(outOff, adminU, device, ""))), before)
		wantMismatch("not a uuid", flush(tokAdmin, outX, item("order", "unk2", orderPayload(nil), envelope("not-a-uuid", adminU, device, ""))), before)
		wantMismatch("cashier at a foreign outlet", flush(tokX, "", item("order", "foreign", orderPayload(nil), envelope(outY, userX, device, ""))), before)
	})
	sub("5 device prefix, version and shape", func(t *testing.T) {
		before := snap()
		wantMismatch("foreign device prefix", flush(tokX, "", item("order", "dev", orderPayload(nil), envelope(outX, userX, "otherdev", ""))), before)
		bad := envelope(outX, userX, device, "")
		bad["v"] = 2
		wantMismatch("v=2", flush(tokX, "", item("order", "v2", orderPayload(nil), bad)), before)
		it := item("order", "shape", orderPayload(nil), nil)
		it["envelope"] = "not-an-object"
		wantMismatch("non-object envelope", flush(tokX, "", it), before)
	})
	sub("6 shift rules", func(t *testing.T) {
		const shiftY, shiftXClosed = "00000000-0000-4000-8e00-0000000000a1", "00000000-0000-4000-8e00-0000000000a2"
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'EV cashier Y','open',now(),0)`, shiftY, outY, userY)
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,closed_at,starting_cash) VALUES($1,$2,$3,'EV cashier X','closed',now(),now(),0)`, shiftXClosed, outX, userX)
		before := snap()
		wantMismatch("envelope shift of another outlet", flush(tokX, "", item("order", "shift-other-env", orderPayload(nil), envelope(outX, userX, device, shiftY))), before)
		wantMismatch("payload shift of another outlet", flush(tokX, "", item("order", "shift-other-pay", orderPayload(map[string]any{"shiftId": shiftY}), envelope(outX, userX, device, ""))), before)
		// A late sale for a closed shift is accepted and keeps that shift.
		wantOK("closed shift", flush(tokX, "", item("order", "shift-closed", orderPayload(map[string]any{"shiftId": shiftXClosed}), envelope(outX, userX, device, shiftXClosed))))
		var got *string
		if err := pool.QueryRow(ctx, `SELECT shift_id::text FROM orders WHERE idempotency_key=$1`, device+":shift-closed").Scan(&got); err != nil || got == nil || *got != shiftXClosed {
			t.Fatalf("late sale shift_id=%v err=%v", got, err)
		}
		// An unknown shift is accepted and stored without one (a dangling FK would
		// be classified retryable and never succeed).
		ghost := "00000000-0000-4000-8e00-0000000000a9"
		wantOK("unknown shift", flush(tokX, "", item("order", "shift-ghost", orderPayload(map[string]any{"shiftId": ghost}), envelope(outX, userX, device, ghost))))
		if err := pool.QueryRow(ctx, `SELECT shift_id::text FROM orders WHERE idempotency_key=$1`, device+":shift-ghost").Scan(&got); err != nil || got != nil {
			t.Fatalf("unknown shift stored as %v err=%v", got, err)
		}
	})
	sub("7 every operation type is attributed to the envelope outlet", func(t *testing.T) {
		// Admin flushes with header Y; everything was captured at X.
		wantOK("order", flush(tokAdmin, outY, item("order", "op-order", orderPayload(nil), envelope(outX, adminU, device, ""))))
		orderID := orderOutlet("op-order")
		if orderID != outX {
			t.Fatalf("order at %s", orderID)
		}
		var id string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM orders WHERE idempotency_key=$1`, device+":op-order").Scan(&id); err != nil {
			t.Fatal(err)
		}
		wantOK("refund", flush(tokAdmin, outY, item("refund", "op-refund", map[string]any{"orderId": id, "reason": "ev"}, envelope(outX, adminU, device, ""))))
		r := flush(tokAdmin, outY, item("shift_open", "op-open", map[string]any{"startingCash": 5, "outletName": "EV outlet X"}, envelope(outX, adminU, device, "")))
		wantOK("shift_open", r)
		shift := r.OrderID
		if got := count(`SELECT count(*) FROM shifts WHERE id=$1 AND outlet_id=$2`, shift, outX); got != 1 {
			t.Fatal("shift_open did not land at the captured outlet")
		}
		wantOK("cash_flow", flush(tokAdmin, outY, item("cash_flow", "op-flow", map[string]any{"shiftId": shift, "type": "in", "amount": 10, "description": "ev"}, envelope(outX, adminU, device, shift))))
		if got := count(`SELECT count(*) FROM cash_flows WHERE shift_id=$1 AND outlet_id=$2`, shift, outX); got != 1 {
			t.Fatal("cash_flow did not land at the captured outlet")
		}
		wantOK("shift_close", flush(tokAdmin, outY, item("shift_close", "op-close", map[string]any{"shiftId": shift, "closingCash": 5}, envelope(outX, adminU, device, shift))))
		if got := count(`SELECT count(*) FROM shifts WHERE id=$1 AND status='closed'`, shift); got != 1 {
			t.Fatal("shift_close did not close the captured outlet's shift")
		}
		wantOK("customer_create", flush(tokAdmin, outY, item("customer_create", "op-cust", map[string]any{"customerId": "00000000-0000-4000-8e00-0000000000c1", "name": "EV customer", "phone": "ev-0"}, envelope(outX, adminU, device, ""))))
		// transfer_receive: scope is the destination outlet = the captured outlet X.
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',100) ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock=100`, outY, product)
		tid, err := wr.CreateTransfer(ctx, "", write.TransferCreate{
			Source: write.TransferLoc{Kind: "outlet", ID: outY}, Dest: write.TransferLoc{Kind: "outlet", ID: outX},
			Items: []write.TransferItemInput{{ProductID: product, VariantSize: "M", Qty: 2}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := wr.SendTransfer(ctx, tid); err != nil {
			t.Fatal(err)
		}
		recv := map[string]any{"transferId": tid, "items": []any{}, "approverUserId": adminU, "pin": pin}
		wantOK("transfer_receive", flush(tokAdmin, outY, item("transfer_receive", "op-recv", recv, envelope(outX, adminU, device, ""))))
	})
	sub("8 legacy items without an envelope: accepted before the cutoff, refused after", func(t *testing.T) {
		defer func() { h.Sync.LegacyEnvelopeUntil, h.Sync.Now = time.Time{}, nil }()
		now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
		h.Sync.Now = func() time.Time { return now }
		h.Sync.LegacyEnvelopeUntil = now.Add(time.Hour)
		wantOK("before cutoff", flush(tokX, "", item("order", "legacy-before", orderPayload(nil), nil)))
		if got := orderOutlet("legacy-before"); got != outX {
			t.Fatalf("legacy order at %s, want header/token outlet %s", got, outX)
		}
		h.Sync.LegacyEnvelopeUntil = now.Add(-time.Hour)
		before := snap()
		wantMismatch("after cutoff", flush(tokX, "", item("order", "legacy-after", orderPayload(nil), nil)), before)
		// An enveloped item is unaffected by the cutoff.
		wantOK("enveloped after cutoff", flush(tokX, "", item("order", "legacy-env", orderPayload(nil), envelope(outX, userX, device, ""))))
		// Unset cutoff = accept (the deploy-before-fleet default).
		h.Sync.LegacyEnvelopeUntil = time.Time{}
		wantOK("unset cutoff", flush(tokX, "", item("order", "legacy-unset", orderPayload(nil), nil)))
	})
	sub("9 a keyed retry from another header outlet replays instead of key_conflict", func(t *testing.T) {
		it := item("shift_open", "replay-open", map[string]any{"startingCash": 7, "outletName": "EV outlet V"}, envelope(outV, adminU, device, ""))
		first := flush(tokAdmin, outX, it)
		wantOK("first", first)
		again := flush(tokAdmin, outW, it)
		wantOK("replay under another header", again)
		if again.OrderID != first.OrderID {
			t.Fatalf("replay returned %s, want %s", again.OrderID, first.OrderID)
		}
		if n := count(`SELECT count(*) FROM shifts WHERE outlet_id=$1 AND status='open'`, outV); n != 1 {
			t.Fatalf("%d open shifts at V", n)
		}
	})
	sub("10 concurrent shift_open at one outlet yields exactly one open shift", func(t *testing.T) {
		open := func(tx pgx.Tx) error {
			_, err := svc.OpenShiftTx(ctx, tx, service.OpenShiftInput{OutletID: outW, OutletName: "EV outlet W", CashierID: userX, CashierName: "EV cashier X"})
			return err
		}
		tx1, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx1.Rollback(ctx)
		if err := open(tx1); err != nil {
			t.Fatal(err)
		}
		tx2, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx2.Rollback(ctx)
		done := make(chan error, 1)
		go func() {
			err := open(tx2)
			if err == nil {
				err = tx2.Commit(ctx)
			}
			done <- err
		}()
		// Unlocked code finishes tx2 immediately; locked code leaves tx2 waiting on tx1.
		var err2 error
		finished := false
		for i := 0; i < 100 && !finished; i++ {
			select {
			case err2 = <-done:
				finished = true
			case <-time.After(50 * time.Millisecond):
				if count(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`) > 0 {
					i = 100
				}
			}
		}
		if err := tx1.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if !finished {
			select {
			case err2 = <-done:
			case <-time.After(10 * time.Second):
				t.Fatal("second open never finished after the first committed")
			}
		}
		if !errors.Is(err2, service.ErrShiftOpen) {
			t.Fatalf("second concurrent open = %v, want ErrShiftOpen", err2)
		}
		if n := count(`SELECT count(*) FROM shifts WHERE outlet_id=$1 AND status='open'`, outW); n != 1 {
			t.Fatalf("%d open shifts at W, want 1", n)
		}
	})
	sub("11 non-admin cashier: shift_open, refund and transfer_receive with an envelope", func(t *testing.T) {
		r := flush(tokX, "", item("shift_open", "na-open", map[string]any{"startingCash": 3, "outletName": "EV outlet X"}, envelope(outX, userX, device, "")))
		wantOK("non-admin shift_open", r)
		if got := count(`SELECT count(*) FROM shifts WHERE id=$1 AND outlet_id=$2`, r.OrderID, outX); got != 1 {
			t.Fatal("non-admin shift_open did not land at the stored outlet")
		}
		var orderID string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM orders WHERE idempotency_key=$1`, device+":a04").Scan(&orderID); err != nil {
			t.Fatal(err)
		}
		wantOK("non-admin refund", flush(tokX, "", item("refund", "na-refund", map[string]any{"orderId": orderID, "reason": "ev"}, envelope(outX, userX, device, ""))))
		before := snap()
		wantMismatch("non-admin refund captured at another outlet", flush(tokX, "", item("refund", "na-refund-y", map[string]any{"orderId": orderID, "reason": "ev"}, envelope(outY, userX, device, ""))), before)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',100) ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock=100`, outY, product)
		tid, err := wr.CreateTransfer(ctx, "", write.TransferCreate{
			Source: write.TransferLoc{Kind: "outlet", ID: outY}, Dest: write.TransferLoc{Kind: "outlet", ID: outX},
			Items: []write.TransferItemInput{{ProductID: product, VariantSize: "M", Qty: 1}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := wr.SendTransfer(ctx, tid); err != nil {
			t.Fatal(err)
		}
		recv := map[string]any{"transferId": tid, "items": []any{}, "approverUserId": adminU, "pin": pin}
		wantOK("non-admin transfer_receive", flush(tokX, "", item("transfer_receive", "na-recv", recv, envelope(outX, userX, device, ""))))
	})
	sub("12 replay under a different envelope outlet is key_conflict, not a second effect", func(t *testing.T) {
		p := map[string]any{"customerId": "00000000-0000-4000-8e00-0000000000c2", "name": "EV replay", "phone": "ev-1"}
		wantOK("first", flush(tokAdmin, outX, item("customer_create", "replay-env", p, envelope(outV, adminU, device, ""))))
		before := snap()
		r := flush(tokAdmin, outX, item("customer_create", "replay-env", p, envelope(outW, adminU, device, "")))
		if r.Status != "error" || r.Code != "key_conflict" {
			t.Fatalf("replay under another outlet: %+v", r)
		}
		if after := snap(); after != before || count(`SELECT count(*) FROM customers WHERE name='EV replay'`) != 1 {
			t.Fatalf("replay had effects: %+v -> %+v", before, after)
		}
	})
	sub("13 an already-applied item retried after reassignment replays as duplicate (no review, no double effect)", func(t *testing.T) {
		it := item("order", "applied-before", orderPayload(nil), envelope(outX, userX, device, ""))
		first := flush(tokX, "", it)
		wantOK("first", first)
		exec(`UPDATE users SET outlet_id=$1 WHERE id=$2`, outY, userX)
		defer exec(`UPDATE users SET outlet_id=$1 WHERE id=$2`, outX, userX)
		before := snap()
		again := flush(tokX, "", it)
		if again.Status != "duplicate" || again.OrderID != first.OrderID || again.Code != "" {
			t.Fatalf("retry after reassignment: %+v (first %+v)", again, first)
		}
		if after := snap(); after != before {
			t.Fatalf("retry had effects: %+v -> %+v", before, after)
		}
		// A NEW item from the reassigned cashier for the old outlet is still refused.
		wantMismatch("new item at the old outlet", flush(tokX, "", item("order", "new-after-reassign", orderPayload(nil), envelope(outX, userX, device, ""))), before)
		// A keyed op replays too (receipt scope = the captured outlet), and never doubles.
		exec(`UPDATE users SET outlet_id=$1 WHERE id=$2`, outX, userX)
		cust := item("customer_create", "applied-cust", map[string]any{"customerId": "00000000-0000-4000-8e00-0000000000c3", "name": "EV applied", "phone": "ev-2"}, envelope(outX, userX, device, ""))
		firstCust := flush(tokX, "", cust)
		wantOK("customer first", firstCust)
		exec(`UPDATE users SET outlet_id=$1 WHERE id=$2`, outY, userX)
		replay := flush(tokX, "", cust)
		wantOK("customer replay after reassignment", replay)
		if replay.OrderID != firstCust.OrderID || count(`SELECT count(*) FROM customers WHERE name='EV applied'`) != 1 {
			t.Fatalf("customer replay %+v vs %+v", replay, firstCust)
		}
	})
}
