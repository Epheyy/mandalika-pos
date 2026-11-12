package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/bundles"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Bundles phase 2: the server sale path (sync + direct), stock, refund group and order read.
// Called at the end of TestBundlesPostgres, which owns the fixture. Seeds its own cashier,
// stock and a swap product; sets the bundle prices itself so it does not depend on the
// earlier subtests' final state.
func bundleSaleSubtests(t *testing.T, pool *pgxpool.Pool, ctx context.Context, rd *read.Repo, wr *write.Repo, outlet, champ string, secret []byte) {
	const (
		cashier = "00000000-0000-4000-8f00-000000000021"
		swapP   = "00000000-0000-4000-8f00-0000000000c3"
		device  = "00000000-0000-4000-8f00-0000000000d1"
		extFull = "120ml EXTRAIT DE PARFUM"
		atom    = "10ml ATOMIZER"
		vialEXT = "2ml EXTRAIT DE PARFUM"
		vialPI  = "2ml PARFUM INTENSE"
	)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	str := func(q string, args ...any) string {
		t.Helper()
		var s *string
		if err := pool.QueryRow(ctx, q, args...).Scan(&s); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		if s == nil {
			return "<null>"
		}
		return *s
	}
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id)
	      VALUES($1,'bn-cashier@example.invalid','x','BN Cashier','cashier',$2)`, cashier, outlet)
	exec(`INSERT INTO products(id,name) VALUES($1,'BN SWAP')`, swapP)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,erp_slug,erp_category)
	      VALUES($1,$2,300000,0,'BNSWAP1','bn-swap-1','ATOMIZER')`, swapP, atom)
	for _, v := range []struct{ pid, size string }{
		{champ, extFull}, {champ, atom}, {champ, vialEXT}, {champ, vialPI}, {swapP, atom},
	} {
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,100)`, outlet, v.pid, v.size)
	}
	exec(`DELETE FROM bundle_prices`)
	exec(`INSERT INTO bundle_prices(line,size,price) VALUES('','120ml',795000),('EXTRAIT DE PARFUM','120ml',850000)`)

	svc := service.NewOrderService(pool)
	eng := syncpkg.New(pool, rd, svc, wr)
	eng.ContactKey = syncpkg.DeriveContactKey(secret)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, eng, nil)
	tok, err := auth.IssueAccess(secret, time.Hour, cashier, "cashier", outlet, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/sync/batch", h.SyncBatch)
	router.Post("/orders", h.CreateOrder)
	router.Get("/orders/{id}", h.Order)
	router.Post("/orders/{id}/refund", h.RefundOrder)
	call := func(method, path string, headers map[string]string, body any) (int, map[string]any, string) {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+tok)
		r.Header.Set("Content-Type", "application/json")
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out, w.Body.String()
	}

	seq := 0
	piece := func(group int, role, pid, name, size string, price, basis float64, bundlePrice float64) map[string]any {
		return map[string]any{
			"productId": pid, "productName": name, "variantSize": size, "price": price, "quantity": 1,
			"subtotal": price, "bundleGroup": group, "bundleRole": role,
			"bundlePrice": bundlePrice, "bundleBasisPrice": basis,
		}
	}
	// champion bundle: EXT 120ml + atomizer (own or swapped) + EXT 2ml
	bundleItems := func(atomPID string, atomBasis, bundlePrice float64) []map[string]any {
		return []map[string]any{
			piece(1, "large", champ, "CHAMPION", extFull, 675498, 1200000, bundlePrice),
			piece(1, "atomizer", atomPID, "ATOMIZER", atom, 140728, atomBasis, bundlePrice),
			piece(1, "vial", champ, "CHAMPION", vialEXT, 33774, 60000, bundlePrice),
		}
	}
	sale := func(items []map[string]any, total float64) map[string]any {
		seq++
		return map[string]any{
			"orderUuid": fmt.Sprintf("00000000-0000-4000-8f03-%012d", seq), "deviceId": device,
			"paymentMethod": "cash", "amountPaid": total, "items": items,
		}
	}
	syncSale := func(p map[string]any) map[string]any {
		t.Helper()
		env := map[string]any{"v": 1, "outletId": outlet, "userId": cashier, "deviceId": device,
			"capturedAt": time.Now().UTC().Format(time.RFC3339Nano), "offlineMs": time.Hour.Milliseconds()}
		item := map[string]any{"type": "order", "idempotencyKey": device + ":" + p["orderUuid"].(string), "payload": p, "envelope": env}
		code, out, raw := call("POST", "/sync/batch", nil, map[string]any{"items": []any{item}})
		if code != 200 {
			t.Fatalf("batch %d %s", code, raw)
		}
		res := out["data"].(map[string]any)["results"].([]any)[0].(map[string]any)
		if res["status"] != "ok" {
			t.Fatalf("sale not ok: %v", res)
		}
		return res
	}
	orderID := func(p map[string]any) string {
		return str(`SELECT id::text FROM orders WHERE order_uuid=$1`, p["orderUuid"].(string))
	}
	stock := func(pid, size string) string {
		return str(`SELECT stock::text FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, outlet, pid, size)
	}
	type row struct {
		group, role, group2, line, size, price string
		isBundle                               string
	}
	itemRows := func(oid string) []row {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT bundle_group::text, bundle_role, refund_group, COALESCE(bundle_line,''),
		       COALESCE(bundle_size,''), price::text, is_bundle::text
		  FROM order_items WHERE order_id=$1 ORDER BY line_no`, oid)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []row
		for rows.Next() {
			var r row
			var g, ro, rg *string
			if err := rows.Scan(&g, &ro, &rg, &r.line, &r.size, &r.price, &r.isBundle); err != nil {
				t.Fatal(err)
			}
			for _, p := range []struct {
				dst *string
				src *string
			}{{&r.group, g}, {&r.role, ro}, {&r.group2, rg}} {
				if p.src != nil {
					*p.dst = *p.src
				}
			}
			out = append(out, r)
		}
		return out
	}

	var firstSale map[string]any
	t.Run("sale_sync_bundle", func(t *testing.T) {
		before := [3]string{stock(champ, extFull), stock(swapP, atom), stock(champ, vialEXT)}
		p := sale(bundleItems(swapP, 300000, 850000), 850000)
		syncSale(p)
		firstSale = p
		want := [3]int64{653847, 163461, 32692} // Split(850000, [1200000, 300000, 60000])
		if got, _ := bundles.Split(850000, [3]int64{1200000, 300000, 60000}); got != want {
			t.Fatalf("split twin drifted: %v", got)
		}
		rows := itemRows(orderID(p))
		roles := []string{"large", "atomizer", "vial"}
		if len(rows) != 3 {
			t.Fatalf("rows = %+v", rows)
		}
		for i, r := range rows {
			if r.group != "1" || r.role != roles[i] || r.group2 != "set:1" || r.isBundle != "false" ||
				r.line != "EXTRAIT DE PARFUM" || r.size != "120ml" || r.price != fmt.Sprintf("%d.00", want[i]) {
				t.Errorf("row %d = %+v", i, r)
			}
		}
		after := [3]string{stock(champ, extFull), stock(swapP, atom), stock(champ, vialEXT)}
		for i := range before {
			if before[i] != "100" || after[i] != "99" {
				t.Errorf("piece %d stock %s -> %s, want 100 -> 99", i, before[i], after[i])
			}
		}
		if got := str(`SELECT total::text FROM orders WHERE order_uuid=$1`, p["orderUuid"].(string)); got != "850000.00" {
			t.Errorf("order total %s", got)
		}
	})

	t.Run("sale_stale_price_offline", func(t *testing.T) {
		p := sale(bundleItems(champ, 250000, 795000), 795000)
		syncSale(p)
		oid := orderID(p)
		if got := str(`SELECT discount_warning::text FROM orders WHERE id=$1`, oid); got != "true" {
			t.Errorf("discount_warning = %s", got)
		}
		if got := str(`SELECT discount_warning_reason FROM orders WHERE id=$1`, oid); !strings.Contains(got, "bundle_price_changed") {
			t.Errorf("reason = %s", got)
		}
		if got := str(`SELECT sum(price)::text FROM order_items WHERE order_id=$1`, oid); got != "795000.00" {
			t.Errorf("pieces add up to %s, want the tablet price 795000", got)
		}
	})

	t.Run("sale_invalid_online", func(t *testing.T) {
		items := bundleItems(champ, 250000, 850000)
		items[2] = piece(1, "vial", champ, "CHAMPION", vialPI, 33774, 55000, 850000) // PI vial in an EXT bundle
		p := sale(items, 850000)
		code, _, raw := call("POST", "/orders", map[string]string{"Idempotency-Key": "bn-invalid-" + p["orderUuid"].(string)}, p)
		if code != 422 || !strings.Contains(raw, "Bundel tidak valid atau syaratnya tidak terpenuhi") {
			t.Fatalf("got %d %s", code, raw)
		}
		if n := str(`SELECT count(*)::text FROM orders WHERE order_uuid=$1`, p["orderUuid"].(string)); n != "0" {
			t.Errorf("a refused sale left %s order rows", n)
		}
	})

	t.Run("sale_invalid_synced_is_kept_and_flagged", func(t *testing.T) {
		items := bundleItems(champ, 250000, 850000)
		items[2] = piece(1, "vial", champ, "CHAMPION", vialPI, 33774, 55000, 850000)
		p := sale(items, 850000)
		syncSale(p)
		oid := orderID(p)
		if got := str(`SELECT discount_warning_reason FROM orders WHERE id=$1`, oid); !strings.Contains(got, "bundle_invalid") {
			t.Errorf("reason = %s", got)
		}
		for _, r := range itemRows(oid) {
			if r.group2 != "set:1" {
				t.Errorf("kept bundle lost its refund group: %+v", r)
			}
		}
	})

	t.Run("refund_one_piece_refused", func(t *testing.T) {
		oid := orderID(firstSale)
		path := "/orders/" + oid + "/refund"
		code, _, raw := call("POST", path, nil, map[string]any{"reason": "satu saja", "items": []map[string]int{{"lineNo": 1, "quantity": 1}}})
		if code != 400 || !strings.Contains(raw, "Barang promo paket/beli-gratis harus direfund bersamaan seluruhnya.") {
			t.Fatalf("one piece: %d %s", code, raw)
		}
		pieces := [][2]string{{champ, extFull}, {swapP, atom}, {champ, vialEXT}}
		before := make([]string, len(pieces))
		for i, s := range pieces {
			before[i] = str(`SELECT (stock+1)::text FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, outlet, s[0], s[1])
		}
		code, _, raw = call("POST", path, nil, map[string]any{"reason": "semua", "items": []map[string]int{
			{"lineNo": 0, "quantity": 1}, {"lineNo": 1, "quantity": 1}, {"lineNo": 2, "quantity": 1}}})
		if code != 201 {
			t.Fatalf("whole bundle: %d %s", code, raw)
		}
		if got := str(`SELECT sum(amount)::text FROM order_refunds WHERE order_id=$1`, oid); got != "850000.00" {
			t.Errorf("refunded %s, want 850000", got)
		}
		for i, s := range pieces {
			if got := stock(s[0], s[1]); got != before[i] {
				t.Errorf("%s %s stock %s after the refund, want %s (each piece restocked once)", s[0], s[1], got, before[i])
			}
		}
	})

	t.Run("order_read_bundle_fields", func(t *testing.T) {
		items := append(bundleItems(champ, 250000, 850000), map[string]any{
			"productId": champ, "productName": "CHAMPION", "variantSize": extFull, "price": 1200000, "quantity": 1, "subtotal": 1200000})
		p := sale(items, 2050000)
		syncSale(p)
		code, out, raw := call("GET", "/orders/"+orderID(p), nil, nil)
		if code != 200 {
			t.Fatalf("GET %d %s", code, raw)
		}
		list := out["data"].(map[string]any)["items"].([]any)
		if len(list) != 4 {
			t.Fatalf("items = %d", len(list))
		}
		pieces, plain := 0, 0
		for _, it := range list {
			m := it.(map[string]any)
			if _, has := m["bundleGroup"]; !has {
				plain++
				if m["bundleRole"] != nil || m["bundleLine"] != nil || m["bundleSize"] != nil || m["bundleDiscount"] != nil {
					t.Errorf("plain line carries bundle keys: %v", m)
				}
				continue
			}
			pieces++
			if m["bundleGroup"] != float64(1) || m["bundleLine"] != "EXTRAIT DE PARFUM" || m["bundleSize"] != "120ml" || m["bundleRole"] == nil {
				t.Errorf("piece = %v", m)
			}
			if _, has := m["bundlePromotionId"]; has {
				t.Errorf("piece carries a promotion id: %v", m)
			}
		}
		if pieces != 3 || plain != 1 {
			t.Fatalf("pieces=%d plain=%d", pieces, plain)
		}
	})

	bundleDiscountSubtests(t, pool, ctx, wr, str, exec, bundleItems, sale, syncSale, orderID, champ, extFull)
}
