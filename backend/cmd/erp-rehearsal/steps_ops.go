package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
)

func ctxT() context.Context { return context.Background() }

func stepTransfer(r *rt) error {
	c := r.items["C"]
	note := "erp-rehearsal " + r.cfg.runID // run-unique: finds the transfer after a lost reply
	body := obj{
		"source": obj{"kind": "warehouse", "id": r.cfg.warehouseID}, "dest": obj{"kind": "outlet", "id": r.outletID},
		"note": note, "items": []obj{{"productId": c.ProductID, "variantSize": c.Size, "qty": 10}},
	}
	tid, err := r.onceRecover("POST", "/transfers", nil, body, dataID, func() (string, error) { return r.transferByNote(note) })
	if err != nil {
		return err
	}
	r.note("transfer %s created (warehouse -> outlet, 10 x %s)", tid, c.fg.Code)
	h := map[string]string{"Idempotency-Key": "rh-" + normID(r.cfg.runID) + "-send1"}
	for i := 1; i <= 2; i++ {
		o, err := r.beMust("POST", "/transfers/"+tid+"/send", h, nil)
		if err != nil {
			return fmt.Errorf("send #%d: %w", i, err)
		}
		r.note("send #%d with the same Idempotency-Key: HTTP %d", i, o.Code)
	}
	outRow, err := r.outboxOne("transfer_out", tid)
	if err != nil {
		return err
	}
	recv := obj{"discrepancyReason": "rusak", "items": []obj{{"productId": c.ProductID, "variantSize": c.Size, "receivedQty": 9}}}
	if _, err := r.onceRecover("POST", "/transfers/"+tid+"/receive", nil, recv,
		func(resp) string { return "received" }, func() (string, error) { return r.transferReceived(tid) }); err != nil {
		return err
	}
	inRow, err := r.outboxOne("transfer_in", tid)
	if err != nil {
		return err
	}
	r.note("received 9 of 10 (backoffice path, no approval grant needed)")
	if err := r.relayDrain(); err != nil {
		return err
	}
	return r.checkTransferDocs(tid, outRow, inRow)
}

// checkTransferDocs: the ERP takes outlets only, so the warehouse transfer_out stays held in
// the POS outbox and only the outlet transfer_in reaches the stub.
func (r *rt) checkTransferDocs(tid string, outRow, inRow obj) error {
	if _, err := r.wantStatus(str(outRow, "id"), "held"); err != nil {
		return err
	}
	if err := r.wantWarehouseHeld("transfer_out", tid); err != nil {
		return err
	}
	if _, err := r.wantStatus(str(inRow, "id"), "delivered"); err != nil {
		return err
	}
	di, err := r.stubDocByID(str(inRow, "documentId"))
	if err != nil {
		return err
	}
	if len(di) != 1 {
		return fmt.Errorf("stub holds %d transfer_in documents, want 1", len(di))
	}
	if str(di[0], "kind") != "transfer_in" || str(di[0], "location", "code") != r.cfg.outletCode {
		return fmt.Errorf("unexpected transfer_in document: %v", di[0]["location"])
	}
	if str(di[0], "ref", "id") != tid {
		return fmt.Errorf("transfer_in ref id %q, want %s", str(di[0], "ref", "id"), tid)
	}
	r.note("transfer %s: transfer_out held at the warehouse, transfer_in delivered at outlet %s", tid, r.cfg.outletCode)
	ls := list(di[0], "body", "lines")
	if len(ls) != 1 {
		return fmt.Errorf("transfer_in has %d lines, want 1", len(ls))
	}
	fl, _ := get(ls[0], "flags").([]any)
	r.note("transfer_in line: qty=%d expected_qty=%d flags=%v", num(ls[0], "qty"), num(ls[0], "expected_qty"), fl)
	if num(ls[0], "qty") != 9 || num(ls[0], "expected_qty") != 10 || !slices.Contains(fl, any("variance")) {
		return fmt.Errorf("transfer_in line %v lacks qty 9 / expected 10 / variance flag", ls[0])
	}
	return r.wantBal("outlet", r.cfg.outletCode, r.items["C"].fg, 9)
}

