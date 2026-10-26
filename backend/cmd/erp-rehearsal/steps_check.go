package main

import (
	"fmt"
	"strings"
)

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

// stepAgreement compares POS and stub for every run FG and checks the document trail.
func stepAgreement(r *rt) error {
	if len(r.items) < 4 {
		return fmt.Errorf("catalog steps did not complete; nothing to compare")
	}
	defer r.closeShift()
	if err := r.agreeBalances(); err != nil {
		return err
	}
	if err := r.agreeDocuments(); err != nil {
		return err
	}
	return r.dbChecks()
}

// closeShift closes the shift this run opened (best effort; a reused shift is left alone).
func (r *rt) closeShift() {
	if !r.shiftOpen {
		return
	}
	body := obj{"shiftId": r.shiftID, "closingCash": 0, "countedByMethod": obj{}}
	out, err := r.beCall("POST", "/shifts/"+r.shiftID+"/close", nil, body)
	if err != nil || !out.ok() {
		r.note("could not close the shift this run opened (%v %s); close it in the backoffice", err, out.brief())
		return
	}
	r.note("closed the shift this run opened")
}

func (r *rt) agreeBalances() error {
	codes := make([]string, 0, 4)
	for _, f := range r.fgs {
		codes = append(codes, f.Code)
	}
	out, err := r.stub.must("GET", "/api/integration/v1/outlets/"+r.cfg.outletCode+"/stock?fg_codes="+strings.Join(codes, ","), nil, nil)
	if err != nil {
		return err
	}
	body := out.Body
	if d := get(body, "data"); d != nil {
		body = d
	}
	apiQty := map[string]int{}
	for _, it := range list(body, "items") {
		apiQty[str(it, "fg_code")] = num(it, "qty")
	}
	for _, f := range r.fgs {
		it := r.items[f.Letter]
		posO, err := r.posOutletStock(it)
		if err != nil {
			return err
		}
		posW, err := r.posWarehouseStock(it)
		if err != nil {
			return err
		}
		stO, _ := r.stubBal("outlet", r.cfg.outletCode, f.Code)
		// Warehouse stock stays in the POS this phase (the ERP takes outlets only): shown, not compared.
		r.note("%s outlet POS=%d stub=%d stock-API=%d | warehouse POS=%d (not sent)", f.Code, posO, stO, apiQty[f.Code], posW)
		if posO != stO || posO != apiQty[f.Code] {
			return fmt.Errorf("%s disagrees: outlet POS=%d stub=%d stock-API=%d", f.Code, posO, stO, apiQty[f.Code])
		}
	}
	return nil
}

func (r *rt) agreeDocuments() error {
	stubIDs := map[string]bool{}
	docs, err := r.stubDocs()
	if err != nil {
		return err
	}
	for _, d := range docs {
		stubIDs[str(d, "document_id")] = true
	}
	delivered, bad := 0, 0
	for _, st := range []string{"delivered", "replayed", "pending", "sending", "dead"} {
		rows, err := r.outboxList(st, "")
		if err != nil {
			return err
		}
		for _, it := range rows {
			if !r.locIDs()[str(it, "locationId")] || !r.createdSinceStart(it) {
				continue
			}
			switch {
			case st == "delivered" || st == "replayed":
				delivered++
				if !stubIDs[str(it, "documentId")] {
					return fmt.Errorf("document %s (%s, %s) is %s in the POS but missing on the stub", str(it, "id"), str(it, "kind"), str(it, "refId"), st)
				}
			default:
				bad++
				r.note("document %s (%s) is %s, not delivered", str(it, "id"), str(it, "kind"), st)
			}
		}
	}
	r.note("%d delivered/replayed POS documents of this run are all present on the stub; %d not delivered", delivered, bad)
	if bad > 0 {
		return fmt.Errorf("%d documents of this run are not delivered", bad)
	}
	return nil
}

// dbChecks runs the read-only ledger checks when REHEARSAL_DATABASE_URL is set.
func (r *rt) dbChecks() error {
	if r.db == nil {
		r.note("DB invariant check skipped (no REHEARSAL_DATABASE_URL)")
		return nil
	}
	const invariant = `
WITH live AS (
  SELECT 'outlet' lt, outlet_id lid, product_id, variant_size, stock FROM outlet_variant_stock
  UNION ALL SELECT 'warehouse', warehouse_id, product_id, variant_size, stock FROM warehouse_variant_stock),
led AS (SELECT location_type lt, location_id lid, product_id, variant_size, sum(qty)::int s
          FROM stock_movements GROUP BY 1,2,3,4)
SELECT count(*) FROM live FULL JOIN led USING (lt, lid, product_id, variant_size)
 WHERE COALESCE(live.stock,0) <> COALESCE(led.s,0)`
	var n int
	if err := r.db.QueryRow(ctxT(), invariant).Scan(&n); err != nil {
		return fmt.Errorf("invariant query: %w", err)
	}
	r.note("DB invariant (plan 2.4): %d violating rows (want 0)", n)
	if n != 0 {
		return fmt.Errorf("ledger invariant broken: %d rows where live stock <> ledger sum", n)
	}
	for _, f := range r.fgs {
		it := r.items[f.Letter]
		var sum int
		if err := r.db.QueryRow(ctxT(), `SELECT COALESCE(sum(qty),0)::int FROM stock_movements
			WHERE location_type='outlet' AND location_id=$1::uuid AND product_id=$2::uuid AND variant_size=$3`,
			r.outletID, it.ProductID, it.Size).Scan(&sum); err != nil {
			return err
		}
		st, _ := r.stubBal("outlet", r.cfg.outletCode, f.Code)
		r.note("DB ledger sum outlet/%s %s = %d, stub = %d", r.cfg.outletCode, f.Code, sum, st)
		if sum != st {
			return fmt.Errorf("ledger sum %d != stub balance %d for %s at outlet %s", sum, st, f.Code, r.cfg.outletCode)
		}
	}
	return nil
}
