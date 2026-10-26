package erpstub

import (
	"net/http"
	"net/url"
	"sort"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

type stockPage struct {
	Outlet        erpapi.IntegrationOutletStockOutlet `json:"outlet"`
	Items         []erpapi.IntegrationOutletStockItem `json:"items"`
	LastUpdatedAt *time.Time                          `json:"last_updated_at"`
	NextCursor    *string                             `json:"next_cursor"`
	ServerTime    string                              `json:"server_time"`
}

func (s *Server) outletStock(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	q := r.URL.Query()
	s.mu.Lock()
	page, notFound, ds := s.buildStock(code, q)
	s.mu.Unlock()
	switch {
	case notFound:
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "outlet not found", nil)
	case len(ds) > 0:
		writeValidation(w, ds)
	default:
		page.ServerTime = s.now().UTC().Format(time.RFC3339Nano)
		writeCatalog(w, page)
	}
}

// buildStock computes the stock page for an outlet. Caller holds s.mu.
func (s *Server) buildStock(code string, q url.Values) (*stockPage, bool, []detail) {
	outlet := s.st.findOutlet(func(o *erpapi.IntegrationOutlet) bool { return o.Code == code })
	if outlet == nil {
		return nil, true, nil
	}
	page := &stockPage{Outlet: erpapi.IntegrationOutletStockOutlet{
		Slug: outlet.Slug, Code: outlet.Code, Name: outlet.Name,
		Type: erpapi.IntegrationOutletStockOutletType(outlet.Type),
	}}
	rows := outletRows(s.st, outlet.Code)
	page.LastUpdatedAt = latestUpdate(rows)

	var ds []detail
	if q.Has("fg_codes") {
		page.Items, ds = stockForCodes(s.st, rows, q)
	} else {
		page.Items, page.NextCursor, ds = stockPositive(s.st, rows, q)
	}
	return page, false, ds
}

func outletRows(st *state, outletCode string) map[string]*balance {
	rows := map[string]*balance{}
	for _, b := range st.Balances {
		if b.LocationType == "outlet" && b.LocationCode == outletCode {
			rows[b.FgCode] = b
		}
	}
	return rows
}

func latestUpdate(rows map[string]*balance) *time.Time {
	var max *time.Time
	for _, b := range rows {
		if max == nil || b.UpdatedAt.After(*max) {
			t := b.UpdatedAt
			max = &t
		}
	}
	return max
}

func stockItem(fg *erpapi.IntegrationFG, b *balance) erpapi.IntegrationOutletStockItem {
	it := erpapi.IntegrationOutletStockItem{FgSlug: fg.Slug, FgCode: fg.Code, FgName: fg.Name}
	if b != nil {
		t := b.UpdatedAt
		it.Qty, it.UpdatedAt = int(b.Qty), &t
	}
	return it
}

func stockForCodes(st *state, rows map[string]*balance, q url.Values) ([]erpapi.IntegrationOutletStockItem, []detail) {
	if q.Has("take") || q.Has("cursor") {
		return nil, []detail{{Path: "fg_codes", Message: "cannot be combined with take or cursor"}}
	}
	codes, d := parseCodeList(q.Get("fg_codes"), "fg_codes")
	if d != nil {
		return nil, []detail{*d}
	}
	items := make([]erpapi.IntegrationOutletStockItem, 0, len(codes))
	var ds []detail
	for _, c := range codes {
		fg := st.findFGByCode(c, false)
		if fg == nil {
			ds = append(ds, detail{Path: "fg_codes", Message: "unknown finished good " + c})
			continue
		}
		items = append(items, stockItem(fg, rows[c]))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].FgSlug < items[j].FgSlug })
	return items, ds
}

func stockPositive(st *state, rows map[string]*balance, q url.Values) ([]erpapi.IntegrationOutletStockItem, *string, []detail) {
	take, d := parseTake(q)
	if d != nil {
		return nil, nil, []detail{*d}
	}
	after := ""
	if q.Has("cursor") {
		c, err := decodeCursor(q.Get("cursor"))
		if err != nil || c.M != modeStock {
			return nil, nil, []detail{{Path: "cursor", Message: "invalid cursor for stock"}}
		}
		after = c.S
	}
	var all []erpapi.IntegrationOutletStockItem
	for code, b := range rows {
		fg := st.findFGByCode(code, true)
		if b.Qty > 0 && fg != nil && fg.Slug > after {
			all = append(all, stockItem(fg, b))
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].FgSlug < all[j].FgSlug })
	var next *string
	if len(all) > take {
		all = all[:take]
		c := encodeCursor(cursorToken{M: modeStock, S: all[len(all)-1].FgSlug})
		next = &c
	}
	if all == nil {
		all = []erpapi.IntegrationOutletStockItem{}
	}
	return all, next, nil
}