func stepFault(r *rt) error {
	if _, err := r.stub.must("POST", "/_stub/fault?status=503&count=1", nil, nil); err != nil {
		return err
	}
	order, _, err := r.sell("fault1", []line{{"A", 1}})
	if err != nil {
		return err
	}
	row, err := r.outboxOne("sale", order)
	if err != nil {
		return err
	}
	rep, err := r.relay()
	if err != nil {
		return err
	}
	r.note("relay with the fault armed: %s", relaySummary(rep))
	id := str(row, "id")
	d, err := r.wantStatus(id, "pending")
	if err != nil {
		return err
	}
	r.note("after the 503: status=pending attempts=%d lastHttpStatus=%d lastError=%q nextAttemptAt=%s",
		num(d, "attempts"), num(d, "lastHttpStatus"), str(d, "lastError"), str(d, "nextAttemptAt"))
	if num(d, "attempts") != 1 || num(d, "lastHttpStatus") != 503 {
		return fmt.Errorf("attempts=%d http=%d, want 1 and 503", num(d, "attempts"), num(d, "lastHttpStatus"))
	}
	if err := r.wantBal("outlet", r.cfg.outletCode, r.items["A"].fg, 10); err != nil {
		return fmt.Errorf("a failed delivery moved the stub balance: %w", err)
	}
	return r.waitDelivered(id)
}

// waitDelivered polls the relay every 15 s (bounded by -fault-wait) until the document is delivered.
func (r *rt) waitDelivered(id string) error {
	deadline := time.Now().Add(r.cfg.faultWait)
	t0 := time.Now()
	for time.Now().Before(deadline) {
		rep, err := r.relay()
		if err != nil {
			return err
		}
		d, err := r.outboxDetail(id)
		if err != nil {
			return err
		}
		if str(d, "status") == "delivered" {
			r.note("delivered after %s (%s), final attempts=%d", time.Since(t0).Round(time.Second), relaySummary(rep), num(d, "attempts"))
			return r.wantBal("outlet", r.cfg.outletCode, r.items["A"].fg, 9)
		}
		time.Sleep(15 * time.Second)
	}
	return fmt.Errorf("document %s still not delivered after -fault-wait %s", id, r.cfg.faultWait)
}

// recodeFG sets the stub FG's code (same slug). Like the ERP, the stub still accepts an FG in
// trash (BR7), so an unknown fg_code is provoked by an ERP-side code change instead.
func (r *rt) recodeFG(f fg, code string) error {
	rec := fgRecord(f, time.Now().UTC().Format(time.RFC3339))
	rec["code"] = code
	_, err := r.stub.must("POST", "/_stub/fg", nil, rec)
	return err
}

func stepDeadLetter(r *rt) error {
	d := r.items["D"]
	if err := r.recodeFG(d.fg, d.fg.Code+"-X"); err != nil {
		return err
	}
	r.note("stub FG %s recoded to %s-X (no catalog pull is run until it is restored)", d.fg.Code, d.fg.Code)
	order, _, err := r.sell("dead1", []line{{"D", 1}})
	if err != nil {
		return err
	}
	row, err := r.outboxOne("sale", order)
	if err != nil {
		return err
	}
	id := str(row, "id")
	if err := r.relayDrain(); err != nil {
		return err
	}
	det, err := r.wantStatus(id, "dead")
	if err != nil {
		return err
	}
	r.note("dead: http=%d lastError=%q", num(det, "lastHttpStatus"), str(det, "lastError"))
	if num(det, "lastHttpStatus") != 422 {
		return fmt.Errorf("dead document http %d, want 422", num(det, "lastHttpStatus"))
	}
	if err := r.inDeadList(id); err != nil {
		return err
	}
	if err := r.recodeFG(d.fg, d.fg.Code); err != nil {
		return err
	}
	r.note("stub FG %s code restored; admin retry + relay", d.fg.Code)
	if err := r.retry(id); err != nil {
		return err
	}
	if err := r.relayDrain(); err != nil {
		return err
	}
	if _, err := r.wantStatus(id, "delivered"); err != nil {
		return err
	}
	return r.wantBal("outlet", r.cfg.outletCode, d.fg, 9)
}

