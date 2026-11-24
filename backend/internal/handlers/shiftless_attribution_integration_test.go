package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Shift-less attribution: sales and cash movements captured while the tablet's shift_open is
// still in the outbox are linked to that shift by the open's idempotency key (opt-in fresh
// synthetic cluster, port 26485, prefix SA).
func TestShiftlessAttributionPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "SA", 26485)
	const (
		outlet  = "00000000-0000-4000-8a00-000000000001"
		user    = "00000000-0000-4000-8a00-000000000011"
		product = "00000000-0000-4000-8a00-000000000021"
		empty   = "00000000-0000-4000-8a00-000000000022"
		device  = "sadev"
	)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'SA outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id)
	      VALUES($1,'sa@example.invalid','x','SA cashier','cashier',$2)`, user, outlet)
	for id, stock := range map[string]int{product: 1000, empty: 0} {
		exec(`INSERT INTO products(id,name) VALUES($1,'SA product')`, id)
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,'110ml',100000,$2,$3)`, id, stock, "SA-"+id[len(id)-3:])
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'110ml',$3)`, outlet, id, stock)
	}
	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("SA-INTEGRATION-SYNTHETIC-KEY")
	tok, err := auth.IssueAccess(secret, time.Hour, user, "cashier", outlet, []string{"create_order"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.With(mw.RequireAuth(&config.Config{AccessSecret: secret})).Post("/sync/batch", h.SyncBatch)

	type result struct {
		Status  string `json:"status"`
		OrderID string `json:"orderId"`
		Code    string `json:"code"`
		Error   string `json:"error"`
	}
	// post is goroutine-safe: it reports errors instead of failing the test.
	post := func(item map[string]any) (result, error) {
		raw, err := json.Marshal(map[string]any{"items": []any{item}})
		if err != nil {
			return result{}, err
		}
		r := httptest.NewRequest("POST", "/sync/batch", bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out struct {
			Data struct {
				Results []result `json:"results"`
			} `json:"data"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Data.Results) != 1 {
			return result{}, fmt.Errorf("batch %d %s", w.Code, w.Body.String())
		}
		return out.Data.Results[0], nil
	}
	send := func(item map[string]any) result {
		t.Helper()
		r, err := post(item)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	envelope := func(shiftID, openKey string) map[string]any {
		e := map[string]any{"v": 1, "outletId": outlet, "userId": user, "deviceId": device,
			"capturedAt": time.Now().UTC().Format(time.RFC3339)}
		if shiftID != "" {
			e["shiftId"] = shiftID
		}
		if openKey != "" {
			e["shiftOpenKey"] = openKey
		}
		return e
	}
	seq := 0
	sale := func(name, productID, openKey string) map[string]any {
		seq++
		return map[string]any{"type": "order", "idempotencyKey": device + ":" + name,
			"envelope": envelope("", openKey),
			"payload": map[string]any{
				"orderUuid": fmt.Sprintf("00000000-0000-4000-8a02-%012d", seq), "paymentMethod": "cash", "amountPaid": 100000,
				"items": []map[string]any{{"productId": productID, "productName": "SA product", "variantSize": "110ml",
					"price": 100000, "quantity": 1, "subtotal": 100000}},
			}}
	}
	cashFlow := func(name, openKey string) map[string]any {
		return map[string]any{"type": "cash_flow", "idempotencyKey": device + ":" + name,
			"envelope": envelope("", openKey),
			"payload":  map[string]any{"type": "in", "amount": 5000, "description": "SA float"}}
	}
	open := func(name string) map[string]any {
		return map[string]any{"type": "shift_open", "idempotencyKey": device + ":" + name,
			"envelope": envelope("", ""), "payload": map[string]any{"startingCash": 10, "outletName": "SA outlet"}}
	}
	closeItem := func(name, shiftID string) map[string]any {
		return map[string]any{"type": "shift_close", "idempotencyKey": device + ":" + name,
			"envelope": envelope(shiftID, ""), "payload": map[string]any{"shiftId": shiftID, "closingCash": 15}}
	}
	// state reads shift_id and the stored key of a sale / cash flow ("" = NULL).
	orderState := func(ctx context.Context, name string) (shift, pending string) {
		t.Helper()
		var s, p *string
		if err := pool.QueryRow(ctx, `SELECT shift_id::text, pending_shift_open_key FROM orders WHERE idempotency_key=$1`,
			device+":"+name).Scan(&s, &p); err != nil {
			t.Fatalf("order %s: %v", name, err)
		}
		if s != nil {
			shift = *s
		}
		if p != nil {
			pending = *p
		}
		return
	}
	flowShift := func(name string) (shift, pending string) {
		t.Helper()
		var s, p *string
		if err := pool.QueryRow(ctx, `SELECT shift_id::text, pending_shift_open_key FROM cash_flows
			WHERE description=$1`, name).Scan(&s, &p); err != nil {
			t.Fatalf("cash flow %s: %v", name, err)
		}
		if s != nil {
			shift = *s
		}
		if p != nil {
			pending = *p
		}
		return
	}
	wantOK := func(name string, r result) {
		t.Helper()
		if r.Status != "ok" {
			t.Fatalf("%s: want ok, got %+v", name, r)
		}
	}
	closeShiftRow := func(shiftID string) {
		exec(`UPDATE shifts SET status='closed', closed_at=now() WHERE id=$1`, shiftID)
	}

	t.Run("a sale and cash movement before the open land unattached, then attach on open", func(t *testing.T) {
		const key = device + ":open-a"
		wantOK("sale", send(sale("a-order", product, key)))
		wantOK("short sale", send(sale("a-short", empty, key)))
		cf := cashFlow("a-flow", key)
		cf["payload"].(map[string]any)["description"] = "a-flow"
		wantOK("cash flow", send(cf))
		if s, p := orderState(ctx, "a-order"); s != "" || p != key {
			t.Fatalf("before the open: shift=%q pending=%q, want NULL and %q", s, p, key)
		}
		opened := send(open("open-a"))
		wantOK("shift_open", opened)
		shift := opened.OrderID
		for _, name := range []string{"a-order", "a-short"} {
			if s, _ := orderState(ctx, name); s != shift {
				t.Fatalf("order %s shift_id = %q after the open, want %q", name, s, shift)
			}
		}
		if s, _ := flowShift("a-flow"); s != shift {
			t.Fatalf("cash flow shift_id = %q after the open, want %q", s, shift)
		}
		var excShift *string
		if err := pool.QueryRow(ctx, `SELECT x.shift_id::text FROM sale_stock_exceptions x JOIN orders o ON o.id=x.order_id
			WHERE o.idempotency_key=$1`, device+":a-short").Scan(&excShift); err != nil || excShift == nil || *excShift != shift {
			t.Fatalf("stock exception shift = %v err=%v, want %s", excShift, err, shift)
		}
		wantOK("shift_close", send(closeItem("close-a", shift)))
		var orders int
		var sales float64
		if err := pool.QueryRow(ctx, `SELECT total_orders, total_sales FROM shifts WHERE id=$1`, shift).Scan(&orders, &sales); err != nil {
			t.Fatal(err)
		}
		if orders != 2 || sales != 200000 {
			t.Fatalf("close snapshot orders=%d sales=%v, want 2 and 200000", orders, sales)
		}
	})

	t.Run("a sale after the open attaches directly", func(t *testing.T) {
		const key = device + ":open-b"
		opened := send(open("open-b"))
		wantOK("shift_open", opened)
		wantOK("sale", send(sale("b-order", product, key)))
		if s, p := orderState(ctx, "b-order"); s != opened.OrderID || p != "" {
			t.Fatalf("shift=%q pending=%q, want %q and NULL", s, p, opened.OrderID)
		}
		closeShiftRow(opened.OrderID)
	})

	t.Run("replay of a keyed sale is one row", func(t *testing.T) {
		const key = device + ":open-c"
		it := sale("c-order", product, key)
		wantOK("first", send(it))
		if r := send(it); r.Status != "duplicate" {
			t.Fatalf("replay: %+v, want duplicate", r)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM orders WHERE idempotency_key=$1`, device+":c-order").Scan(&n); err != nil || n != 1 {
			t.Fatalf("rows=%d err=%v", n, err)
		}
		opened := send(open("open-c"))
		wantOK("shift_open", opened)
		if s, _ := orderState(ctx, "c-order"); s != opened.OrderID {
			t.Fatalf("shift=%q after open, want %q", s, opened.OrderID)
		}
		closeShiftRow(opened.OrderID)
	})

	t.Run("a sale without a key (old bundle) stays unattached", func(t *testing.T) {
		wantOK("sale", send(sale("d-order", product, "")))
		opened := send(open("open-d"))
		wantOK("shift_open", opened)
		if s, p := orderState(ctx, "d-order"); s != "" || p != "" {
			t.Fatalf("shift=%q pending=%q, want both NULL", s, p)
		}
		closeShiftRow(opened.OrderID)
	})

	t.Run("a key of another device prefix is ignored", func(t *testing.T) {
		wantOK("sale", send(sale("e-order", product, "otherdev:open-e")))
		opened := send(open("open-e"))
		wantOK("shift_open", opened)
		if s, p := orderState(ctx, "e-order"); s != "" || p != "" {
			t.Fatalf("shift=%q pending=%q, want both NULL", s, p)
		}
		closeShiftRow(opened.OrderID)
	})

	t.Run("concurrent sale and open on the same key attach either way", func(t *testing.T) {
		for i := 0; i < 12; i++ {
			key := fmt.Sprintf("%s:open-g%d", device, i)
			order := sale(fmt.Sprintf("g-order-%d", i), product, key)
			var wg sync.WaitGroup
			var openRes, orderRes result
			var openErr, orderErr error
			wg.Add(2)
			go func() { defer wg.Done(); orderRes, orderErr = post(order) }()
			go func() { defer wg.Done(); openRes, openErr = post(open(fmt.Sprintf("open-g%d", i))) }()
			wg.Wait()
			if orderErr != nil || openErr != nil || orderRes.Status != "ok" || openRes.Status != "ok" {
				t.Fatalf("round %d: order=%+v/%v open=%+v/%v", i, orderRes, orderErr, openRes, openErr)
			}
			if s, _ := orderState(ctx, fmt.Sprintf("g-order-%d", i)); s != openRes.OrderID {
				t.Fatalf("round %d: order shift=%q, want %q", i, s, openRes.OrderID)
			}
			closeShiftRow(openRes.OrderID)
		}
	})
}
