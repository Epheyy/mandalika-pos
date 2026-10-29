package handlers

import (
	"fmt"
	"strings"
)

// Gate SP subtests 9, 9b, 9c, 11 and 12: refund payout, the setting, the reserved id and the
// tender-sum invariant. Sales and refunds go through the real sync items and direct routes.

func (e *spEnv) refundItem(o spOutlet, order string, extra map[string]any) map[string]any {
	e.t.Helper()
	p := map[string]any{"orderId": order, "reason": "rusak", "deviceId": e.device, "orderUuid": e.nextID("1000")}
	for k, v := range extra {
		p[k] = v
	}
	return e.batchItem(o, "refund", e.newKey("refund"), p, "")
}

func (e *spEnv) refundOK(o spOutlet, order string, extra map[string]any) {
	e.t.Helper()
	if res := e.refundItem(o, order, extra); res["status"] != "ok" {
		e.t.Fatalf("refund: want ok, got %v", res)
	}
}

// payouts lists the order's refund rows as "method/source", oldest first.
func (e *spEnv) payouts(order string) string {
	e.t.Helper()
	var s string
	if err := e.pool.QueryRow(e.ctx, `SELECT coalesce(string_agg(payment_method||'/'||coalesce(payout_source,''), ',' ORDER BY seq),'')
		FROM order_refunds WHERE order_id=$1`, order).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

// sqlDefault is the SQL twin of the Go default payout method.
func (e *spEnv) sqlDefault(order string) string {
	e.t.Helper()
	var s string
	if err := e.pool.QueryRow(e.ctx, `SELECT order_default_payout_method($1)`, order).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

// agrees checks the recorded default payout against the SQL function (Go/SQL parity).
func (e *spEnv) agrees(order, wantMethod string) {
	e.t.Helper()
	e.want("sql default "+order, e.sqlDefault(order), wantMethod)
}

func (e *spEnv) withMethods(js string) func() {
	e.exec(`UPDATE app_settings SET payment_methods=$1::jsonb`, js)
	return func() { e.exec(`UPDATE app_settings SET payment_methods='[]'::jsonb`) }
}

func (e *spEnv) splitSale(o spOutlet, pid string, tenders ...map[string]any) string {
	var total float64
	for _, t := range tenders {
		total += t["amount"].(float64)
	}
	return e.sale(o, pid, "split", total, total, tenders, "")
}

// ── subtest 9 ──

func (e *spEnv) refundPayout() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	e.payoutSingleMethod(o, pid)
	e.payoutDefaults(o, pid)
	e.payoutConfigured(o, pid)
	e.payoutLegacyWriter(o, pid)
	e.payoutPartRefunds(o, pid)
}

func (e *spEnv) payoutSingleMethod(o spOutlet, pid string) {
	a := e.sale(o, pid, "qris", 100000, 100000, nil, "")
	e.refundOK(o, a, map[string]any{"payoutMethod": "cash"})
	e.want("single method ignores payoutMethod", e.payouts(a), "qris/sale")

	b := e.sale(o, pid, "qris", 100000, 100000, nil, "")
	e.exec(`DELETE FROM order_tenders WHERE order_id=$1`, b) // a pre-C6 order: synthetic line only
	e.refundOK(o, b, map[string]any{"payoutMethod": "cash"})
	e.want("pre-C6 tenderless order", e.payouts(b), "qris/sale")
}

func (e *spEnv) payoutDefaults(o spOutlet, pid string) {
	c := e.splitSale(o, pid, line("qris", 60000), line("cash", 40000))
	e.refundOK(o, c, nil)
	e.want("cash line default", e.payouts(c), "cash/default")
	e.agrees(c, "cash")

	d := e.splitSale(o, pid, line("card", 20000), line("qris", 80000))
	e.refundOK(o, d, nil)
	e.want("largest line default", e.payouts(d), "qris/default")
	e.agrees(d, "qris")

	tie := e.splitSale(o, pid, line("transfer", 50000), line("qris", 50000))
	e.refundOK(o, tie, nil)
	e.want("tie goes to the lowest seq", e.payouts(tie), "transfer/default")
	e.agrees(tie, "transfer")

	f := e.splitSale(o, pid, line("qris", 60000), line("cash", 40000))
	e.refundOK(o, f, map[string]any{"payoutMethod": "transfer"})
	e.want("chosen method", e.payouts(f), "transfer/chosen")
}

func (e *spEnv) payoutConfigured(o spOutlet, pid string) {
	// isCash:false on the cash id flips the default to the largest line.
	g := e.splitSale(o, pid, line("qris", 60000), line("cash", 40000))
	restore := e.withMethods(`[{"id":"cash","label":"Cash","isEnabled":true,"isCash":false},{"id":"qris","label":"QRIS","isEnabled":true}]`)
	e.refundOK(o, g, nil)
	restore()
	e.want("cash flagged non-cash", e.payouts(g), "qris/default")

	// a configured id that differs only by case still identifies the cash line.
	restore = e.withMethods(`[{"id":"Kas_Kecil","label":"Kas","isEnabled":true,"isCash":true},{"id":"qris","label":"QRIS","isEnabled":true}]`)
	defer restore()
	h := e.splitSale(o, pid, line("qris", 60000), line("kas_kecil", 40000))
	e.refundOK(o, h, nil)
	e.want("case-mismatched configured id", e.payouts(h), "kas_kecil/default")
	e.agrees(h, "kas_kecil")

	// a chosen method that matches a configured id case-insensitively is stored as that id, so
	// the case-sensitive shift buckets classify it.
	k := e.splitSale(o, pid, line("qris", 60000), line("kas_kecil", 40000))
	e.refundOK(o, k, map[string]any{"payoutMethod": " KAS_KECIL "})
	e.want("chosen payout canonicalised", e.payouts(k), "Kas_Kecil/chosen")
	free := e.splitSale(o, pid, line("qris", 60000), line("kas_kecil", 40000))
	e.refundOK(o, free, map[string]any{"payoutMethod": " Voucher "})
	e.want("unconfigured chosen payout kept trimmed", e.payouts(free), "Voucher/chosen")
}

func (e *spEnv) payoutLegacyWriter(o spOutlet, pid string) {
	// a sentinel order without tender rows: Go and the trigger both record the order method as default.
	z := e.sale(o, pid, "qris", 100000, 100000, nil, "")
	e.exec(`DELETE FROM order_tenders WHERE order_id=$1`, z)
	e.exec(`UPDATE orders SET payment_method='split' WHERE id=$1`, z)
	e.refundOK(o, z, nil)
	e.want("sentinel without lines (Go)", e.payouts(z), "split/default")
	z2 := e.sale(o, pid, "qris", 100000, 100000, nil, "")
	e.exec(`DELETE FROM order_tenders WHERE order_id=$1`, z2)
	e.exec(`UPDATE orders SET payment_method='split' WHERE id=$1`, z2)
	e.exec(`UPDATE orders SET status='refunded' WHERE id=$1`, z2)
	e.want("sentinel without lines (SQL trigger)", e.payouts(z2), "split/default")

	r := e.splitSale(o, pid, line("qris", 60000), line("cash", 40000))
	e.exec(`UPDATE orders SET status='refunded' WHERE id=$1`, r)
	e.want("raw refunded write on a split order", e.payouts(r), "cash/default")
	e.agrees(r, "cash")
	s := e.sale(o, pid, "qris", 100000, 100000, nil, "")
	e.exec(`UPDATE orders SET status='refunded' WHERE id=$1`, s)
	e.want("raw refunded write on a single-method order", e.payouts(s), "qris/sale")
}

func (e *spEnv) payoutPartRefunds(o spOutlet, pid string) {
	p := e.salePayload(pid, "split", 100000, 100000, 2, []map[string]any{line("qris", 60000), line("cash", 40000)})
	id := e.batchSale(o, p)
	part := func(method string) {
		e.refundOK(o, id, map[string]any{"items": []map[string]any{{"lineNo": 0, "quantity": 1}}, "payoutMethod": method})
	}
	part("cash")
	part("qris")
	e.want("each part refund picks its own method", e.payouts(id), "cash/chosen,qris/chosen")
}

// ── subtest 9b ──

func (e *spEnv) refundPayoutInput() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	id := e.splitSale(o, pid, line("qris", 60000), line("cash", 40000))
	bad := []any{"", "   ", "split", "  SPLIT ", "SPL\u0130T", "qr\x00is", "qr\tis", strings.Repeat("x", 65), 123, true}
	for _, v := range bad {
		res := e.refundItem(o, id, map[string]any{"payoutMethod": v})
		if res["status"] != "error" || res["code"] != "rejected" || res["retryable"] != false {
			e.t.Fatalf("sync payoutMethod %#v: want a rejected item, got %v", v, res)
		}
		code, raw := e.call("POST", "/orders/"+id+"/refund", o.tok, map[string]any{"reason": "rusak", "payoutMethod": v})
		if code != 400 {
			e.t.Fatalf("direct payoutMethod %#v: want 400, got %d %s", v, code, raw)
		}
	}
	e.want("invalid payoutMethod writes nothing", e.payouts(id), "")

	// a single-method order IGNORES a malformed payoutMethod (plan 2.6): the refund goes through
	// and pays out in the sale method.
	for _, v := range bad {
		if _, isStr := v.(string); !isStr {
			continue // a non-string fails the direct decode; the sync path is covered below
		}
		one := e.sale(o, pid, "qris", 100000, 100000, nil, "")
		e.refundOK(o, one, map[string]any{"payoutMethod": v})
		e.want(fmt.Sprintf("single method ignores payoutMethod %#v", v), e.payouts(one), "qris/sale")
	}
	for _, v := range []any{123, true} {
		one := e.sale(o, pid, "qris", 100000, 100000, nil, "")
		e.refundOK(o, one, map[string]any{"payoutMethod": v})
		e.want(fmt.Sprintf("single method ignores payoutMethod %#v", v), e.payouts(one), "qris/sale")
	}

	// replay of a refund that carried payoutMethod returns the original row.
	p := map[string]any{"orderId": id, "reason": "rusak", "deviceId": e.device, "orderUuid": e.nextID("1000"), "payoutMethod": "qris"}
	key := e.newKey("refund")
	first := e.batchItem(o, "refund", key, p, "")
	again := e.batchItem(o, "refund", key, p, "")
	if first["status"] != "ok" || (again["status"] != "ok" && again["status"] != "duplicate") {
		e.t.Fatalf("refund replay: first %v again %v", first, again)
	}
	e.want("replayed refund keeps the original row", e.payouts(id), "qris/chosen")

	// the direct route honours a chosen method on a split order.
	d := e.splitSale(o, pid, line("qris", 60000), line("cash", 40000))
	if code, raw := e.call("POST", "/orders/"+d+"/refund", o.tok, map[string]any{"reason": "rusak", "payoutMethod": "transfer"}); code >= 300 {
		e.t.Fatalf("direct chosen refund: %d %s", code, raw)
	}
	e.want("direct chosen method", e.payouts(d), "transfer/chosen")
}

