package main

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	maxPages     = 10
	pageSize     = 200
	unitPrice    = 100000
	schedHeader  = "X-Scheduler-Secret"
	relayAttempt = 6
)

func (r *rt) sched() map[string]string { return map[string]string{schedHeader: r.cfg.schedToken} }

// login signs in as the admin and builds the backend client (token never printed).
func (r *rt) login() error {
	anon := r.client(r.cfg.backendURL, nil)
	out, err := anon.call("POST", "/api/v1/auth/login", nil, obj{"email": r.cfg.adminEmail, "password": r.cfg.adminPass})
	if err != nil {
		return fmt.Errorf("backend unreachable at %s: %w", hostOf(r.cfg.backendURL), err)
	}
	if !out.ok() {
		return fmt.Errorf("admin login failed: HTTP %d", out.Code)
	}
	tok := str(out.Body, "access")
	if tok == "" {
		tok = str(out.Body, "data", "access")
	}
	if tok == "" {
		return fmt.Errorf("admin login answered without an access token")
	}
	r.be = r.client(r.cfg.backendURL+"/api/v1", map[string]string{"Authorization": "Bearer " + tok})
	r.be.noCache = true
	return nil
}

// locateItems pages the product list (newest first, all outlets) until every run FG's
// variant (sku = FG code) is found, then records product/variant ids.
func (r *rt) locateItems(letters ...string) error {
	want := map[string]fg{}
	for _, f := range r.fgs {
		for _, l := range letters {
			if f.Letter == l {
				want[f.Code] = f
			}
		}
	}
	for page := 1; page <= maxPages && len(want) > 0; page++ {
		out, err := r.beMust("GET", fmt.Sprintf("/products?outletId=all&limit=%d&page=%d", pageSize, page), nil, nil)
		if err != nil {
			return err
		}
		prods := list(out.Body, "data")
		for _, p := range prods {
			for _, v := range list(p, "variants") {
				if f, ok := want[str(v, "sku")]; ok {
					r.items[f.Letter] = &item{fg: f, ProductID: str(p, "id"), VariantID: str(v, "id"), Size: str(v, "size")}
					delete(want, f.Code)
				}
			}
		}
		if len(prods) < pageSize {
			break
		}
	}
	if len(want) > 0 {
		var codes []string
		for c := range want {
			codes = append(codes, c)
		}
		return fmt.Errorf("no POS variant with sku %s (catalog pull did not create it)", strings.Join(codes, ", "))
	}
	return nil
}

func (r *rt) product(id string) (obj, error) {
	out, err := r.beMust("GET", "/products/"+id+"?outletId=all&_="+fmt.Sprint(time.Now().UnixNano()), nil, nil)
	if err != nil {
		return nil, err
	}
	p, _ := get(out.Body, "data").(map[string]any)
	return p, nil
}

func (r *rt) posOutletStock(it *item) (int, error) {
	out, err := r.beMust("GET", fmt.Sprintf("/products/%s?outletId=%s&_=%d", it.ProductID, r.outletID, time.Now().UnixNano()), nil, nil)
	if err != nil {
		return 0, err
	}
	for _, v := range list(out.Body, "data", "variants") {
		if str(v, "sku") == it.fg.Code {
			return num(v, "stock"), nil
		}
	}
	return 0, fmt.Errorf("variant %s not visible at the outlet (not sellable/available there)", it.fg.Code)
}

func (r *rt) posWarehouseStock(it *item) (int, error) {
	out, err := r.beMust("GET", "/warehouses/"+r.cfg.warehouseID+"/stock?_="+fmt.Sprint(time.Now().UnixNano()), nil, nil)
	if err != nil {
		return 0, err
	}
	for _, row := range list(out.Body, "data") {
		if str(row, "sku") == it.fg.Code {
			return num(row, "stock"), nil
		}
	}
	return 0, fmt.Errorf("variant %s missing from warehouse stock list", it.fg.Code)
}

// relay triggers one relay run through the scheduler endpoint and returns the report.
func (r *rt) relay() (obj, error) {
	out, err := r.be.call("POST", "/internal/erp/relay", r.sched(), nil)
	if err != nil {
		return nil, err
	}
	switch {
	case out.Code == 503:
		return nil, fmt.Errorf("relay endpoint answered 503: ERP_SCHEDULER_TOKEN is not set on the backend")
	case out.Code == 401:
		return nil, fmt.Errorf("relay endpoint answered 401: REHEARSAL_SCHEDULER_TOKEN does not match the backend")
	case !out.ok():
		return nil, fmt.Errorf("relay: %s", out.brief())
	}
	rep, _ := get(out.Body, "data").(map[string]any)
	if get(rep, "disabled") == true {
		return nil, fmt.Errorf("relay is disabled on the backend (%s): set ERP_RELAY_ENABLED=true", str(rep, "reason"))
	}
	return rep, nil
}

func relaySummary(rep obj) string {
	return fmt.Sprintf("claimed=%d delivered=%d replayed=%d held=%d retried=%d dead=%d",
		num(rep, "claimed"), num(rep, "delivered"), num(rep, "replayed"), num(rep, "held"), num(rep, "retried"), num(rep, "dead"))
}

