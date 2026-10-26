package main

import (
	"fmt"
	"slices"
)

type line struct {
	letter string
	qty    int
}

func (r *rt) receipt(kind, id, key string, lines []line) (resp, error) {
	var its []obj
	for _, l := range lines {
		it := r.items[l.letter]
		its = append(its, obj{"productId": it.ProductID, "variantSize": it.Size, "qty": l.qty})
	}
	h := map[string]string{"Idempotency-Key": key}
	return r.beMust("POST", fmt.Sprintf("/inventory/goods-receipt?kind=%s&id=%s", kind, id), h,
		obj{"supplier": "rehearsal", "note": "erp-rehearsal " + r.cfg.runID, "items": its})
}

func stepOpeningStock(r *rt) error {
	key := "rh-" + normID(r.cfg.runID) + "-open-outlet"
	first, err := r.receipt("outlet", r.outletID, key, []line{{"A", 10}, {"B", 1}, {"D", 10}})
	if err != nil {
		return err
	}
	again, err := r.receipt("outlet", r.outletID, key, []line{{"A", 10}, {"B", 1}, {"D", 10}})
	if err != nil {
		return fmt.Errorf("replay of the same Idempotency-Key: %w", err)
	}
	r.note("outlet receipt submitted twice with key %s: HTTP %d then %d (replay)", key, first.Code, again.Code)
	if _, err := r.receipt("warehouse", r.cfg.warehouseID, "rh-"+normID(r.cfg.runID)+"-open-wh", []line{{"C", 20}}); err != nil {
		return err
	}
	for _, l := range []string{"A", "B", "D"} {
		got, err := r.posOutletStock(r.items[l])
		if err != nil {
			return err
		}
		r.note("POS outlet stock %s = %d", r.items[l].fg.Code, got)
		if want := map[string]int{"A": 10, "B": 1, "D": 10}[l]; got != want {
			return fmt.Errorf("POS stock %s = %d after the double submit, want exactly %d", r.items[l].fg.Code, got, want)
		}
	}
	if err := r.relayDrain(); err != nil {
		return err
	}
	if err := r.wantReceiptDocs(); err != nil {
		return err
	}
	f := r.fgByLetter
	for l, q := range map[string]int{"A": 10, "B": 1, "D": 10} {
		if err := r.wantBal("outlet", r.cfg.outletCode, f(l), q); err != nil {
			return err
		}
	}
	return r.wantWarehouseHeld("receipt", "")
}

func (r *rt) fgByLetter(l string) fg { return r.items[l].fg }

// wantReceiptDocs asserts the outlet receipt (submitted twice) produced exactly one stub document.
func (r *rt) wantReceiptDocs() error {
	docs, err := r.stubDocs()
	if err != nil {
		return err
	}
	n := 0
	for _, d := range docs {
		if str(d, "kind") != "receipt" || str(d, "location", "code") != r.cfg.outletCode {
			continue
		}
		for _, l := range list(d, "body", "lines") {
			if str(l, "fg_code") == r.items["A"].fg.Code {
				n++
			}
		}
	}
	r.note("stub receipt documents at %s carrying %s: %d (want 1)", r.cfg.outletCode, r.items["A"].fg.Code, n)
	if n != 1 {
		return fmt.Errorf("%d receipt documents for the double-submitted receipt, want 1", n)
	}
	return nil
}

// ensureShift reuses the outlet's open shift or opens one (closed again at the end).
func (r *rt) ensureShift() error {
	if r.shiftID != "" {
		return nil
	}
	out, err := r.beMust("GET", "/shifts/current", nil, nil)
	if err != nil {
		return err
	}
	if id := str(out.Body, "data", "id"); id != "" {
		r.shiftID = id
		r.note("reusing open shift %s", id)
		return nil
	}
	id, err := r.onceRecover("POST", "/shifts", nil, obj{"startingCash": 0}, dataID, r.currentShiftID)
	if err != nil {
		return err
	}
	r.shiftID, r.shiftOpen = id, true
	r.note("opened shift %s", r.shiftID)
	return nil
}

func (r *rt) saleItem(ik string, lines []line) obj {
	var its []obj
	total := 0
	for _, l := range lines {
		it := r.items[l.letter]
		its = append(its, obj{"productId": it.ProductID, "productName": it.fg.Name, "variantSize": it.Size,
			"price": unitPrice, "quantity": l.qty, "subtotal": unitPrice * l.qty, "isBundle": false})
		total += unitPrice * l.qty
	}
	return obj{"type": "order", "idempotencyKey": ik, "payload": obj{
		"orderUuid": newUUID(), "paymentMethod": "cash", "amountPaid": total, "shiftId": r.shiftID, "items": its,
	}}
}

func (r *rt) batch(items ...obj) ([]obj, error) {
	out, err := r.beMust("POST", "/sync/batch", nil, obj{"items": items})
	if err != nil {
		return nil, err
	}
	res := list(out.Body, "data", "results")
	if len(res) != len(items) {
		return nil, fmt.Errorf("batch answered %d results for %d items", len(res), len(items))
	}
	return res, nil
}

// sell posts one sale and returns its order id and the item (for replays).
func (r *rt) sell(tag string, lines []line) (string, obj, error) {
	if err := r.ensureShift(); err != nil {
		return "", nil, err
	}
	item := r.saleItem("rh-"+normID(r.cfg.runID)+"-"+tag, lines)
	res, err := r.batch(item)
	if err != nil {
		return "", nil, err
	}
	if str(res[0], "status") != "ok" {
		return "", nil, fmt.Errorf("sale %s: status %q: %s", tag, str(res[0], "status"), str(res[0], "error"))
	}
	return str(res[0], "orderId"), item, nil
}

