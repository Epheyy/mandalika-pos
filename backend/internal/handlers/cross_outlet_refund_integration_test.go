package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/coverage"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// xoWorld is one pair of outlets: X (where the sale is made) and Y (where it is returned), each
// with a kasir, an open shift and the same two products in stock.
type xoWorld struct {
	x, y           xoOutlet
	pA, pB         string // price 10000 / 20000
	shiftX, shiftY string
}

type xoOutlet struct{ id, user, tok string }

// TestCrossOutletRefundPostgres is gate XO (isolated cluster, MANDALIKA_XO_TEST_DSN, port 26486):
// A18 online-only returns of another outlet's sale. Sales go through the real /sync/batch, the
// return through POST /orders/{id}/cross-outlet-refund; every effect is asserted on the rows AND
// on the HTTP readers (docs/plans/2026-11-26-a18-cross-outlet-returns-plan.md, 6.1).
func TestCrossOutletRefundPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "XO", 26486)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
	}
	num := func(sql string, args ...any) (n int64) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
		return
	}
	str := func(sql string, args ...any) (s string) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
		return
	}

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	secret := []byte("XO-INTEGRATION-SYNTHETIC-KEY-0123456789")
	eng := syncpkg.New(pool, rd, svc, wr)
	eng.ContactKey = syncpkg.DeriveContactKey(secret)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, eng, nil)
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap).Post("/sync/batch", h.SyncBatch)
	router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/cross-outlet-refund", h.RefundCrossOutlet)
	router.With(authWrap, mw.RequirePermission("process_refund")).Get("/cross-outlet-returns/lookup", h.CrossOutletLookup)
	router.With(authWrap).Get("/orders/{id}", h.Order)
	router.With(authWrap).Get("/shifts/current", h.CurrentShift)
	router.With(authWrap).Get("/reports/summary", h.ReportSummary)
	router.With(authWrap).Get("/reports/dashboard", h.DashboardAggregate)
	router.With(authWrap).Get("/refund-report", h.RefundReport)

	var idN int
	nextID := func(group string) string {
		idN++
		return fmt.Sprintf("00000000-0000-4000-8f86-%s%08d", group, idN)
	}
	issue := func(user, role, outlet string, perms ...string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	adminAll := issue(nextID("0c00"), "admin", "")
	const device = "00000000-0000-4000-8f86-0000000000d1"

	call := func(method, path, token string, hdr map[string]string, body any) (int, []byte, map[string][]string) {
		t.Helper()
		var rdr *bytes.Reader
		if body != nil {
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			rdr = bytes.NewReader(raw)
		} else {
			rdr = bytes.NewReader(nil)
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.Bytes(), w.Header()
	}

	outletN := 0
	newOutlet := func(perms ...string) xoOutlet {
		t.Helper()
		outletN++
		o := xoOutlet{id: nextID("0a00"), user: nextID("0b00")}
		exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,$2,$3,$4)`, o.id, fmt.Sprintf("XO outlet %d", outletN), fmt.Sprintf("xo-%d", outletN), fmt.Sprintf("XO%d", outletN))
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x','XO cashier','cashier',$3)`, o.user, fmt.Sprintf("xo%d@example.invalid", outletN), o.id)
		o.tok = issue(o.user, "cashier", o.id, perms...)
		return o
	}
	prodN := 0
	newProduct := func(price float64, outlets ...xoOutlet) string {
		t.Helper()
		prodN++
		pid := nextID("0d00")
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, fmt.Sprintf("XO product %d", prodN))
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,erp_slug) VALUES($1,'std',$2,0,$3,$4)`,
			pid, price, fmt.Sprintf("XOSKU%d", prodN), fmt.Sprintf("xo-fg-%d", prodN))
		for _, o := range outlets {
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'std',1000)`, o.id, pid)
		}
		return pid
	}
	newShift := func(o xoOutlet) string {
		t.Helper()
		id := nextID("1100")
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'XO shift','open',now(),0)`, id, o.id, o.user)
		return id
	}
	const kasirPerms = "process_refund"
	newWorld := func() xoWorld {
		t.Helper()
		w := xoWorld{x: newOutlet("create_order", kasirPerms), y: newOutlet("create_order", kasirPerms)}
		w.pA = newProduct(10000, w.x, w.y)
		w.pB = newProduct(20000, w.x, w.y)
		w.shiftX, w.shiftY = newShift(w.x), newShift(w.y)
		return w
	}
	stock := func(o xoOutlet, pid string) int64 {
		return num(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='std'`, o.id, pid)
	}
	seq := func(o xoOutlet) int64 { return num(`SELECT seq FROM outlet_stock_seq WHERE outlet_id=$1`, o.id) }

	batchN := 0
	send := func(o xoOutlet, typ string, payload map[string]any, shift string) map[string]any {
		t.Helper()
		batchN++
		env := map[string]any{"v": 1, "outletId": o.id, "userId": o.user, "deviceId": device,
			"capturedAt": time.Now().UTC().Format(time.RFC3339Nano), "offlineMs": time.Hour.Milliseconds()}
		if shift != "" {
			env["shiftId"] = shift
		}
		item := map[string]any{"type": typ, "idempotencyKey": fmt.Sprintf("%s:xo%d", device, batchN), "payload": payload, "envelope": env}
		code, raw, _ := call("POST", "/sync/batch", o.tok, nil, map[string]any{"items": []any{item}})
		var out struct {
			Data struct {
				Results []map[string]any `json:"results"`
			} `json:"data"`
		}
		if code != 200 || json.Unmarshal(raw, &out) != nil || len(out.Data.Results) != 1 {
			t.Fatalf("batch %d %s", code, raw)
		}
		return out.Data.Results[0]
	}
	line := func(pid string, qty int, price float64) map[string]any {
		return map[string]any{"productId": pid, "productName": "XO product", "variantSize": "std",
			"price": price, "quantity": qty, "subtotal": price * float64(qty)}
	}
	sell := func(o xoOutlet, shift, customer, method string, tenders []map[string]any, items ...map[string]any) string {
		t.Helper()
		var total float64
		for _, it := range items {
			total += it["subtotal"].(float64)
		}
		p := map[string]any{"orderUuid": nextID("0e00"), "deviceId": device, "paymentMethod": method,
			"amountPaid": total, "items": items, "shiftId": shift}
		if customer != "" {
			p["customerId"] = customer
		}
		if tenders != nil {
			p["tenders"] = tenders
		}
		res := send(o, "order", p, "")
		id, _ := res["orderId"].(string)
		if res["status"] != "ok" || id == "" {
			t.Fatalf("sale: %v", res)
		}
		return id
	}

	// cross sends the new endpoint; body fields default to a valid per-line refund of line 0 qty 1.
	type xr struct {
		code int
		raw  []byte
		hdr  map[string][]string
		data struct {
			RefundID     string  `json:"refundId"`
			RefundState  string  `json:"refundState"`
			Amount       float64 `json:"amount"`
			Replayed     bool    `json:"replayed"`
			SaleOutletID string  `json:"saleOutletId"`
			Refund       struct {
				ID       string `json:"id"`
				OutletID string `json:"outletId"`
				ShiftID  string `json:"shiftId"`
			} `json:"refund"`
			Order struct {
				OutletName string         `json:"outletName"`
				Order      map[string]any `json:"order"`
			} `json:"order"`
		}
	}
	cross := func(tok string, hdr map[string]string, order string, body map[string]any) xr {
		t.Helper()
		var r xr
		r.code, r.raw, r.hdr = call("POST", "/orders/"+order+"/cross-outlet-refund", tok, hdr, body)
		var env struct {
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(r.raw, &env) == nil && len(env.Data) > 0 {
			_ = json.Unmarshal(env.Data, &r.data)
		}
		return r
	}
	xoBody := func(shift, uuid string, items ...map[string]any) map[string]any {
		b := map[string]any{"clientRefundUuid": uuid, "deviceId": device, "shiftId": shift, "reason": "salah ukuran"}
		if items != nil {
			b["items"] = items
		}
		return b
	}
	item := func(lineNo, qty int) map[string]any { return map[string]any{"lineNo": lineNo, "quantity": qty} }
	wantCode := func(name string, got xr, want int) {
		t.Helper()
		if got.code != want {
			t.Fatalf("%s: HTTP %d, want %d: %s", name, got.code, want, got.raw)
		}
	}
	refundRows := func(order string) int64 { return num(`SELECT count(*) FROM order_refunds WHERE order_id=$1`, order) }
	totals := func() [4]int64 {
		return [4]int64{num(`SELECT count(*) FROM order_refunds`), num(`SELECT count(*) FROM stock_movements WHERE kind='refund'`),
			num(`SELECT count(*) FROM erp_outbox WHERE kind='refund'`), num(`SELECT COALESCE(sum(stock),0) FROM outlet_variant_stock`)}
	}
	getOrder := func(tok, id string) map[string]any {
		t.Helper()
		code, raw, _ := call("GET", "/orders/"+id, tok, nil, nil)
		var out struct{ Data map[string]any }
		if code != 200 || json.Unmarshal(raw, &out) != nil {
			t.Fatalf("get order %d %s", code, raw)
		}
		return out.Data
	}

	w := newWorld()
	phoneCust := nextID("1200")
	exec(`INSERT INTO customers(id,name,phone) VALUES($1,'XO customer','081234567890')`, phoneCust)
	cashSale := sell(w.x, w.shiftX, phoneCust, "cash", nil, line(w.pA, 2, 10000), line(w.pB, 1, 20000)) // 40000
	exec(`UPDATE app_settings SET split_tender_enabled=true WHERE id=1`)
	splitSale := sell(w.x, w.shiftX, "", "split", []map[string]any{
		{"method": "qris", "amount": 20000, "reference": "R1"}, {"method": "cash", "amount": 10000}}, line(w.pA, 3, 10000)) // 30000
	ownSale := sell(w.y, w.shiftY, "", "cash", nil, line(w.pA, 1, 10000))
	yTok := w.y.tok

	t.Run("1 pre-check: no refund paid at another outlet yet", func(t *testing.T) {
		if n := num(`SELECT count(*) FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE r.outlet_id<>o.outlet_id`); n != 0 {
			t.Fatalf("%d cross rows before the first cross refund", n)
		}
	})

	t.Run("2 lookup by order number and exact phone", func(t *testing.T) {
		type row struct {
			OutletName string         `json:"outletName"`
			Order      map[string]any `json:"order"`
		}
		look := func(tok, q string, hdr map[string]string) (int, []row) {
			t.Helper()
			code, raw, _ := call("GET", "/cross-outlet-returns/lookup?"+q, tok, hdr, nil)
			var out struct{ Data []row }
			_ = json.Unmarshal(raw, &out)
			return code, out.Data
		}
		num0 := str(`SELECT order_number FROM orders WHERE id=$1`, cashSale)
		code, rows := look(yTok, "orderNumber="+num0, nil)
		if code != 200 || len(rows) != 1 || rows[0].OutletName != "XO outlet 1" || rows[0].Order["id"] != cashSale {
			t.Fatalf("by number: %d %+v", code, rows)
		}
		for _, k := range []string{"customerName", "customerId", "deviceId"} {
			if _, ok := rows[0].Order[k]; ok {
				t.Fatalf("lookup leaked %s", k)
			}
		}
		code, rows = look(yTok, "phone=0812-3456-7890", nil)
		if code != 200 || len(rows) != 1 || rows[0].Order["id"] != cashSale {
			t.Fatalf("by phone: %d %+v", code, rows)
		}
		if code, rows = look(yTok, "phone=08123456", nil); code != 200 || len(rows) != 0 {
			t.Fatalf("partial phone must match nothing: %d %+v", code, rows)
		}
		if code, rows = look(yTok, "orderNumber="+str(`SELECT order_number FROM orders WHERE id=$1`, ownSale), nil); code != 200 || len(rows) != 0 {
			t.Fatalf("own outlet sale must be excluded: %d %+v", code, rows)
		}
		if code, _ = look(yTok, "", nil); code != 400 {
			t.Fatalf("no param: %d", code)
		}
		noPerm := newOutlet("create_order")
		if code, _ = look(noPerm.tok, "orderNumber="+num0, nil); code != 403 {
			t.Fatalf("no process_refund: %d", code)
		}
		if code, _ = look(adminAll, "orderNumber="+num0, nil); code != 403 {
			t.Fatalf("admin without an active outlet: %d", code)
		}
	})

	var firstRefund, firstUUID string
	t.Run("3 success: Y stock, Y shift, Y outbox, X untouched", func(t *testing.T) {
		xStockA, yStockA, xSeq, ySeq := stock(w.x, w.pA), stock(w.y, w.pA), seq(w.x), seq(w.y)
		firstUUID = nextID("1300")
		r := cross(yTok, nil, cashSale, xoBody(w.shiftY, firstUUID, item(0, 1)))
		wantCode("success", r, 201)
		firstRefund = r.data.RefundID
		if r.data.Replayed || r.data.RefundState != "partial" || r.data.Amount != 10000 || r.data.SaleOutletID != w.x.id ||
			r.data.Refund.ID != firstRefund || r.data.Refund.OutletID != w.y.id || r.data.Order.OutletName != "XO outlet 1" {
			t.Fatalf("response: %+v", r.data)
		}
		var rOutlet, rShift string
		if err := pool.QueryRow(ctx, `SELECT outlet_id::text, shift_id::text FROM order_refunds WHERE id=$1`, firstRefund).Scan(&rOutlet, &rShift); err != nil {
			t.Fatal(err)
		}
		if rOutlet != w.y.id || rShift != w.shiftY {
			t.Fatalf("order_refunds outlet=%s shift=%s", rOutlet, rShift)
		}
		if stock(w.y, w.pA) != yStockA+1 || stock(w.x, w.pA) != xStockA {
			t.Fatalf("stock: Y %d->%d X %d->%d", yStockA, stock(w.y, w.pA), xStockA, stock(w.x, w.pA))
		}
		if seq(w.y) <= ySeq || seq(w.x) != xSeq {
			t.Fatalf("stock seq: Y %d->%d X %d->%d", ySeq, seq(w.y), xSeq, seq(w.x))
		}
		if n := num(`SELECT count(*) FROM stock_movements WHERE kind='refund' AND ref_id=$1 AND location_id=$2 AND refund_of_movement_id IS NOT NULL
			AND refund_of_movement_id IN (SELECT id FROM stock_movements WHERE kind='sale' AND location_id=$3)`, cashSale, w.y.id, w.x.id); n != 1 {
			t.Fatalf("refund movement at Y linked to the X sale movement: %d", n)
		}
		if n := num(`SELECT count(*) FROM erp_outbox WHERE doc_key=$1 AND kind='refund' AND location_id=$2`, "refund:"+firstRefund, w.y.id); n != 1 {
			t.Fatalf("erp_outbox row at Y: %d", n)
		}
		if st := str(`SELECT status FROM orders WHERE id=$1`, cashSale); st != "partially_refunded" {
			t.Fatalf("order status %s", st)
		}
		// X reads its own order: the refund carries outletId = Y
		o := getOrder(w.x.tok, cashSale)
		rs, _ := o["refunds"].([]any)
		if len(rs) != 1 || rs[0].(map[string]any)["outletId"] != w.y.id {
			t.Fatalf("order refunds: %v", o["refunds"])
		}
		// ERP document: Y's location, the refund amount and tender
		var hd erp.OutboxHeader
		if err := pool.QueryRow(ctx, `SELECT id::text, document_id::text, kind, location_type, location_id::text, ref_type, ref_id::text,
		    coalesce(ref_number,''), part, part_count, created_at FROM erp_outbox WHERE doc_key=$1`, "refund:"+firstRefund).
			Scan(&hd.ID, &hd.DocumentID, &hd.Kind, &hd.LocationType, &hd.LocationID, &hd.RefType, &hd.RefID, &hd.RefNumber, &hd.Part, &hd.PartCount, &hd.CreatedAt); err != nil {
			t.Fatal(err)
		}
		in, err := erp.LoadBuildInput(ctx, pool, hd, "mandalika")
		if err != nil {
			t.Fatal(err)
		}
		doc, hold, err := erp.BuildDocument(in)
		if err != nil || hold != "" {
			t.Fatalf("BuildDocument hold=%q err=%v", hold, err)
		}
		if doc.Location.Code != "XO2" || len(doc.Tenders) != 1 || doc.Tenders[0].Amount != -10000 || doc.Tenders[0].Method != "cash" {
			t.Fatalf("ERP doc location=%q tenders=%+v", doc.Location.Code, doc.Tenders)
		}
	})

	t.Run("4 replay is idempotent, even after Y's shift closed", func(t *testing.T) {
		before := totals()
		r := cross(yTok, nil, cashSale, xoBody(w.shiftY, firstUUID, item(0, 1)))
		wantCode("replay", r, 200)
		if !r.data.Replayed || r.data.RefundID != firstRefund || refundRows(cashSale) != 1 || totals() != before {
			t.Fatalf("replay: %+v rows=%d", r.data, refundRows(cashSale))
		}
		r = cross(yTok, nil, cashSale, xoBody(w.shiftY, firstUUID, item(1, 1)))
		wantCode("replay with other items", r, 200)
		if !r.data.Replayed || r.data.RefundID != firstRefund || r.data.Refund.ID != firstRefund || totals() != before {
			t.Fatalf("replay with other items must return the original row: %+v", r.data)
		}
		other := cross(yTok, nil, splitSale, xoBody(w.shiftY, firstUUID, item(0, 1)))
		wantCode("same uuid on another order", other, 400)
		// a second world so closing Y's shift does not disturb the later subtests
		w2 := newWorld()
		sale := sell(w2.x, w2.shiftX, "", "cash", nil, line(w2.pA, 2, 10000))
		u := nextID("1300")
		wantCode("w2 first", cross(w2.y.tok, nil, sale, xoBody(w2.shiftY, u, item(0, 1))), 201)
		if err := svc.CloseShift(ctx, w2.y.id, w2.shiftY, 0, nil); err != nil {
			t.Fatal(err)
		}
		before = totals()
		r = cross(w2.y.tok, nil, sale, xoBody(w2.shiftY, u, item(0, 1)))
		wantCode("replay after close", r, 200)
		if !r.data.Replayed || totals() != before {
			t.Fatalf("replay after close: %+v", r.data)
		}
		wantCode("new uuid after close", cross(w2.y.tok, nil, sale, xoBody(w2.shiftY, nextID("1300"), item(0, 1))), 409)
	})

	t.Run("5 shift: none, someone else's, closed", func(t *testing.T) {
		noShift := newWorld()
		exec(`UPDATE shifts SET status='closed', closed_at=now() WHERE id=$1`, noShift.shiftY)
		sale := sell(noShift.x, noShift.shiftX, "", "cash", nil, line(noShift.pA, 1, 10000))
		before := totals()
		wantCode("closed shift", cross(noShift.y.tok, nil, sale, xoBody(noShift.shiftY, nextID("1300"))), 409)
		wantCode("X's shift", cross(w.y.tok, nil, splitSale, xoBody(w.shiftX, nextID("1300"), item(0, 1))), 409)
		wantCode("unknown shift", cross(w.y.tok, nil, splitSale, xoBody(nextID("1100"), nextID("1300"), item(0, 1))), 409)
		if totals() != before {
			t.Fatalf("a refused refund wrote something: %v -> %v", before, totals())
		}
	})

	t.Run("6 same outlet is refused", func(t *testing.T) {
		before := totals()
		wantCode("own sale", cross(yTok, nil, ownSale, xoBody(w.shiftY, nextID("1300"))), 409)
		if totals() != before {
			t.Fatal("same-outlet refusal wrote something")
		}
	})

	t.Run("7 coverage and validation", func(t *testing.T) {
		wantCode("kasir sending X-Outlet-Id of X", cross(yTok, map[string]string{"X-Outlet-Id": w.x.id}, splitSale, xoBody(w.shiftY, nextID("1300"), item(0, 1))), 403)
		mgrID := nextID("0b00")
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'xo-mgr@example.invalid','x','XO mgr','manager',$2)`, mgrID, w.x.id)
		exec(`INSERT INTO user_outlets(user_id,outlet_id) VALUES($1,$2)`, mgrID, w.y.id)
		mgrTok, err := auth.IssueAccessCov(secret, time.Hour, mgrID, "manager", w.x.id, []string{"process_refund"}, 0,
			coverage.Coverage{OutletIDs: []string{w.x.id, w.y.id}})
		if err != nil {
			t.Fatal(err)
		}
		wantCode("manager covering X+Y, active Y", cross(mgrTok, map[string]string{"X-Outlet-Id": w.y.id}, splitSale, xoBody(w.shiftY, nextID("1300"), item(0, 1))), 201)
		for name, mut := range map[string]func(map[string]any){
			"no deviceId":  func(b map[string]any) { delete(b, "deviceId") },
			"no uuid":      func(b map[string]any) { delete(b, "clientRefundUuid") },
			"bad uuid":     func(b map[string]any) { b["clientRefundUuid"] = "nope" },
			"no reason":    func(b map[string]any) { b["reason"] = " " },
			"empty items":  func(b map[string]any) { b["items"] = []any{} },
			"negative amt": func(b map[string]any) { b["refundAmount"] = -1 },
			"no shift id":  func(b map[string]any) { delete(b, "shiftId") },
		} {
			b := xoBody(w.shiftY, nextID("1300"), item(0, 1))
			mut(b)
			wantCode(name, cross(yTok, nil, splitSale, b), 400)
		}
	})

	t.Run("8 batch refund of another outlet's sale is refused", func(t *testing.T) {
		before := totals()
		uuid := str(`SELECT order_uuid::text FROM orders WHERE id=$1`, cashSale)
		for name, p := range map[string]map[string]any{
			"by orderId":       {"orderId": cashSale, "reason": "rusak", "deviceId": device, "orderUuid": nextID("1400"), "items": []any{item(1, 1)}},
			"by saleOrderUuid": {"saleOrderUuid": uuid, "reason": "rusak", "deviceId": device, "orderUuid": nextID("1400"), "items": []any{item(1, 1)}},
		} {
			res := send(w.y, "refund", p, w.shiftY)
			if res["status"] != "error" || res["code"] != "conflict" || res["retryable"] != false {
				t.Fatalf("%s: %v", name, res)
			}
		}
		if totals() != before {
			t.Fatal("a refused batch refund wrote something")
		}
	})

	t.Run("9 clash: Y refunded the line, X's queued refund becomes a review item", func(t *testing.T) {
		wantCode("Y refunds line 1", cross(yTok, nil, cashSale, xoBody(w.shiftY, nextID("1300"), item(1, 1))), 201)
		before := totals()
		res := send(w.x, "refund", map[string]any{"orderId": cashSale, "reason": "rusak", "deviceId": device,
			"orderUuid": nextID("1400"), "items": []any{item(1, 1)}}, w.shiftX)
		if res["status"] != "error" || res["code"] != "conflict" || res["retryable"] != false {
			t.Fatalf("clash: %v", res)
		}
		if msg, _ := res["error"].(string); !strings.Contains(msg, "melebihi") {
			t.Fatalf("clash text: %q", msg)
		}
		if totals() != before {
			t.Fatal("the refused clash wrote something")
		}
	})

	t.Run("10 shift math: X's drawer untouched, Y's shift pays", func(t *testing.T) {
		w := newWorld()
		cash := sell(w.x, w.shiftX, "", "cash", nil, line(w.pA, 2, 10000), line(w.pB, 1, 20000)) // 40000
		split := sell(w.x, w.shiftX, "", "split", []map[string]any{
			{"method": "qris", "amount": 20000, "reference": "R2"}, {"method": "cash", "amount": 10000}}, line(w.pA, 3, 10000)) // 30000
		wantCode("cash refund", cross(w.y.tok, nil, cash, xoBody(w.shiftY, nextID("1300"), item(0, 1))), 201) // 10000 cash
		b := xoBody(w.shiftY, nextID("1300"), item(0, 3))
		b["payoutMethod"] = "cash"
		wantCode("split refund in cash", cross(w.y.tok, nil, split, b), 201) // 30000 paid in cash
		// live view at Y while its shift is open
		code, raw, _ := call("GET", "/shifts/current", w.y.tok, nil, nil)
		var live struct {
			Data struct {
				RefundsPaidByMethod map[string]float64 `json:"refundsPaidByMethod"`
			}
		}
		if code != 200 || json.Unmarshal(raw, &live) != nil || live.Data.RefundsPaidByMethod["cash"] != 40000 {
			t.Fatalf("live Y recap: %d %s", code, raw)
		}
		shiftRow := func(id string) (cashSales, totalSales, totalRefunds, cashPaid int64) {
			if err := pool.QueryRow(ctx, `SELECT round(cash_sales)::bigint, round(total_sales)::bigint, round(total_refunds)::bigint,
				round(cash_refunds_paid)::bigint FROM shifts WHERE id=$1`, id).Scan(&cashSales, &totalSales, &totalRefunds, &cashPaid); err != nil {
				t.Fatal(err)
			}
			return
		}
		if err := svc.CloseShift(ctx, w.x.id, w.shiftX, 0, nil); err != nil {
			t.Fatal(err)
		}
		cs, ts, tr, cp := shiftRow(w.shiftX)
		if cs != 50000 || ts != 70000 || tr != 0 || cp != 0 {
			t.Fatalf("X close: cash_sales=%d total_sales=%d total_refunds=%d cash_refunds_paid=%d, want 50000/70000/0/0", cs, ts, tr, cp)
		}
		if q := num(`SELECT round(qris_sales)::bigint FROM shifts WHERE id=$1`, w.shiftX); q != 20000 {
			t.Fatalf("X qris bucket %d, want 20000", q)
		}
		if err := svc.CloseShift(ctx, w.y.id, w.shiftY, 0, nil); err != nil {
			t.Fatal(err)
		}
		cs, ts, tr, cp = shiftRow(w.shiftY)
		if cp != 40000 || cs != 0 || ts != 0 || tr != 0 {
			t.Fatalf("Y close: cash_sales=%d total_sales=%d total_refunds=%d cash_refunds_paid=%d, want 0/0/0/40000", cs, ts, tr, cp)
		}
	})

	t.Run("11 reports: net drops at X, payout shows at Y", func(t *testing.T) {
		w := newWorld()
		sale := sell(w.x, w.shiftX, "", "cash", nil, line(w.pA, 2, 10000)) // 20000
		wantCode("refund", cross(w.y.tok, nil, sale, xoBody(w.shiftY, nextID("1300"), item(0, 1))), 201)
		day := time.Now().UTC()
		win := fmt.Sprintf("&dateFrom=%s&dateTo=%s", day.AddDate(0, 0, -1).Format("2006-01-02"), day.AddDate(0, 0, 1).Format("2006-01-02"))
		summary := func(outlet string) (refunds float64, orders int) {
			code, raw, _ := call("GET", "/reports/summary?outletId="+outlet+win, adminAll, nil, nil)
			var out struct {
				Data struct {
					TotalRefunds float64
					GrossOrders  int
				}
			}
			if code != 200 || json.Unmarshal(raw, &out) != nil {
				t.Fatalf("summary %d %s", code, raw)
			}
			return out.Data.TotalRefunds, out.Data.GrossOrders
		}
		if r, o := summary(w.x.id); r != 10000 || o != 1 {
			t.Fatalf("summary at X: refunds=%v orders=%d", r, o)
		}
		if r, o := summary(w.y.id); r != 0 || o != 0 {
			t.Fatalf("summary at Y: refunds=%v orders=%d", r, o)
		}
		report := func(outlet string) (count int, saleOutlet string) {
			code, raw, _ := call("GET", "/refund-report?outletId="+outlet+win, adminAll, nil, nil)
			var out struct {
				Summary struct{ Count int }
				Data    []struct {
					OutletName, SaleOutletName string
				}
			}
			if code != 200 || json.Unmarshal(raw, &out) != nil {
				t.Fatalf("refund-report %d %s", code, raw)
			}
			if len(out.Data) > 0 && out.Data[0].OutletName != str(`SELECT name FROM outlets WHERE id=$1`, w.y.id) {
				t.Fatalf("refund report outlet name %q", out.Data[0].OutletName)
			}
			if len(out.Data) > 0 {
				saleOutlet = out.Data[0].SaleOutletName
			}
			return out.Summary.Count, saleOutlet
		}
		if c, so := report(w.y.id); c != 1 || so != str(`SELECT name FROM outlets WHERE id=$1`, w.x.id) {
			t.Fatalf("refund report at Y: count=%d saleOutlet=%q", c, so)
		}
		if c, _ := report(w.x.id); c != 0 {
			t.Fatalf("refund report at X: count=%d", c)
		}
		dash := func(outlet string) float64 {
			code, raw, _ := call("GET", "/reports/dashboard?outletId="+outlet+win+"&trend=day", adminAll, nil, nil)
			var out struct {
				Data struct{ Current struct{ Refunds float64 } }
			}
			if code != 200 || json.Unmarshal(raw, &out) != nil {
				t.Fatalf("dashboard %d %s", code, raw)
			}
			return out.Data.Current.Refunds
		}
		if d := dash(w.x.id); d != 10000 {
			t.Fatalf("dashboard refunds at X: %v", d)
		}
		if d := dash(w.y.id); d != 0 {
			t.Fatalf("dashboard refunds at Y: %v", d)
		}
	})

	t.Run("12 concurrency: Y's cross refund and X's batch refund of the last unit", func(t *testing.T) {
		w := newWorld()
		sale := sell(w.x, w.shiftX, "", "cash", nil, line(w.pA, 1, 10000))
		var wg sync.WaitGroup
		var crossCode int
		var batchRes map[string]any
		wg.Add(2)
		go func() {
			defer wg.Done()
			c, _, _ := call("POST", "/orders/"+sale+"/cross-outlet-refund", w.y.tok, nil, xoBody(w.shiftY, nextID("1300"), item(0, 1)))
			crossCode = c
		}()
		bp := map[string]any{"orderId": sale, "reason": "rusak", "deviceId": device, "orderUuid": nextID("1400"), "items": []any{item(0, 1)}}
		bk := nextID("1500")
		go func() {
			defer wg.Done()
			env := map[string]any{"v": 1, "outletId": w.x.id, "userId": w.x.user, "deviceId": device,
				"capturedAt": time.Now().UTC().Format(time.RFC3339Nano), "offlineMs": time.Hour.Milliseconds(), "shiftId": w.shiftX}
			it := map[string]any{"type": "refund", "idempotencyKey": device + ":" + bk, "payload": bp, "envelope": env}
			_, raw, _ := call("POST", "/sync/batch", w.x.tok, nil, map[string]any{"items": []any{it}})
			var out struct {
				Data struct{ Results []map[string]any }
			}
			if json.Unmarshal(raw, &out) == nil && len(out.Data.Results) == 1 {
				batchRes = out.Data.Results[0]
			}
		}()
		wg.Wait()
		crossOK, batchOK := crossCode == 201, batchRes != nil && batchRes["status"] == "ok"
		if crossOK == batchOK {
			t.Fatalf("exactly one must apply: cross=%d batch=%v", crossCode, batchRes)
		}
		if n := refundRows(sale); n != 1 {
			t.Fatalf("%d refund rows, want 1", n)
		}
		if !crossOK && crossCode != 409 {
			t.Fatalf("the losing cross refund must be a 409, got %d", crossCode)
		}
	})
}
