package main

import (
	"fmt"
	"net/http"
)

// Lost replies on once-only writes (2026-10-25). call never replays a write that could
// apply twice (replaySafe), so a dropped reply there used to fail the step although the
// server had applied it (DEMO6: POST /transfers answered 201, the reply never arrived).
// onceRecover handles such a write: after a transport failure it asks landed whether the
// write took effect and, only when it did not, sends it once more. landed is called after
// the client has given up on the reply (tens of seconds), long after the server finished.

// onceRecover sends method path body once; idOf reads the result id from a 2xx answer;
// landed returns the id of the write if it took effect, "" if it did not.
func (r *rt) onceRecover(method, path string, h map[string]string, body any,
	idOf func(resp) string, landed func() (string, error)) (string, error) {
	out, err := r.beCall(method, path, h, body)
	if err != nil {
		id, ferr := landed()
		if ferr != nil {
			return "", fmt.Errorf("%s %s: %w (and checking whether it landed failed: %v)", method, redactQuery(path), err, ferr)
		}
		if id != "" {
			r.note("%s %s lost its reply (%v); it had landed: %s", method, redactQuery(path), err, id)
			return id, nil
		}
		r.note("%s %s lost its reply (%v) and had not landed; sending it once more", method, redactQuery(path), err)
		out, err = r.beCall(method, path, h, body)
	}
	if err != nil {
		return "", fmt.Errorf("%s %s: %w", method, redactQuery(path), err)
	}
	if !out.ok() {
		return "", fmt.Errorf("%s %s: %s", method, redactQuery(path), out.brief())
	}
	return idOf(out), nil
}

func dataID(out resp) string { return str(out.Body, "data", "id") }

// currentShiftID is the open shift at the active outlet, "" when none.
func (r *rt) currentShiftID() (string, error) {
	out, err := r.beMust("GET", "/shifts/current", nil, nil)
	if err != nil {
		return "", err
	}
	return str(out.Body, "data", "id"), nil
}

// transferByNote finds this run's draft warehouse -> outlet transfer by its run-unique note.
func (r *rt) transferByNote(note string) (string, error) {
	out, err := r.beMust("GET", fmt.Sprintf("/transfers?locKind=warehouse&locID=%s&status=draft&limit=100", r.cfg.warehouseID), nil, nil)
	if err != nil {
		return "", err
	}
	for _, t := range list(out.Body, "data") {
		if str(t, "note") == note {
			return str(t, "id"), nil
		}
	}
	return "", nil
}

// transferReceived reports "received" once the transfer is completed, "" otherwise.
func (r *rt) transferReceived(tid string) (string, error) {
	out, err := r.beMust("GET", "/transfers/"+tid, nil, nil)
	if err != nil {
		return "", err
	}
	if str(out.Body, "data", "status") == "completed" {
		return "received", nil
	}
	return "", nil
}

// productIDBySKU scans the product list for the product owning a variant with sku.
func (r *rt) productIDBySKU(sku string) (string, error) {
	for page := 1; page <= maxPages; page++ {
		out, err := r.beMust("GET", fmt.Sprintf("/products?outletId=all&limit=%d&page=%d", pageSize, page), nil, nil)
		if err != nil {
			return "", err
		}
		prods := list(out.Body, "data")
		for _, p := range prods {
			for _, v := range list(p, "variants") {
				if str(v, "sku") == sku {
					return str(p, "id"), nil
				}
			}
		}
		if len(prods) < pageSize {
			break
		}
	}
	return "", nil
}

// retryOutbox re-queues a dead outbox row. After a lost reply it asks again: 409 then
// means the row is no longer dead, i.e. the first request landed.
func (r *rt) retryOutbox(id string) error {
	path := "/admin/erp/outbox/" + id + "/retry"
	out, err := r.beCall("POST", path, nil, nil)
	if err != nil {
		r.note("POST %s lost its reply (%v); asking again", path, err)
		if out, err = r.beCall("POST", path, nil, nil); err == nil && out.Code == http.StatusConflict {
			r.note("the row is no longer dead: the first retry had landed")
			return nil
		}
	}
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	if !out.ok() {
		return fmt.Errorf("POST %s: %s", path, out.brief())
	}
	return nil
}