// relayDrain runs the relay until a run claims nothing (bounded), failing with the
// operator hint when a document of this run's locations ends held.
func (r *rt) relayDrain() error {
	for i := 0; i < relayAttempt; i++ {
		rep, err := r.relay()
		if err != nil {
			return err
		}
		r.note("relay run %d: %s", i+1, relaySummary(rep))
		if num(rep, "held") > 0 {
			if err := r.checkHeld(); err != nil {
				return err
			}
		}
		if num(rep, "claimed") == 0 {
			return nil
		}
	}
	return nil
}

func (r *rt) locIDs() map[string]bool {
	return map[string]bool{r.outletID: true, r.cfg.warehouseID: true}
}

func (r *rt) checkHeld() error {
	items, err := r.outboxList("held", "")
	if err != nil {
		return err
	}
	for _, it := range items {
		if !r.locIDs()[str(it, "locationId")] || !r.createdSinceStart(it) || isWarehouseHold(it) {
			continue // a warehouse document is held by design: the ERP takes outlets only
		}
		return fmt.Errorf("document %s (%s at %s %s) is held: %s. Outlets are linked by the catalog pull (erp_code) "+
			"and must be assigned to the client on the ERP/stub (stub: -assigned-outlets or POST /_stub/assigned-outlets)",
			str(it, "id"), str(it, "kind"), str(it, "locationType"), str(it, "locationId"), str(it, "holdReason"))
	}
	return nil
}

// warehouseHoldMark is part of the relay's hold reason for a warehouse document (erp/payload.go).
const warehouseHoldMark = "ERP belum menerima dokumen gudang"

func isWarehouseHold(it obj) bool {
	return str(it, "locationType") == "warehouse" && strings.Contains(str(it, "holdReason"), warehouseHoldMark)
}

// wantWarehouseHeld asserts that this run's warehouse documents of kind (for refID when set)
// are held with the warehouse reason and never reached the stub.
func (r *rt) wantWarehouseHeld(kind, refID string) error {
	rows, err := r.outboxList("held", kind)
	if err != nil {
		return err
	}
	n := 0
	for _, it := range rows {
		if str(it, "locationId") != r.cfg.warehouseID || !r.createdSinceStart(it) || (refID != "" && str(it, "refId") != refID) {
			continue
		}
		if !isWarehouseHold(it) {
			return fmt.Errorf("warehouse %s document %s is held for another reason: %s", kind, str(it, "id"), str(it, "holdReason"))
		}
		docs, err := r.stubDocByID(str(it, "documentId"))
		if err != nil {
			return err
		}
		if len(docs) != 0 {
			return fmt.Errorf("held warehouse %s document %s reached the stub", kind, str(it, "id"))
		}
		n++
	}
	r.note("%d warehouse %s document(s) held (%q), none sent", n, kind, warehouseHoldMark)
	if n == 0 {
		return fmt.Errorf("no held warehouse %s document of this run", kind)
	}
	return nil
}

func (r *rt) createdSinceStart(it obj) bool {
	t, err := time.Parse(time.RFC3339Nano, str(it, "createdAt"))
	return err != nil || t.After(r.start.Add(-time.Minute))
}

// outboxList pages GET /admin/erp/outbox (newest first) for a status/kind filter.
func (r *rt) outboxList(status, kind string) ([]obj, error) {
	var all []obj
	for page := 1; page <= maxPages; page++ {
		q := url.Values{"limit": {fmt.Sprint(pageSize)}, "page": {fmt.Sprint(page)}}
		if status != "" {
			q.Set("status", status)
		}
		if kind != "" {
			q.Set("kind", kind)
		}
		out, err := r.beMust("GET", "/admin/erp/outbox?"+q.Encode(), nil, nil)
		if err != nil {
			return nil, err
		}
		rows := list(out.Body, "data")
		all = append(all, rows...)
		if len(rows) < pageSize {
			break
		}
	}
	return all, nil
}

// outboxFor finds the outbox rows of one document kind for a ref (order / transfer id).
func (r *rt) outboxFor(kind, refID string) ([]obj, error) {
	rows, err := r.outboxList("", kind)
	if err != nil {
		return nil, err
	}
	var out []obj
	for _, it := range rows {
		if str(it, "refId") == refID {
			out = append(out, it)
		}
	}
	return out, nil
}

func (r *rt) outboxOne(kind, refID string) (obj, error) {
	rows, err := r.outboxFor(kind, refID)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, fmt.Errorf("expected exactly 1 %s outbox document for %s, found %d", kind, refID, len(rows))
	}
	return rows[0], nil
}

func (r *rt) outboxDetail(id string) (obj, error) {
	out, err := r.beMust("GET", "/admin/erp/outbox/"+id, nil, nil)
	if err != nil {
		return nil, err
	}
	d, _ := get(out.Body, "data").(map[string]any)
	return d, nil
}

func (r *rt) wantStatus(id, want string) (obj, error) {
	d, err := r.outboxDetail(id)
	if err != nil {
		return nil, err
	}
	if got := str(d, "status"); got != want {
		return d, fmt.Errorf("outbox %s status %q, want %q (lastError %q, http %d)", id, got, want, str(d, "lastError"), num(d, "lastHttpStatus"))
	}
	return d, nil
}

func (r *rt) stubDocByID(docID string) ([]obj, error) {
	docs, err := r.stubDocs()
	if err != nil {
		return nil, err
	}
	var out []obj
	for _, d := range docs {
		if str(d, "document_id") == docID {
			out = append(out, d)
		}
	}
	return out, nil
}

func (r *rt) retry(id string) error { return r.retryOutbox(id) }