// stepUnassignedOutlet: like the ERP, the stub refuses an outlet that is not set on the
// client with a 422 on location.code only. The relay holds the document (no attempt burned,
// body dropped) instead of dead-lettering it; once the outlet is assigned, a retry delivers it.
func stepUnassignedOutlet(r *rt) error {
	setAssigned := func(codes any) error {
		_, err := r.stub.must("POST", "/_stub/assigned-outlets", nil, obj{"codes": codes})
		return err
	}
	if err := setAssigned([]string{}); err != nil {
		return err
	}
	restored := false
	defer func() {
		if !restored {
			if err := setAssigned(nil); err != nil {
				r.note("WARNING: could not restore the stub outlet assignment: %v", err)
			}
		}
	}()
	r.note("stub: no outlet assigned to the client")
	a := r.items["A"].fg
	before, err := r.stubBal("outlet", r.cfg.outletCode, a.Code)
	if err != nil {
		return err
	}
	order, _, err := r.sell("unassigned1", []line{{"A", 1}})
	if err != nil {
		return err
	}
	row, err := r.outboxOne("sale", order)
	if err != nil {
		return err
	}
	id := str(row, "id")
	rep, err := r.relay() // one run: relayDrain would stop on the held document
	if err != nil {
		return err
	}
	r.note("relay: %s", relaySummary(rep))
	det, err := r.wantStatus(id, "held")
	if err != nil {
		return err
	}
	r.note("held: http=%d attempts=%d holdReason=%q", num(det, "lastHttpStatus"), num(det, "attempts"), str(det, "holdReason"))
	if num(det, "lastHttpStatus") != 422 || num(det, "attempts") != 0 || !strings.Contains(str(det, "holdReason"), "tidak diatur untuk client ini") {
		return fmt.Errorf("held document %s: want http 422, 0 attempts and the outlet-assignment reason", id)
	}
	if err := r.wantBal("outlet", r.cfg.outletCode, a, before); err != nil {
		return fmt.Errorf("a refused document moved the stub balance: %w", err)
	}
	if err := setAssigned(nil); err != nil {
		return err
	}
	restored = true
	r.note("stub: every outlet assigned again; admin retry + relay")
	if err := r.retry(id); err != nil {
		return err
	}
	if err := r.relayDrain(); err != nil {
		return err
	}
	if _, err := r.wantStatus(id, "delivered"); err != nil {
		return err
	}
	return r.wantBal("outlet", r.cfg.outletCode, a, before-1)
}

func (r *rt) inDeadList(id string) error {
	rows, err := r.outboxList("dead", "sale")
	if err != nil {
		return err
	}
	for _, it := range rows {
		if str(it, "id") == id {
			r.note("document visible in GET /admin/erp/outbox?status=dead&kind=sale (lastError=%q)", str(it, "lastError"))
			return nil
		}
	}
	return fmt.Errorf("dead document %s missing from the dead-letter list", id)
}