// ── subtest 9c ──

func (e *spEnv) putSettings(mutate func(map[string]any)) int {
	e.t.Helper()
	data := e.getData("/settings/app")
	mutate(data)
	code, raw := e.call("PUT", "/settings/app", e.adminAll, data)
	if code >= 300 && code != 400 {
		e.t.Fatalf("PUT settings: %d %s", code, raw)
	}
	return code
}

func (e *spEnv) settingsState() (on bool, at string) {
	e.t.Helper()
	if err := e.pool.QueryRow(e.ctx, `SELECT split_tender_enabled, coalesce(split_tender_enabled_at::text,'') FROM app_settings WHERE id=1`).
		Scan(&on, &at); err != nil {
		e.t.Fatal(err)
	}
	return
}

func (e *spEnv) splitSettings() {
	e.exec(`UPDATE app_settings SET split_tender_enabled=false, split_tender_enabled_at=NULL WHERE id=1`)
	defer e.exec(`UPDATE app_settings SET split_tender_enabled=false, split_tender_enabled_at=NULL WHERE id=1`)
	read := func() bool { v, _ := e.getData("/settings/app")["splitTenderEnabled"].(bool); return v }
	without := func(m map[string]any) { delete(m, "splitTenderEnabled") }

	e.putSettings(without)
	if on, at := e.settingsState(); on || at != "" {
		e.t.Fatalf("a save without the key must keep it off and unstamped: %v %q", on, at)
	}
	e.putSettings(func(m map[string]any) { m["splitTenderEnabled"] = true })
	on, stamp := e.settingsState()
	if !on || stamp == "" || !read() {
		e.t.Fatalf("first switch-on: on=%v at=%q read=%v", on, stamp, read())
	}
	e.putSettings(without)
	if on, at := e.settingsState(); !on || at != stamp {
		e.t.Fatalf("a save without the key must keep it on: %v %q", on, at)
	}
	e.putSettings(func(m map[string]any) { m["splitTenderEnabled"] = false })
	if on, at := e.settingsState(); on || at != stamp || read() {
		e.t.Fatalf("switching off must keep the stamp: %v %q read=%v", on, at, read())
	}
	e.putSettings(func(m map[string]any) { m["splitTenderEnabled"] = true })
	if on, at := e.settingsState(); !on || at != stamp || !read() {
		e.t.Fatalf("switching on again must keep the first stamp: %v %q", on, at)
	}
}