func stepSale(r *rt) error {
	order, item, err := r.sell("sale1", []line{{"A", 2}, {"B", 3}})
	if err != nil {
		return err
	}
	r.vars["sale"] = order
	r.note("order %s accepted (A x2, B x3; B stock was 1 so 2 units oversold)", order)
	row, err := r.outboxOne("sale", order)
	if err != nil {
		return err
	}
	r.vars["saleOutbox"], r.vars["saleDoc"] = str(row, "id"), str(row, "documentId")
	r.note("outbox %s document %s status=%s", str(row, "id"), str(row, "documentId"), str(row, "status"))
	res, err := r.batch(item)
	if err != nil {
		return err
	}
	if str(res[0], "status") != "duplicate" {
		return fmt.Errorf("replayed batch item status %q, want duplicate", str(res[0], "status"))
	}
	if _, err := r.outboxOne("sale", order); err != nil {
		return fmt.Errorf("after replay: %w", err)
	}
	a, _ := r.posOutletStock(r.items["A"])
	b, _ := r.posOutletStock(r.items["B"])
	r.note("replay of the same batch item: status=duplicate, still 1 outbox document; POS stock A=%d B=%d", a, b)
	if a != 8 || b != -2 {
		return fmt.Errorf("POS stock after sale+replay A=%d B=%d, want 8 and -2", a, b)
	}
	return r.dbSaleMovements(order)
}

func (r *rt) dbSaleMovements(order string) error {
	if r.db == nil {
		r.note("ledger movement count skipped (no REHEARSAL_DATABASE_URL)")
		return nil
	}
	var n, short int
	err := r.db.QueryRow(ctxT(), `SELECT count(*), count(*) FILTER (WHERE 'shortage' = ANY(flags))
		FROM stock_movements WHERE kind='sale' AND ref_id=$1::uuid`, order).Scan(&n, &short)
	if err != nil {
		return err
	}
	r.note("DB: sale movements for the order = %d, flagged shortage = %d (want 2 and 1)", n, short)
	if n != 2 || short != 1 {
		return fmt.Errorf("ledger holds %d sale movements (%d shortage), want 2 and 1", n, short)
	}
	return nil
}

func stepRelaySale(r *rt) error {
	if err := r.relayDrain(); err != nil {
		return err
	}
	if _, err := r.wantStatus(r.vars["saleOutbox"], "delivered"); err != nil {
		return err
	}
	docs, err := r.stubDocByID(r.vars["saleDoc"])
	if err != nil {
		return err
	}
	if len(docs) != 1 || str(docs[0], "kind") != "sale" {
		return fmt.Errorf("stub holds %d documents for %s, want 1 sale", len(docs), r.vars["saleDoc"])
	}
	var codes []string
	short := ""
	for _, l := range list(docs[0], "body", "lines") {
		codes = append(codes, str(l, "fg_code"))
		if fl, _ := get(l, "flags").([]any); slices.Contains(fl, any("shortage")) {
			short += str(l, "fg_code")
		}
	}
	r.note("stub document %s kind=sale lines=%v shortage-flag on %q", r.vars["saleDoc"], codes, short)
	if len(codes) != 2 || short != r.items["B"].fg.Code {
		return fmt.Errorf("stub lines %v, shortage on %q; want 2 lines and shortage only on %s", codes, short, r.items["B"].fg.Code)
	}
	if err := r.wantBal("outlet", r.cfg.outletCode, r.items["A"].fg, 8); err != nil {
		return err
	}
	return r.wantBal("outlet", r.cfg.outletCode, r.items["B"].fg, -2)
}

func stepReplay(r *rt) error {
	if err := r.retry(r.vars["saleOutbox"]); err != nil {
		return err
	}
	r.note("admin retry on the delivered sale document accepted")
	if err := r.relayDrain(); err != nil {
		return err
	}
	if _, err := r.wantStatus(r.vars["saleOutbox"], "replayed"); err != nil {
		return err
	}
	docs, err := r.stubDocByID(r.vars["saleDoc"])
	if err != nil {
		return err
	}
	if len(docs) != 1 {
		return fmt.Errorf("stub holds %d copies after the replay, want 1", len(docs))
	}
	if err := r.wantBal("outlet", r.cfg.outletCode, r.items["A"].fg, 8); err != nil {
		return err
	}
	return r.wantBal("outlet", r.cfg.outletCode, r.items["B"].fg, -2)
}

func stepRefund(r *rt) error {
	order := r.vars["sale"]
	item := obj{"type": "refund", "idempotencyKey": "rh-" + normID(r.cfg.runID) + "-refund1",
		"payload": obj{"orderId": order, "reason": "erp-rehearsal"}}
	res, err := r.batch(item)
	if err != nil {
		return err
	}
	if str(res[0], "status") != "ok" {
		return fmt.Errorf("refund status %q: %s", str(res[0], "status"), str(res[0], "error"))
	}
	row, err := r.outboxOne("refund", order)
	if err != nil {
		return err
	}
	r.note("refund accepted; outbox %s document %s", str(row, "id"), str(row, "documentId"))
	if err := r.relayDrain(); err != nil {
		return err
	}
	if _, err := r.wantStatus(str(row, "id"), "delivered"); err != nil {
		return err
	}
	if err := r.wantBal("outlet", r.cfg.outletCode, r.items["A"].fg, 10); err != nil {
		return err
	}
	return r.wantBal("outlet", r.cfg.outletCode, r.items["B"].fg, 1)
}
