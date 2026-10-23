package main

import (
	"fmt"
	"strings"
	"time"
)

func allSteps() []step {
	return []step{
		{"0", "preflight", stepPreflight},
		{"1", "seed the stub (3 FGs + outlet)", stepSeedStub},
		{"2", "first catalog pull (full locally)", stepFullPull},
		{"3", "new FG + incremental pull", stepIncrementalPull},
		{"4", "price variants, make sellable", stepPrice},
		{"5", "opening stock (idempotent receipts)", stepOpeningStock},
		{"6", "sale via /sync/batch (+replay)", stepSale},
		{"7", "relay: sale delivered", stepRelaySale},
		{"8", "admin retry -> replayed", stepReplay},
		{"9", "refund -> delivered, balances restored", stepRefund},
		{"10", "transfer warehouse -> outlet (variance)", stepTransfer},
		{"11", "fault 503 then recover", stepFault},
		{"12", "dead-letter 422 then fix", stepDeadLetter},
		{"13", "variant with stock cannot be deleted", stepDeleteGuard},
		{"14", "POS / stub agreement + ledger invariant", stepAgreement},
	}
}

func stepPreflight(r *rt) error {
	if err := r.login(); err != nil {
		return err
	}
	r.note("admin login ok at %s", hostOf(r.cfg.backendURL))
	if _, err := r.relay(); err != nil {
		return fmt.Errorf("ERP flags/relay not usable: %w", err)
	}
	r.note("relay endpoint reachable, scheduler secret accepted, relay enabled")
	if _, err := r.stub.must("GET", "/_stub/balances", nil, nil); err != nil {
		return fmt.Errorf("stub not usable (reachable? key accepted?): %w", err)
	}
	r.note("stub reachable at %s, key accepted", hostOf(r.cfg.stubURL))
	out, err := r.be.must("GET", "/outlets", nil, nil)
	if err != nil {
		return err
	}
	found := false
	for _, o := range list(out.Body, "data") {
		if strings.EqualFold(str(o, "code"), r.cfg.outletCode) {
			r.outletID, found = str(o, "id"), true
			r.outletSlg = outletSlugFor(r.cfg.outletCode, firstNonEmpty(str(o, "erpSlug"), r.cfg.outletSlug))
			r.vars["outletName"], r.vars["outletErpSlug"] = str(o, "name"), str(o, "erpSlug")
			r.outletRow = o
		}
	}
	if !found {
		return fmt.Errorf("no POS outlet with code %q", r.cfg.outletCode)
	}
	if err := r.requireFreshRunID(); err != nil {
		return err
	}
	r.note("outlet %s (id %s) found; stub slug %s (POS erp_slug %q)", r.cfg.outletCode, r.outletID, r.outletSlg, r.vars["outletErpSlug"])
	wh, err := r.be.must("GET", "/warehouses", nil, nil)
	if err != nil {
		return err
	}
	for _, w := range list(wh.Body, "data") {
		if str(w, "id") == r.cfg.warehouseID {
			r.note("warehouse %s (%s) found", r.cfg.warehouseID, str(w, "name"))
			return r.openDB()
		}
	}
	return fmt.Errorf("no POS warehouse with id %s", r.cfg.warehouseID)
}

