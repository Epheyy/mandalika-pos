package handlers

import (
	"fmt"
	"strings"
)

// Gate SP subtests 1-5: the split sale path on both routes (sync batch and direct POST /orders).

type tl = map[string]any // one tenders[] line

func line(method string, amount float64) tl { return tl{"method": method, "amount": amount} }

func (e *spEnv) orderDump(id string) string {
	e.t.Helper()
	var s string
	if err := e.pool.QueryRow(e.ctx, `SELECT payment_method||'|'||round(amount_paid)::bigint||'|'||round(change)::bigint||'|'||
		tender_warning||'|'||coalesce(tender_warning_reason,'') FROM orders WHERE id=$1`, id).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *spEnv) tenderDump(id string) string {
	e.t.Helper()
	var s string
	if err := e.pool.QueryRow(e.ctx, `SELECT coalesce(string_agg(seq||'|'||method||'|'||round(amount)::bigint||'|'||round(tendered)::bigint||'|'||
		round(change)::bigint||'|'||coalesce(reference,''), ';' ORDER BY seq),'') FROM order_tenders WHERE order_id=$1`, id).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *spEnv) orderCount(o spOutlet) int64 {
	e.t.Helper()
	return e.num(`SELECT count(*) FROM orders WHERE outlet_id=$1`, o.id)
}

func (e *spEnv) tenderRowCount(o spOutlet) int64 {
	e.t.Helper()
	return e.num(`SELECT count(*) FROM order_tenders t JOIN orders x ON x.id=t.order_id WHERE x.outlet_id=$1`, o.id)
}

// direct posts a sale to the direct route.
func (e *spEnv) direct(o spOutlet, p map[string]any, key string) (int, []byte) {
	e.t.Helper()
	return e.callH("POST", "/orders", o.tok, p, map[string]string{"Idempotency-Key": key})
}

func (e *spEnv) want(label, got, want string) {
	e.t.Helper()
	if got != want {
		e.t.Fatalf("%s: got %q want %q", label, got, want)
	}
}

// batchSale sends a sale item under a fresh key and returns the order id (must be ok).
func (e *spEnv) batchSale(o spOutlet, p map[string]any) string {
	e.t.Helper()
	id, _ := e.send(o, "order", p, "")["orderId"].(string)
	if id == "" {
		e.t.Fatal("no order id")
	}
	return id
}

// ── subtest 1 ──

func (e *spEnv) syncSplitSale() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	id := e.sale(o, pid, "split", 100000, 110000, []map[string]any{
		{"method": "qris", "amount": 60000, "reference": "R1"}, line("cash", 50000)}, "")
	e.want("order", e.orderDump(id), "split|110000|10000|false|")
	e.want("rows", e.tenderDump(id), "1|qris|60000|60000|0|R1;2|cash|40000|50000|10000|")
	if n := e.num(`SELECT round(sum(amount)-(SELECT total FROM orders WHERE id=$1))::bigint FROM order_tenders WHERE order_id=$1`, id); n != 0 {
		e.t.Fatalf("applied sum differs from total by %d", n)
	}
	// two lines of one method stay that method, not split.
	id2 := e.sale(o, pid, "card", 100000, 100000, []map[string]any{line("card", 30000), line("card", 70000)}, "")
	e.want("same-method order", e.orderDump(id2), "card|100000|0|false|")
}

// ── subtest 2 ──

func (e *spEnv) onlineShortfall() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	short := []map[string]any{line("qris", 30000), line("cash", 20000)}
	code, raw := e.direct(o, e.salePayload(pid, "split", 100000, 50000, 1, short), "sp-short-direct")
	if code != 422 {
		e.t.Fatalf("direct short split: want 422, got %d %s", code, raw)
	}
	if e.orderCount(o) != 0 || e.tenderRowCount(o) != 0 {
		e.t.Fatal("a rejected direct sale must leave no order or tender rows")
	}
	id := e.batchSale(o, e.salePayload(pid, "split", 100000, 50000, 1, short))
	e.want("batch order", e.orderDump(id), "split|50000|0|true|tender_short")
	e.want("cash carries the gap", e.tenderDump(id), "1|qris|30000|30000|0|;2|cash|70000|20000|0|")
}

// ── subtest 3 ──

func (e *spEnv) structuralRejects() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	big := 600000000000.0 // each line is under the money cap, the sum is over it
	cases := []struct {
		name    string
		paid    float64
		tenders []map[string]any
	}{
		{"5 lines", 100000, []map[string]any{line("qris", 20000), line("card", 20000), line("transfer", 20000), line("qris", 20000), line("card", 20000)}},
		{"zero line among two", 100000, []map[string]any{line("qris", 100000), line("cash", 0)}},
		{"method split", 100000, []map[string]any{line("split", 50000), line("cash", 50000)}},
		{"scalar split without tenders", 100000, nil},
		{"sum over the money cap", big * 2, []map[string]any{line("qris", big), line("card", big)}},
	}
	for i, c := range cases {
		code, raw := e.direct(o, e.salePayload(pid, "split", 100000, c.paid, 1, c.tenders), fmt.Sprintf("sp-struct-%d-%d", e.idN, i))
		if code != 400 {
			e.t.Fatalf("%s: direct want 400, got %d %s", c.name, code, raw)
		}
		res := e.batchItem(o, "order", e.newKey("order"), e.salePayload(pid, "split", 100000, c.paid, 1, c.tenders), "")
		if res["status"] != "error" || res["code"] != "rejected" || res["retryable"] != false {
			e.t.Fatalf("%s: batch want a non-retryable rejected item, got %v", c.name, res)
		}
	}
	if e.orderCount(o) != 0 || e.tenderRowCount(o) != 0 {
		e.t.Fatal("structural rejects must write no rows")
	}
	e.cashMerge(o, pid)
}