// ── subtest 11 ──

func (e *spEnv) methodsText() (s string) {
	e.t.Helper()
	if err := e.pool.QueryRow(e.ctx, `SELECT payment_methods::text FROM app_settings WHERE id=1`).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return
}

func (e *spEnv) reservedID() {
	before := e.methodsText()
	for _, id := range []string{"split", "Split", " SPLIT "} {
		code := e.putSettings(func(m map[string]any) {
			m["paymentMethods"] = []map[string]any{{"id": id, "label": "Split", "isEnabled": true}}
		})
		if code != 400 {
			e.t.Fatalf("payment method id %q: want 400, got %d", id, code)
		}
	}
	if after := e.methodsText(); after != before {
		e.t.Fatal("a rejected settings write changed the stored methods")
	}
}

// ── subtest 12 ──

// tenderSumInvariant: over everything the gate created, every order that has tender rows has
// Σ applied = total. No fixture violates it on purpose (tenderless fixtures have no rows to join).
func (e *spEnv) tenderSumInvariant() {
	rows, err := e.pool.Query(e.ctx, `SELECT o.id FROM orders o JOIN order_tenders t ON t.order_id=o.id
		GROUP BY o.id, o.total HAVING abs(sum(t.amount)-o.total) > 1`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var bad []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			e.t.Fatal(err)
		}
		bad = append(bad, id)
	}
	if len(bad) > 0 {
		e.t.Fatal(fmt.Sprintf("orders whose tender lines do not sum to the total: %v", bad))
	}
}