// requireFreshRunID refuses a -run-id whose FGs already exist in the POS: steps 2-3
// assert NEW variants, so a reused id would fail there with a misleading message.
func (r *rt) requireFreshRunID() error {
	if err := r.locateItems("A", "D"); err == nil || len(r.items) > 0 {
		r.items = map[string]*item{}
		return fmt.Errorf("run id %q was already used on this backend (POS variant with sku %s or %s exists); pass a fresh -run-id",
			r.cfg.runID, r.fgs[0].Code, r.fgs[3].Code)
	}
	return nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func stepSeedStub(r *rt) error {
	stamp := time.Now().UTC().Format(time.RFC3339)
	for _, f := range r.fgs[:3] {
		if _, err := r.stub.must("POST", "/_stub/fg", nil, fgRecord(f, stamp)); err != nil {
			return err
		}
		r.note("stub FG upserted: %s (%s)", f.Code, f.Slug)
	}
	code := r.cfg.outletCode
	if ec := r.vars["outletErpSlug"]; ec != "" {
		r.note("POS outlet already linked to slug %s; reusing it", ec)
	}
	rec := outletRecord(r.outletSlg, code, r.vars["outletName"], stamp)
	// The pull copies name/address/phone onto the POS outlet: echo the POS values so a
	// rehearsal never blanks the real outlet's details.
	rec["address"], rec["phone"] = get(r.outletRow, "address"), get(r.outletRow, "phone")
	if out, err := r.stub.call("POST", "/_stub/outlet", nil, rec); err != nil || !out.ok() {
		if err == nil {
			err = fmt.Errorf("%s", out.brief())
		}
		return fmt.Errorf("stub outlet upsert (slug %s, code %s): %w", r.outletSlg, code, err)
	}
	r.note("stub outlet upserted: slug %s code %s", r.outletSlg, code)
	return nil
}

// pull runs a catalog pull through the scheduler endpoint and returns the run ids.
func (r *rt) pull(mode string) ([]string, error) {
	for try := 0; try < 4; try++ {
		out, err := r.be.call("POST", "/internal/erp/catalog-pull?mode="+mode, r.sched(), nil)
		if err != nil {
			return nil, err
		}
		if out.Code == 503 {
			return nil, fmt.Errorf("catalog pull answered 503: ERP_INTEGRATION_ENABLED is off or ERP_SCHEDULER_TOKEN unset")
		}
		if !out.ok() {
			return nil, fmt.Errorf("catalog pull: %s", out.brief())
		}
		body := out.Body
		if d := get(body, "data"); d != nil {
			body = d
		}
		if st := str(body, "status"); st == "skipped_locked" {
			time.Sleep(5 * time.Second)
			continue
		} else if st != "completed" {
			return nil, fmt.Errorf("catalog pull %s finished %q: %s", mode, st, out.brief())
		}
		var ids []string
		for _, res := range list(body, "resources") {
			r.note("pull %s %s: status=%s pages=%d upserted=%d tombstoned=%d run=%s", mode, str(res, "resource"),
				str(res, "status"), num(res, "pages"), num(res, "upserted"), num(res, "tombstoned"), str(res, "runId"))
			ids = append(ids, str(res, "resource"))
		}
		return ids, nil
	}
	return nil, fmt.Errorf("catalog pull stayed skipped_locked (another run holds the lock)")
}

func (r *rt) showRuns(mode string, resources []string) error {
	out, err := r.be.must("GET", "/admin/erp/sync-runs?limit=20", nil, nil)
	if err != nil {
		return err
	}
	runs := list(out.Body, "runs") // newest first
	if len(runs) == 0 {
		runs = list(out.Body, "data", "runs")
	}
	for _, res := range resources {
		hit := false
		for _, run := range runs {
			// An incremental request with no watermark yet runs (and is recorded) as full.
			if str(run, "resource") == res && (str(run, "mode") == mode || mode == "incremental" && str(run, "mode") == "full") {
				hit = true
				r.note("sync-run %s: resource=%s mode=%s status=%s pages=%d upserted=%d", str(run, "id"), res, str(run, "mode"), str(run, "status"), num(run, "pages"), num(run, "upserted"))
				if str(run, "status") != "completed" {
					return fmt.Errorf("latest %s %s run in /admin/erp/sync-runs is %q", mode, res, str(run, "status"))
				}
				break
			}
		}
		if !hit {
			return fmt.Errorf("no %s run for %s in /admin/erp/sync-runs", mode, res)
		}
	}
	return nil
}

func (r *rt) checkUnsellable(letters ...string) error {
	for _, l := range letters {
		it := r.items[l]
		p, err := r.product(it.ProductID)
		if err != nil {
			return err
		}
		for _, v := range list(p, "variants") {
			if str(v, "sku") != it.fg.Code {
				continue
			}
			if str(v, "erpSlug") != it.fg.Slug || num(v, "price") != 0 {
				return fmt.Errorf("variant %s: erpSlug %q price %d, want %q and 0", it.fg.Code, str(v, "erpSlug"), num(v, "price"), it.fg.Slug)
			}
			r.note("variant %s sku=%s size=%s erpSlug=%s price=0 (not sellable until priced)", it.VariantID, it.fg.Code, it.Size, it.fg.Slug)
		}
	}
	return nil
}

func stepFullPull(r *rt) error {
	mode := r.cfg.firstPull
	ids, err := r.pull(mode)
	if err != nil {
		return err
	}
	if err := r.showRuns(mode, ids); err != nil {
		return err
	}
	if err := r.locateItems("A", "B", "C"); err != nil {
		return err
	}
	if err := r.checkUnsellable("A", "B", "C"); err != nil {
		return err
	}
	out, err := r.be.must("GET", "/outlets", nil, nil)
	if err != nil {
		return err
	}
	for _, o := range list(out.Body, "data") {
		if str(o, "id") == r.outletID {
			if str(o, "erpSlug") != r.outletSlg {
				return fmt.Errorf("outlet %s erp_slug = %q after the pull, want %q", r.cfg.outletCode, str(o, "erpSlug"), r.outletSlg)
			}
			r.note("outlet %s linked: erpSlug=%s erpCode=%s", r.cfg.outletCode, str(o, "erpSlug"), str(o, "erpCode"))
		}
	}
	return nil
}

func stepIncrementalPull(r *rt) error {
	d := r.fgs[3]
	if _, err := r.stub.must("POST", "/_stub/fg", nil, fgRecord(d, time.Now().UTC().Format(time.RFC3339))); err != nil {
		return err
	}
	r.note("stub FG created at run time: %s", d.Code)
	ids, err := r.pull("incremental")
	if err != nil {
		return err
	}
	if err := r.showRuns("incremental", ids); err != nil {
		return err
	}
	if err := r.locateItems("D"); err != nil {
		return err
	}
	return r.checkUnsellable("D")
}

// pricedBody is the full product PUT body with the run variant priced and the product sellable.
func pricedBody(p obj, sku string, price int) obj {
	vars := []obj{}
	for _, v := range list(p, "variants") {
		pr := get(v, "basePrice")
		if pr == nil {
			pr = get(v, "price")
		}
		if str(v, "sku") == sku {
			pr = price
		}
		vars = append(vars, obj{"id": str(v, "id"), "size": str(v, "size"), "price": pr, "stock": 0, "sku": str(v, "sku"), "barcode": str(v, "barcode")})
	}
	body := obj{
		"name": str(p, "name"), "brand": str(p, "brand"), "categoryId": str(p, "categoryId"),
		"description": str(p, "description"), "sellable": true, "isActive": true,
		"isFeatured": get(p, "isFeatured") == true, "isFavourite": get(p, "isFavourite") == true,
		"variants": vars,
	}
	if imgs, ok := get(p, "images").([]any); ok {
		body["images"] = imgs
	}
	return body
}

func stepPrice(r *rt) error {
	for _, l := range []string{"A", "B", "C", "D"} {
		it := r.items[l]
		p, err := r.product(it.ProductID)
		if err != nil {
			return err
		}
		if _, err := r.beMust("PUT", "/products/"+it.ProductID, nil, pricedBody(p, it.fg.Code, unitPrice)); err != nil {
			return err
		}
		cfg := obj{"items": []obj{{"outletId": r.outletID, "variantSize": it.Size, "available": true}}}
		if _, err := r.beMust("PUT", "/products/"+it.ProductID+"/outlet-config", nil, cfg); err != nil {
			return err
		}
		r.note("%s priced %d and set available at outlet %s", it.fg.Code, unitPrice, r.cfg.outletCode)
	}
	for _, l := range []string{"A", "B", "C", "D"} {
		out, err := r.beMust("GET", fmt.Sprintf("/products/%s?outletId=%s&_=%d", r.items[l].ProductID, r.outletID, time.Now().UnixNano()), nil, nil)
		if err != nil {
			return err
		}
		ok := false
		for _, v := range list(out.Body, "data", "variants") {
			if str(v, "sku") == r.items[l].fg.Code && num(v, "price") == unitPrice {
				ok = true
			}
		}
		if !ok {
			return fmt.Errorf("%s is not visible/priced at the outlet after pricing", r.items[l].fg.Code)
		}
	}
	r.note("all 4 variants visible at the outlet at %d (tablet Sinkron would show them)", unitPrice)
	return nil
}