// stepDeleteGuard: ERP-linked variants cannot be removed at all (the ERP owns them), so the
// "variant still has stock" rule is shown on a throwaway non-ERP product, then cleaned up.
func stepDeleteGuard(r *rt) error {
	p, err := r.product(r.items["A"].ProductID)
	if err != nil {
		return err
	}
	name := "ERP Rehearsal " + r.cfg.runID + " guard"
	guardSKU := "RH-" + normID(r.cfg.runID) + "-GUARD" // unique: finds the product after a lost reply
	create := obj{"name": name, "brand": "Rehearsal", "categoryId": str(p, "categoryId"), "sellable": true, "isActive": true,
		"variants": []obj{
			{"size": "Guard", "price": 1000, "stock": 0, "sku": guardSKU},
			{"size": "Keep", "price": 1000, "stock": 0, "sku": "RH-" + normID(r.cfg.runID) + "-KEEP"},
		}}
	pid, err := r.onceRecover("POST", "/products", nil, create, dataID, func() (string, error) { return r.productIDBySKU(guardSKU) })
	if err != nil {
		return err
	}
	gp, err := r.product(pid)
	if err != nil {
		return err
	}
	var keepID string
	for _, v := range list(gp, "variants") {
		if str(v, "size") == "Keep" {
			keepID = str(v, "id")
		}
	}
	rc := obj{"items": []obj{{"productId": pid, "variantSize": "Guard", "qty": 2}}}
	rk := map[string]string{"Idempotency-Key": "rh-" + normID(r.cfg.runID) + "-guard-receipt"} // replay-safe
	if _, err := r.beMust("POST", fmt.Sprintf("/inventory/goods-receipt?kind=outlet&id=%s", r.outletID), rk, rc); err != nil {
		return err
	}
	r.note("throwaway product %s created, 2 units of variant Guard received at the outlet", pid)
	drop := pricedKeepOnly(gp, keepID)
	if err := r.expectStockConflict("PUT", "/products/"+pid, drop); err != nil {
		return err
	}
	if err := r.expectStockConflict("DELETE", "/products/"+pid, nil); err != nil {
		return err
	}
	r.cleanupGuard(pid, gp)
	return nil
}

func pricedKeepOnly(p obj, keepID string) obj {
	var vars []obj
	for _, v := range list(p, "variants") {
		if str(v, "id") == keepID {
			vars = append(vars, obj{"id": keepID, "size": str(v, "size"), "price": get(v, "price"), "stock": 0, "sku": str(v, "sku"), "barcode": str(v, "barcode")})
		}
	}
	return obj{"name": str(p, "name"), "brand": str(p, "brand"), "categoryId": str(p, "categoryId"), "sellable": true, "isActive": true, "variants": vars}
}

func (r *rt) expectStockConflict(method, path string, body any) error {
	out, err := r.beCall(method, path, nil, body)
	if err != nil {
		return err
	}
	r.note("%s %s -> %s", method, redactQuery(path), out.brief())
	if out.Code != 409 || !containsFold(out.Raw, "masih punya stok") {
		return fmt.Errorf("%s %s: want 409 with \"masih punya stok\", got %s", method, path, out.brief())
	}
	return nil
}

// cleanupGuard zeroes the throwaway product and tries to delete it; a product with stock
// history is refused (409, "riwayat stok"), so it is then left inactive instead. A last
// relay run moves its unmapped (non-ERP) documents to "held" so nothing stays pending.
func (r *rt) cleanupGuard(pid string, gp obj) {
	adj := obj{"productId": pid, "variantSize": "Guard", "newQty": 0, "reason": "erp-rehearsal cleanup"}
	if out, err := r.beCall("POST", fmt.Sprintf("/inventory/adjust?kind=outlet&id=%s", r.outletID), nil, adj); err != nil || !out.ok() {
		r.note("cleanup: zeroing Guard failed (%v %s)", err, out.brief())
	}
	out, err := r.beCall("DELETE", "/products/"+pid, nil, nil)
	switch {
	case err == nil && out.ok():
		r.note("throwaway product zeroed and deleted")
	default:
		body := pricedKeepOnly(gp, "")
		body["isActive"], body["sellable"] = false, false
		body["variants"] = allVariants(gp)
		if _, e := r.beMust("PUT", "/products/"+pid, nil, body); e != nil {
			r.note("cleanup: delete refused (%s) and deactivation failed (%v); remove product %s by hand", out.brief(), e, pid)
		} else {
			r.note("after zeroing, DELETE is still refused (%s): product kept INACTIVE instead (observation: stock history blocks hard delete)", out.brief())
		}
	}
	if rep, e := r.relay(); e == nil {
		r.note("final relay run (moves the unmapped throwaway documents to held): %s", relaySummary(rep))
	}
}

func allVariants(p obj) []obj {
	var vars []obj
	for _, v := range list(p, "variants") {
		vars = append(vars, obj{"id": str(v, "id"), "size": str(v, "size"), "price": get(v, "price"), "stock": 0, "sku": str(v, "sku"), "barcode": str(v, "barcode")})
	}
	return vars
}