func (e *spEnv) cashMerge(o spOutlet, pid string) {
	two := []map[string]any{line("cash", 40000), line("qris", 30000), line("cash", 30000)}
	if code, raw := e.direct(o, e.salePayload(pid, "split", 100000, 100000, 1, two), e.newKey("two-cash")); code != 422 {
		e.t.Fatalf("two cash lines online: want 422, got %d %s", code, raw)
	}
	if e.orderCount(o) != 0 {
		e.t.Fatal("the online two-cash reject wrote an order")
	}
	id := e.batchSale(o, e.salePayload(pid, "split", 100000, 100000, 1, two))
	e.want("merged order", e.orderDump(id), "split|100000|0|true|tender_cash_merged")
	e.want("merged rows", e.tenderDump(id), "1|cash|70000|70000|0|;2|qris|30000|30000|0|")
}

// ── subtest 4 ──

func (e *spEnv) saleReplay() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	p := e.salePayload(pid, "split", 100000, 100000, 1, []map[string]any{line("qris", 60000), line("cash", 40000)})
	key := e.newKey("order")
	first := e.batchItem(o, "order", key, p, "")
	again := e.batchItem(o, "order", key, p, "")
	if first["status"] != "ok" || (again["status"] != "ok" && again["status"] != "duplicate") || again["orderId"] != first["orderId"] {
		e.t.Fatalf("replay: first %v again %v", first, again)
	}
	if e.orderCount(o) != 1 || e.tenderRowCount(o) != 2 {
		e.t.Fatalf("replay must keep one order with two lines, got %d orders %d lines", e.orderCount(o), e.tenderRowCount(o))
	}
	altered := e.salePayload(pid, "split", 100000, 100000, 1, []map[string]any{line("qris", 50000), line("cash", 50000)})
	altered["orderUuid"] = p["orderUuid"]
	// a sale's replay answers from the receipt: the original order comes back and the altered
	// split is never applied.
	res := e.batchItem(o, "order", key, altered, "")
	if res["orderId"] != first["orderId"] || (res["status"] != "ok" && res["status"] != "duplicate") {
		e.t.Fatalf("altered body under the same key: want the original order back, got %v", res)
	}
	if e.orderCount(o) != 1 {
		e.t.Fatal("an altered replay wrote an order")
	}
	e.want("original lines kept", e.tenderDump(first["orderId"].(string)), "1|qris|60000|60000|0|;2|cash|40000|40000|0|")
	dp := e.salePayload(pid, "split", 100000, 100000, 1, []map[string]any{line("qris", 60000), line("cash", 40000)})
	dk := e.newKey("direct-replay")
	c1, r1 := e.direct(o, dp, dk)
	c2, r2 := e.direct(o, dp, dk)
	if c1 != 201 || c2 != 201 || e.orderCount(o) != 2 {
		e.t.Fatalf("direct replay: %d %s / %d %s, orders %d", c1, r1, c2, r2, e.orderCount(o))
	}
}

// ── subtest 5 ──

func (e *spEnv) legacyIdentity() {
	o := e.newOutlet()
	pid := e.newProduct(o, 100000)
	cases := []struct {
		name        string
		method      string
		paid        float64
		wantOrder   string // "" = only compare, and require the flag
		wantFlagged bool
	}{
		{"cash exact", "cash", 100000, "cash|100000|0|false|", false},
		{"cash overpay gives change", "cash", 120000, "cash|120000|20000|false|", false},
		{"cash short flagged", "cash", 50000, "cash|50000|0|true|cash_short", true},
		{"qris exact", "qris", 100000, "qris|100000|0|false|", false},
		{"legacy non-cash zero accepted and flagged", "qris", 0, "", true},
	}
	for _, c := range cases {
		legacy := e.batchSale(o, e.salePayload(pid, c.method, 100000, c.paid, 1, nil))
		one := e.batchSale(o, e.salePayload(pid, c.method, 100000, c.paid, 1, []map[string]any{line(c.method, c.paid)}))
		e.want(c.name+" order row", e.orderDump(one), e.orderDump(legacy))
		e.want(c.name+" tender row", e.tenderDump(one), e.tenderDump(legacy))
		if c.wantOrder != "" {
			e.want(c.name+" expected", e.orderDump(legacy), c.wantOrder)
		}
		if c.wantFlagged != strings.Contains(e.orderDump(legacy), "|true|") {
			e.t.Fatalf("%s: flag mismatch: %s", c.name, e.orderDump(legacy))
		}
		if !strings.HasPrefix(e.tenderDump(legacy), "1|"+c.method+"|100000|") {
			e.t.Fatalf("%s: legacy sale must store one applied line of the total: %s", c.name, e.tenderDump(legacy))
		}
	}
}
