package handlers

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/read"
)

const (
	mvOutletA   = "00000000-0000-4000-8f69-0000000000a1"
	mvOutletB   = "00000000-0000-4000-8f69-0000000000a2"
	mvWarehouse = "00000000-0000-4000-8f69-0000000000b1"
	mvProductP  = "00000000-0000-4000-8f69-0000000000c1"
	mvProductQ  = "00000000-0000-4000-8f69-0000000000c2"
	mvUser      = "00000000-0000-4000-8f69-0000000000d1"
	mvAdjust    = "00000000-0000-4000-8f69-0000000000e1"
	mvSaleDoc   = "00000000-0000-4000-8f69-0000000000f3"
	mvBigOutlet = "00000000-0000-4000-8f69-0000000000a9"
)

// TestStockMovementsReadPostgres is the S1 (kartu stok) gate: the saldo chain, keyset paging,
// location scope, the CSV export, the giveaway filter and the date-range opening/closing, all over
// seeded ledger rows read through the real handlers.
func TestStockMovementsReadPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "MV", 26469)
	seq := mvSeed(t, ctx, pool)
	h := &Handlers{Repo: read.New(pool)}

	get := func(role, outlet, path string) *httptest.ResponseRecorder {
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				c := context.WithValue(r.Context(), auth.CtxRole, role)
				next.ServeHTTP(w, r.WithContext(context.WithValue(c, auth.CtxOutletID, outlet)))
			})
		})
		router.Get("/inventory/movements", h.ListStockMovements)
		router.Get("/inventory/movements/export", h.ExportStockMovements)
		router.Get("/inventory/movements/summary", h.LedgerMovementSummary)
		router.Get("/inventory/movements/summary/export", h.ExportMovementLedgerSummary)
		router.Get("/inventory/goods-receipts/{id}", h.GetGoodsReceipt)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}
	admin := func(path string) *httptest.ResponseRecorder { return get("admin", "", path) }
	sku := "locationType=outlet&locationId=" + mvOutletA + "&productId=" + mvProductP + "&variantSize=M"
	list := func(t *testing.T, q string) api.StockMovementPage {
		t.Helper()
		w := admin("/inventory/movements?" + q)
		if w.Code != 200 {
			t.Fatalf("list %s: %d %s", q, w.Code, w.Body.String())
		}
		var p api.StockMovementPage
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("saldo chain is continuous in seq order", func(t *testing.T) {
		p := list(t, sku+"&limit=200")
		if len(p.Data) != len(seq) {
			t.Fatalf("rows = %d, want %d", len(p.Data), len(seq))
		}
		for i := len(p.Data) - 1; i > 0; i-- { // data is newest first
			older, newer := p.Data[i], p.Data[i-1]
			if newer.QtyBefore != older.QtyAfter || newer.Seq <= older.Seq {
				t.Fatalf("chain broken between seq %d and %d", older.Seq, newer.Seq)
			}
		}
		for _, m := range p.Data {
			if m.QtyAfter != m.QtyBefore+m.Qty {
				t.Fatalf("seq %d: after != before+qty", m.Seq)
			}
		}
		s := p.Summary
		if s == nil || s.Opening != 0 || s.Closing != 23 || s.TotalIn != 39 || s.TotalOut != 16 {
			t.Fatalf("summary = %+v, want opening 0 in 39 out 16 closing 23", s)
		}
		if s.Opening+s.TotalIn-s.TotalOut != s.Closing || p.Data[0].QtyAfter != s.Closing {
			t.Fatal("saldo header does not reconcile with the chain")
		}
		if list(t, "locationType=outlet&locationId="+mvOutletA+"&limit=200").Summary != nil {
			t.Fatal("summary must be absent without a single SKU")
		}
	})

	t.Run("keyset paging has no duplicates and no gaps", func(t *testing.T) {
		var got []int64
		cursor := ""
		for page := 0; page < 20; page++ {
			q := sku + "&limit=7"
			if cursor != "" {
				q += "&cursor=" + url.QueryEscape(cursor)
			}
			p := list(t, q)
			for _, m := range p.Data {
				got = append(got, m.Seq)
			}
			if p.NextCursor == nil {
				break
			}
			if len(p.Data) != 7 {
				t.Fatalf("a page with a next cursor has %d rows", len(p.Data))
			}
			cursor = *p.NextCursor
		}
		if len(got) != len(seq) {
			t.Fatalf("paged %d rows, want %d", len(got), len(seq))
		}
		for i, s := range got {
			if want := seq[len(seq)-1-i]; s != want {
				t.Fatalf("position %d: seq %d, want %d (dup or gap)", i, s, want)
			}
		}
		if later := list(t, sku+"&limit=7&cursor="+url.QueryEscape(cursorAfter(t, list(t, sku+"&limit=7")))); later.Summary != nil {
			t.Fatal("the saldo header belongs to the first page only")
		}
		if w := admin("/inventory/movements?" + sku + "&cursor=!!"); w.Code != 400 {
			t.Fatalf("bad cursor: %d", w.Code)
		}
		if w := admin("/inventory/movements?" + sku + "&limit=201"); w.Code != 400 {
			t.Fatalf("limit 201: %d", w.Code)
		}
	})

	t.Run("outlet scope is enforced on every read", func(t *testing.T) {
		for _, ep := range []string{"/inventory/movements?", "/inventory/movements/summary?", "/inventory/movements/export?from=2026-01-01&to=2026-02-01&"} {
			q := ep + "locationType=outlet&locationId=" + mvOutletA
			if w := get("manager", mvOutletB, q); w.Code != 403 {
				t.Fatalf("%s other outlet: %d, want 403", ep, w.Code)
			}
			if w := get("manager", mvOutletA, q); w.Code != 200 {
				t.Fatalf("%s own outlet: %d %s", ep, w.Code, w.Body.String())
			}
			wh := ep + "locationType=warehouse&locationId=" + mvWarehouse
			if w := get("manager", mvOutletA, wh); w.Code != 200 {
				t.Fatalf("%s warehouse for an outlet user: %d, want 200 (permission-gated, no outlet binding)", ep, w.Code)
			}
			if w := get("admin", mvOutletB, q); w.Code != 200 {
				t.Fatalf("%s admin with another outlet selected in the switcher: %d, want 200", ep, w.Code)
			}
			if w := admin(wh); w.Code != 200 {
				t.Fatalf("%s warehouse for admin: %d", ep, w.Code)
			}
		}
		if w := admin("/inventory/movements?locationType=outlet&locationId=00000000-0000-4000-8f69-00000000ffff"); w.Code != 404 {
			t.Fatalf("unknown location: %d", w.Code)
		}
		other := list(t, "locationType=outlet&locationId="+mvOutletB+"&limit=200")
		if len(other.Data) != 1 || other.Data[0].LocationId.String() != mvOutletB {
			t.Fatalf("outlet B rows = %d, want only its own", len(other.Data))
		}
	})

	t.Run("giveaway, shortage and kind filters", func(t *testing.T) {
		only := list(t, sku+"&giveaway=true&limit=200")
		if len(only.Data) != 1 || !only.Data[0].IsGiveaway || only.Data[0].Qty != -1 {
			t.Fatalf("giveaway=true rows = %+v", only.Data)
		}
		if rest := list(t, sku+"&giveaway=false&limit=200"); len(rest.Data) != len(seq)-1 {
			t.Fatalf("giveaway=false rows = %d", len(rest.Data))
		}
		if all := list(t, sku+"&limit=200"); countGiveaway(all.Data) != 1 {
			t.Fatal("isGiveaway must be derived from the dedupe key for exactly one row")
		}
		short := list(t, sku+"&flag=shortage&limit=200")
		if len(short.Data) != 1 || short.Data[0].QtyAfter != -1 || short.Data[0].Flags[0] != "shortage" {
			t.Fatalf("shortage rows = %+v", short.Data)
		}
		kinds := list(t, sku+"&kind=opening&kind=adjust&limit=200")
		if len(kinds.Data) != 2 {
			t.Fatalf("kind filter rows = %d, want 2", len(kinds.Data))
		}
		if w := admin("/inventory/movements?" + sku + "&kind=bogus"); w.Code != 400 {
			t.Fatalf("bad kind: %d", w.Code)
		}
		// chips narrow the rows but not the saldo header
		if s := list(t, sku+"&kind=sale&limit=200").Summary; s == nil || s.Closing != 23 {
			t.Fatalf("summary must ignore chips, got %+v", s)
		}
	})

	t.Run("joins: names, barcode, actor, reason, ERP status", func(t *testing.T) {
		byKind := map[string]api.StockMovementRow{}
		for _, m := range list(t, sku+"&limit=200").Data {
			byKind[string(m.Kind)+strconv.Itoa(m.Qty)] = m
		}
		rc := byKind["receipt5"]
		if rc.ProductName == nil || *rc.ProductName != "MV kartu P" || rc.Barcode == nil || *rc.Barcode != "8990001" ||
			rc.Sku == nil || *rc.Sku != "MV-P-M" || rc.LocationName == nil || *rc.LocationName != "MV outlet A" ||
			rc.ActorName == nil || *rc.ActorName != "MV Petugas" {
			t.Fatalf("receipt joins = %+v", rc)
		}
		adj := byKind["adjust-3"]
		if adj.ReasonText == nil || *adj.ReasonText != "rusak kena air" {
			t.Fatalf("adjust reason = %+v", adj.ReasonText)
		}
		sale := byKind["sale-2"]
		if sale.ErpStatus == nil || *sale.ErpStatus != "delivered" || sale.RefNumber == nil || *sale.RefNumber != "INV-1" {
			t.Fatalf("sale ERP/ref = %+v", sale)
		}
	})

	t.Run("date range: opening and closing in the outlet timezone", func(t *testing.T) {
		// 2026-01-03 in WIB (+7) is 2026-01-02T17:00Z..2026-01-03T17:00Z of TIME RECORDED: four rows.
		p := list(t, sku+"&from=2026-01-03&to=2026-01-03&limit=200")
		if len(p.Data) != 4 { // sale, giveaway, adjust, shortage sale
			t.Fatalf("range rows = %d, want 4", len(p.Data))
		}
		s := p.Summary
		if s.Opening != 15 || s.Closing != -1 || s.TotalIn != 0 || s.TotalOut != 16 {
			t.Fatalf("range summary = %+v, want 15 -> -1, out 16", s)
		}
		empty := list(t, sku+"&from=2026-01-04&to=2026-01-04&limit=200")
		if len(empty.Data) != 0 || empty.Summary.Opening != -1 || empty.Summary.Closing != -1 ||
			empty.Summary.TotalIn != 0 || empty.Summary.TotalOut != 0 {
			t.Fatalf("empty range = %+v", empty)
		}
		inst := list(t, sku+"&from=2026-01-02T17:00:00Z&to=2026-01-03T17:00:00Z&limit=200")
		if len(inst.Data) != 4 {
			t.Fatalf("RFC 3339 range rows = %d, want 4", len(inst.Data))
		}
		if w := admin("/inventory/movements?" + sku + "&from=yesterday"); w.Code != 400 {
			t.Fatalf("bad date: %d", w.Code)
		}
	})

	t.Run("range selects by time recorded, the chain stays unbroken, late rows are badged", func(t *testing.T) {
		xl := "locationType=outlet&locationId=" + mvOutletA + "&productId=" + mvProductP + "&variantSize=XL"
		// Jan 3 (WIB): the offline sale occurred on Jan 2 but was recorded here; the sale that
		// occurred inside Jan 3 was recorded on Jan 4 and must not appear.
		day3 := list(t, xl+"&from=2026-01-03&to=2026-01-03&limit=200")
		if len(day3.Data) != 1 || day3.Data[0].Qty != -1 || day3.Data[0].QtyBefore != 4 {
			t.Fatalf("Jan 3 rows = %+v", day3.Data)
		}
		if s := day3.Summary; s.Opening != 4 || s.Closing != 3 || s.TotalIn != 0 || s.TotalOut != 1 {
			t.Fatalf("Jan 3 summary = %+v", s)
		}
		day4 := list(t, xl+"&from=2026-01-04&to=2026-01-04&limit=200")
		if len(day4.Data) != 1 || day4.Data[0].QtyBefore != 3 || day4.Summary.Opening != 3 || day4.Summary.Closing != 2 {
			t.Fatalf("Jan 4 = %+v / %+v", day4.Data, day4.Summary)
		}
		for _, r := range []string{"from=2026-01-03&to=2026-01-03", "from=2026-01-03&to=2026-01-04", "from=2026-01-05", "to=2026-01-02", "from=2026-01-10&to=2026-01-12", "from=2025-12-01&to=2025-12-31"} {
			p := list(t, xl+"&"+r+"&limit=200")
			s := p.Summary
			if s.Opening+s.TotalIn-s.TotalOut != s.Closing {
				t.Fatalf("%s: opening %d + in %d - out %d != closing %d", r, s.Opening, s.TotalIn, s.TotalOut, s.Closing)
			}
			if len(p.Data) > 0 && (p.Data[len(p.Data)-1].QtyBefore != s.Opening || p.Data[0].QtyAfter != s.Closing) {
				t.Fatalf("%s: header does not match the rows", r)
			}
		}
		if s := list(t, xl+"&from=2026-01-10&to=2026-01-12&limit=200").Summary; s.Opening != 2 || s.Closing != 2 {
			t.Fatalf("empty later range = %+v, want the balance 2", s)
		}
		if s := list(t, xl+"&from=2025-12-01&to=2025-12-31&limit=200").Summary; s.Opening != 0 || s.Closing != 0 {
			t.Fatalf("range before any row = %+v, want 0", s)
		}
		// the late badge is derived from the business days of occurredAt and recordedAt
		w := admin("/inventory/movements/export?" + xl + "&from=2026-01-03&to=2026-01-04")
		if w.Code != 200 || strings.Count(w.Body.String(), "Tercatat terlambat") != 2 {
			t.Fatalf("export late marks: %d %s", w.Code, w.Body.String())
		}
		// the ledger summary uses the same window and reconciles for every SKU
		for _, r := range []string{"from=2026-01-03&to=2026-01-03", "from=2026-01-04&to=2026-01-04", "from=2026-01-10", "to=2026-01-02"} {
			resp := admin("/inventory/movements/summary?locationType=outlet&locationId=" + mvOutletA + "&" + r)
			var sum api.MovementLedgerSummaryResponse
			if err := json.Unmarshal(resp.Body.Bytes(), &sum); err != nil || resp.Code != 200 {
				t.Fatalf("%s: %d %s", r, resp.Code, resp.Body.String())
			}
			for _, row := range sum.Data {
				if row.Opening+sumMap(row.InByKind)-sumMap(row.OutByKind) != row.Closing {
					t.Fatalf("%s: %s %s does not reconcile: %+v", r, row.ProductName, row.VariantSize, row)
				}
			}
		}
	})

	t.Run("consecutive days partition the ledger across midnight", func(t *testing.T) {
		s := "locationType=outlet&locationId=" + mvOutletA + "&productId=" + mvProductP + "&variantSize=S"
		summaryRow := func(r string) api.MovementLedgerSummaryRow {
			t.Helper()
			resp := admin("/inventory/movements/summary?locationType=outlet&locationId=" + mvOutletA + "&" + r + "&q=MV-P-S")
			var sum api.MovementLedgerSummaryResponse
			if err := json.Unmarshal(resp.Body.Bytes(), &sum); err != nil || resp.Code != 200 || len(sum.Data) > 1 {
				t.Fatalf("%s: %d %s", r, resp.Code, resp.Body.String())
			}
			if len(sum.Data) == 0 { // a SKU with no history yet has no line: balance 0
				return api.MovementLedgerSummaryRow{}
			}
			return sum.Data[0]
		}
		// Jan 3 holds no row of this SKU (both were taken after the boundary by seq), so its
		// closing is the carried balance; Jan 4 holds both, so its opening is that same balance.
		day3 := list(t, s+"&from=2026-01-03&to=2026-01-03&limit=200")
		day4 := list(t, s+"&from=2026-01-04&to=2026-01-04&limit=200")
		if len(day3.Data) != 0 || day3.Summary.Opening != 5 || day3.Summary.Closing != 5 {
			t.Fatalf("Jan 3 = %+v / %+v, want no rows and the carried balance 5", day3.Data, day3.Summary)
		}
		if len(day4.Data) != 2 || day4.Summary.Opening != 5 || day4.Summary.Closing != 3 || day4.Summary.TotalOut != 2 {
			t.Fatalf("Jan 4 = %d rows / %+v, want both rows, 5 -> 3", len(day4.Data), day4.Summary)
		}
		if day3.Summary.Closing != day4.Summary.Opening {
			t.Fatal("Jan 3 closing must equal Jan 4 opening")
		}
		both := list(t, s+"&from=2026-01-03&to=2026-01-04&limit=200")
		if len(both.Data) != len(day3.Data)+len(day4.Data) || both.Summary.Opening != 5 || both.Summary.Closing != 3 {
			t.Fatalf("Jan 3-4 = %d rows / %+v: the two days must add up with no row twice", len(both.Data), both.Summary)
		}
		// the card equals its summary row, on a busy day and on an empty window
		for _, r := range []string{"from=2026-01-03&to=2026-01-03", "from=2026-01-04&to=2026-01-04", "from=2026-01-10&to=2026-01-12", "from=2025-12-01&to=2025-12-31"} {
			card := list(t, s+"&"+r+"&limit=200").Summary
			row := summaryRow(r)
			if card.Opening != row.Opening || card.Closing != row.Closing ||
				card.TotalIn != sumMap(row.InByKind) || card.TotalOut != sumMap(row.OutByKind) {
				t.Fatalf("%s: card %+v != summary row %+v", r, card, row)
			}
		}
	})

	t.Run("the first morning pair after an empty midnight slice stays in its day", func(t *testing.T) {
		tt := "locationType=outlet&locationId=" + mvOutletA + "&productId=" + mvProductP + "&variantSize=T"
		day7 := list(t, tt+"&from=2026-01-07&to=2026-01-07&limit=200")
		day8 := list(t, tt+"&from=2026-01-08&to=2026-01-08&limit=200")
		if len(day7.Data) != 0 || day7.Summary.Opening != 6 || day7.Summary.Closing != 6 {
			t.Fatalf("Jan 7 = %d rows / %+v, want none and the carried balance 6", len(day7.Data), day7.Summary)
		}
		if len(day8.Data) != 2 || day8.Summary.Opening != 6 || day8.Summary.Closing != 4 || day8.Summary.TotalOut != 2 {
			t.Fatalf("Jan 8 = %d rows / %+v, want both rows, 6 -> 4 (the pair must not split across the boundary)", len(day8.Data), day8.Summary)
		}
		// instants resolve through the same boundary: an inverted instant range is empty, not an overlap
		inv := list(t, tt+"&from=2026-01-08T10:00:00Z&to=2026-01-08T01:00:00Z&limit=200")
		if len(inv.Data) != 0 || inv.Summary.Opening+inv.Summary.TotalIn-inv.Summary.TotalOut != inv.Summary.Closing {
			t.Fatalf("inverted instants = %d rows / %+v, want an empty window", len(inv.Data), inv.Summary)
		}
		// an instant exactly between the two rows of the pair still keeps them together
		mid := list(t, tt+"&from=2026-01-08T01:00:00.005Z&to=2026-01-09T00:00:00Z&limit=200")
		if len(mid.Data) != 2 {
			t.Fatalf("from between X and Y = %d rows, want 2 (b is the lowest seq of the first slice)", len(mid.Data))
		}
	})

	t.Run("csv export equals the JSON rows", func(t *testing.T) {
		q := "from=2026-01-01&to=2026-02-01&" + sku
		w := admin("/inventory/movements/export?" + q)
		if w.Code != 200 {
			t.Fatalf("export: %d %s", w.Code, w.Body.String())
		}
		if ct := w.Header().Get("Content-Type"); ct != "text/csv; charset=utf-8" {
			t.Fatalf("Content-Type = %q", ct)
		}
		recs, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		js := list(t, q+"&limit=200")
		if len(recs) != len(js.Data)+1 || strings.Join(recs[0], ",") != mvCSVColumns {
			t.Fatalf("csv has %d records for %d rows", len(recs), len(js.Data))
		}
		col := map[string]int{}
		for i, name := range recs[0] {
			col[name] = i
		}
		for i, m := range js.Data {
			rec := recs[i+1]
			in, out := 0, 0
			if rec[col["masuk"]] != "" {
				in, _ = strconv.Atoi(rec[col["masuk"]])
			}
			if rec[col["keluar"]] != "" {
				out, _ = strconv.Atoi(rec[col["keluar"]])
			}
			saldo, _ := strconv.Atoi(rec[col["saldo"]])
			if rec[col["id"]] != m.Id.String() || in-out != m.Qty || saldo != m.QtyAfter || rec[col["jenis"]] != string(m.Kind) {
				t.Fatalf("row %d differs: csv %v vs json %+v", i, rec, m)
			}
			if at, err := time.Parse(time.RFC3339, rec[col["waktu_kejadian"]]); err != nil || !at.Equal(m.OccurredAt) {
				t.Fatalf("row %d occurred_at differs", i)
			}
		}
		marks := map[string]int{}
		for _, rec := range recs[1:] {
			marks[rec[col["tanda"]]]++
		}
		if marks["Hadiah"] != 1 || marks["Minus"] != 1 {
			t.Fatalf("marks = %v", marks)
		}
		if w := admin("/inventory/movements/export?locationType=outlet&locationId=" + mvOutletA); w.Code != 400 {
			t.Fatalf("export without a range: %d", w.Code)
		}
		wide := "/inventory/movements/export?locationType=outlet&locationId=" + mvOutletA + "&from=2026-01-01&to=2026-06-01"
		if w := admin(wide); w.Code != 413 {
			t.Fatalf("export over 93 days: %d", w.Code)
		}
	})

	t.Run("a failure mid-export aborts the response instead of a short 200", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/inventory/movements/export?locationType=outlet&locationId="+mvOutletA+
			"&from=2026-01-01&to=2026-02-01&productId="+mvProductP+"&variantSize=M", nil)
		ctx := context.WithValue(req.Context(), auth.CtxRole, "admin")
		w := &failAfterFirstWrite{ResponseWriter: httptest.NewRecorder()}
		var aborted any
		func() {
			defer func() { aborted = recover() }()
			h.ExportStockMovements(w, req.WithContext(ctx))
		}()
		if aborted != http.ErrAbortHandler {
			t.Fatalf("recovered %v, want http.ErrAbortHandler", aborted)
		}
	})

	t.Run("sku picker is scoped, cheap and limited to ledger variants", func(t *testing.T) {
		type skuResp struct {
			Data []api.MovementSku `json:"data"`
		}
		call := func(role, outlet, q string) (int, skuResp) {
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					c := context.WithValue(r.Context(), auth.CtxRole, role)
					next.ServeHTTP(w, r.WithContext(context.WithValue(c, auth.CtxOutletID, outlet)))
				})
			})
			router.Get("/inventory/movements/skus", h.MovementSkus)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/inventory/movements/skus?"+q, nil))
			var out skuResp
			_ = json.Unmarshal(w.Body.Bytes(), &out)
			return w.Code, out
		}
		base := "locationType=outlet&locationId=" + mvOutletA
		if code, r := call("admin", "", base+"&q=mv-p"); code != 200 || len(r.Data) != 5 {
			t.Fatalf("q=mv-p: %d %+v (want sizes M, L, XL, S and T)", code, r.Data)
		}
		if _, r := call("admin", "", base+"&q=8990001"); len(r.Data) != 1 || r.Data[0].VariantSize != "M" {
			t.Fatalf("barcode search = %+v", r.Data)
		}
		if _, r := call("admin", "", base+"&q=kartu"); len(r.Data) != 5 {
			t.Fatalf("name search = %+v", r.Data)
		}
		// outlet B only has product P/M in its ledger
		if _, r := call("admin", "", "locationType=outlet&locationId="+mvOutletB+"&q=mv-"); len(r.Data) != 1 {
			t.Fatalf("outlet B skus = %+v", r.Data)
		}
		if _, r := call("admin", "", base+"&q="); len(r.Data) != 0 {
			t.Fatalf("empty q must return nothing, got %+v", r.Data)
		}
		if code, _ := call("manager", mvOutletB, base+"&q=mv"); code != 403 {
			t.Fatalf("other outlet: %d, want 403", code)
		}
	})

	t.Run("window boundary lookups stay bounded on a 200k-row location", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO outlets(id,name) VALUES($1,'MV big outlet')`, mvBigOutlet); err != nil {
			t.Fatal(err)
		}
		// one row a minute from 2025-01-01: about 139 days of a very busy location
		if _, err := pool.Exec(ctx, `INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,
		  qty,qty_before,qty_after,ref_type,occurred_at,recorded_at)
		  SELECT gen_random_uuid(),'mvbig:'||g,'receipt','outlet',$1::uuid,$2::uuid,'BIG',1,g-1,g,'goods_receipt',ts,ts
		  FROM (SELECT g, timestamptz '2025-01-01 00:00:00+00' + g * interval '1 minute' AS ts FROM generate_series(1,200000) g) x`,
			mvBigOutlet, mvProductP); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `ANALYZE stock_movements`); err != nil {
			t.Fatal(err)
		}
		mid := time.Date(2025, 3, 10, 0, 0, 0, 0, time.UTC)
		for name, probe := range map[string]struct {
			sql  string
			args []any
		}{
			"first": {read.BoundaryFirstSQL, []any{"outlet", mvBigOutlet, mid}},
			"slice": {read.BoundarySliceSQL, []any{"outlet", mvBigOutlet, mid, mid.Add(read.WindowSkew)}},
			"end":   {read.BoundaryEndSQL, []any{"outlet", mvBigOutlet}},
		} {
			plan := explain(t, ctx, pool, probe.sql, probe.args...)
			t.Logf("EXPLAIN %s probe:\n%s", name, plan)
			if strings.Contains(plan, "Seq Scan") {
				t.Fatalf("%s probe walks the table:\n%s", name, plan)
			}
			if name == "end" {
				continue
			}
			// both recorded_at probes must be bounded range lookups on the recorded index, with the
			// recorded_at bound in the index condition (not a filter over a seq walk)
			if !strings.Contains(plan, "stock_movements_loc_recorded") || !strings.Contains(plan, "Index Cond") ||
				!strings.Contains(plan, "recorded_at >=") {
				t.Fatalf("%s probe is not a recorded_at index range lookup:\n%s", name, plan)
			}
			if name == "slice" && !strings.Contains(plan, "recorded_at <") {
				t.Fatalf("slice probe has no upper recorded_at bound:\n%s", plan)
			}
		}
		started := time.Now()
		page := list(t, "locationType=outlet&locationId="+mvBigOutlet+"&from=2025-03-10&to=2025-03-10&limit=50")
		t.Logf("one-day page of a 200k-row location: %d rows in %s", len(page.Data), time.Since(started))
		if len(page.Data) != 50 {
			t.Fatalf("one-day page = %d rows, want 50", len(page.Data))
		}
		day := list(t, "locationType=outlet&locationId="+mvBigOutlet+"&productId="+mvProductP+"&variantSize=BIG&from=2025-03-10&to=2025-03-10&limit=1")
		// 2025-03-10 in WIB: 1440 minutes, one row each
		if s := day.Summary; s == nil || s.TotalIn != 1440 || s.Opening+s.TotalIn-s.TotalOut != s.Closing {
			t.Fatalf("one-day saldo = %+v, want 1440 in", s)
		}
	})

	t.Run("csv guards formula cells", func(t *testing.T) {
		w := admin("/inventory/movements/export?locationType=outlet&locationId=" + mvOutletA + "&from=2026-01-01&to=2026-02-01&productId=" + mvProductQ)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "'=SUM(A1)") {
			t.Fatalf("formula cell not guarded: %d %s", w.Code, w.Body.String())
		}
	})

	t.Run("ledger summary per SKU", func(t *testing.T) {
		w := admin("/inventory/movements/summary?locationType=outlet&locationId=" + mvOutletA)
		if w.Code != 200 {
			t.Fatalf("summary: %d %s", w.Code, w.Body.String())
		}
		var resp api.MovementLedgerSummaryResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		rows := map[string]api.MovementLedgerSummaryRow{}
		for _, r := range resp.Data {
			rows[r.ProductId.String()+"|"+r.VariantSize] = r
		}
		m := rows[mvProductP+"|M"]
		if m.Opening != 0 || m.Closing != 23 || m.InByKind["opening"] != 10 || m.InByKind["receipt"] != 29 ||
			m.OutByKind["sale"] != 13 || m.OutByKind["adjust"] != 3 {
			t.Fatalf("summary M = %+v", m)
		}
		if m.Opening+sumMap(m.InByKind)-sumMap(m.OutByKind) != m.Closing {
			t.Fatalf("summary M does not reconcile: %+v", m)
		}
		if resp.Meta.Total != 6 {
			t.Fatalf("total SKUs = %d, want 6", resp.Meta.Total)
		}
		// a range with no movement still lists the SKU with its carried balance
		w = admin("/inventory/movements/summary?locationType=outlet&locationId=" + mvOutletA + "&from=2026-01-04&to=2026-01-04&q=MV-P-M")
		var carried api.MovementLedgerSummaryResponse
		_ = json.Unmarshal(w.Body.Bytes(), &carried)
		if len(carried.Data) != 1 || carried.Data[0].Opening != -1 || carried.Data[0].Closing != -1 || len(carried.Data[0].InByKind) != 0 {
			t.Fatalf("carried summary = %s", w.Body.String())
		}
		if w = admin("/inventory/movements/summary?locationType=outlet&locationId=" + mvOutletA + "&q=zzz-nothing"); !strings.Contains(w.Body.String(), `"data":[]`) {
			t.Fatalf("q miss: %s", w.Body.String())
		}
	})

	t.Run("pergerakan buckets split by type, reconcile, and the export carries them", func(t *testing.T) {
		const (
			outC, prodR, whTransfer, outTransfer         = "00000000-0000-4000-8f69-0000000000a3", "00000000-0000-4000-8f69-0000000000c3", "00000000-0000-4000-8f69-0000000000f5", "00000000-0000-4000-8f69-0000000000f6"
			supplyReceipt, warrantyReceipt, backTransfer = "00000000-0000-4000-8f69-0000000000f7", "00000000-0000-4000-8f69-0000000000f8", "00000000-0000-4000-8f69-0000000000f9"
		)
		exec := func(sql string, args ...any) {
			t.Helper()
			if _, err := pool.Exec(ctx, sql, args...); err != nil {
				t.Fatalf("%v: %s", err, sql)
			}
		}
		exec(`INSERT INTO outlets(id,name) VALUES($1,'MV outlet C')`, outC)
		exec(`INSERT INTO products(id,name) VALUES($1,'MV bucket R')`, prodR)
		exec(`INSERT INTO product_variants(product_id,size,price,sku,barcode) VALUES($1,'M',100000,'MV-R-M','8990007')`, prodR)
		exec(`INSERT INTO goods_receipts(id,outlet_id,source) VALUES($1,$3,'supply'),($2,$3,'warranty')`, supplyReceipt, warrantyReceipt, outC)
		exec(`INSERT INTO transfers(id,status,source_warehouse_id,dest_outlet_id) VALUES($1,'received',$2,$3)`, whTransfer, mvWarehouse, outC)
		exec(`INSERT INTO transfers(id,status,source_outlet_id,dest_outlet_id) VALUES($1,'received',$2,$3)`, outTransfer, mvOutletB, outC)
		exec(`INSERT INTO transfers(id,status,source_outlet_id,dest_outlet_id) VALUES($1,'received',$2,$3)`, backTransfer, outC, mvOutletB)
		exec(`INSERT INTO goods_receipt_items(receipt_id,product_id,variant_size,qty,unit_cost) VALUES($1,$3,'M',3,12500.50),($2,$3,'M',5,NULL)`, warrantyReceipt, supplyReceipt, prodR)
		chain := 0
		n := 0
		put := func(kind string, qty int, refType, refID, dedupe string) {
			t.Helper()
			n++
			var ref any
			if refID != "" {
				ref = refID
			}
			if dedupe == "" {
				dedupe = fmt.Sprintf("mv-bucket:%d", n)
			}
			exec(`INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,
			  qty,qty_before,qty_after,ref_type,ref_id,occurred_at,flags,recorded_at)
			  VALUES(gen_random_uuid(),$1,$2,'outlet',$3,$4,'M',$5,$6,$7,$8,$9,'2026-02-01T03:00:00Z','{}','2026-02-01T03:00:00Z')`,
				dedupe, kind, outC, prodR, qty, chain, chain+qty, refType, ref)
			chain += qty
		}
		put("opening", 10, "backfill", "", "")
		put("receipt", 5, "goods_receipt", supplyReceipt, "")
		put("receipt", 3, "goods_receipt", warrantyReceipt, "")
		put("transfer_in", 4, "transfer", whTransfer, "")
		put("transfer_in", 2, "transfer", outTransfer, "")
		put("transfer_out", -1, "transfer", backTransfer, "")
		put("sale", -6, "order", "", "")
		put("refund", 1, "order", "", "")
		put("sale", -1, "order", "", "giveaway:00000000-0000-4000-8f69-0000000000ab")
		put("count", -2, "stock_count", "", "")
		put("write_off", -1, "stock_adjustment", "", "")

		w := admin("/inventory/movements/summary?locationType=outlet&locationId=" + outC + "&q=MV-R-M")
		var resp api.MovementLedgerSummaryResponse
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &resp) != nil || len(resp.Data) != 1 {
			t.Fatalf("summary: %d %s", w.Code, w.Body.String())
		}
		r := resp.Data[0]
		want := api.MovementBuckets{Masuk: 12, Penjualan: -6, Refund: 1, Transfer: 1, Penyesuaian: 7, Hadiah: -1}
		if r.Buckets != want || r.MasukGaransi != 3 || r.Opening != 0 || r.Closing != 14 {
			t.Fatalf("buckets = %+v garansi %d opening %d closing %d, want %+v garansi 3 closing 14", r.Buckets, r.MasukGaransi, r.Opening, r.Closing, want)
		}
		b := r.Buckets
		if r.Opening+b.Masuk+b.Penjualan+b.Refund+b.Transfer+b.Penyesuaian+b.Hadiah != r.Closing {
			t.Fatalf("opening + buckets != closing: %+v", r)
		}
		// every SKU of every location reconciles, whatever mix of rows it holds
		for _, loc := range []string{mvOutletA, mvOutletB, outC} {
			var all api.MovementLedgerSummaryResponse
			_ = json.Unmarshal(admin("/inventory/movements/summary?locationType=outlet&locationId="+loc).Body.Bytes(), &all)
			for _, row := range all.Data {
				bk := row.Buckets
				if row.Opening+bk.Masuk+bk.Penjualan+bk.Refund+bk.Transfer+bk.Penyesuaian+bk.Hadiah != row.Closing {
					t.Fatalf("%s %s|%s does not reconcile: %+v", loc, row.ProductId, row.VariantSize, row)
				}
			}
		}
		// the warehouse side: the same delivery leaves the warehouse as Transfer (never Masuk)
		var wh api.MovementLedgerSummaryResponse
		_ = json.Unmarshal(admin("/inventory/movements/summary?locationType=warehouse&locationId="+mvWarehouse).Body.Bytes(), &wh)
		for _, row := range wh.Data {
			if row.Buckets.Masuk != 0 {
				t.Fatalf("warehouse Masuk must stay 0 here: %+v", row)
			}
		}
		// kartu stok marks the warranty receipt
		var page api.StockMovementPage
		_ = json.Unmarshal(admin("/inventory/movements?locationType=outlet&locationId="+outC+"&productId="+prodR+"&variantSize=M&kind=receipt").Body.Bytes(), &page)
		warranty := 0
		for _, m := range page.Data {
			if m.IsWarranty != nil && *m.IsWarranty {
				warranty++
			}
		}
		if len(page.Data) != 2 || warranty != 1 {
			t.Fatalf("receipt rows = %d, warranty rows = %d, want 2 and 1", len(page.Data), warranty)
		}
		// the CSV export has the same numbers under the same bucket names
		ew := admin("/inventory/movements/summary/export?locationType=outlet&locationId=" + outC + "&from=2026-02-01&to=2026-02-01")
		if ew.Code != 200 || !strings.HasPrefix(ew.Header().Get("Content-Type"), "text/csv") {
			t.Fatalf("export: %d %s", ew.Code, ew.Body.String())
		}
		recs, err := csv.NewReader(strings.NewReader(ew.Body.String())).ReadAll()
		if err != nil || len(recs) != 2 {
			t.Fatalf("export csv: %v %q", err, ew.Body.String())
		}
		col := map[string]string{}
		for i, h := range recs[0] {
			col[h] = recs[1][i]
		}
		for k, v := range map[string]string{"saldo_awal": "0", "masuk": "12", "penjualan": "-6", "refund": "1", "transfer": "1",
			"penyesuaian": "7", "hadiah": "-1", "saldo_akhir": "14", "masuk_garansi": "3", "sku": "MV-R-M"} {
			if col[k] != v {
				t.Fatalf("export %s = %q, want %q (%v)", k, col[k], v, col)
			}
		}
		if bad := admin("/inventory/movements/summary/export?locationType=outlet&locationId=" + outC); bad.Code != 400 {
			t.Fatalf("export without a range: %d", bad.Code)
		}
		// the receipt document behind a kartu stok row: lines, source, scope
		gw := admin("/inventory/goods-receipts/" + warrantyReceipt)
		var gr api.GoodsReceiptDetail
		if gw.Code != 200 || json.Unmarshal(gw.Body.Bytes(), &gr) != nil || gr.Source != api.GoodsReceiptDetailSourceWarranty ||
			gr.LocationId.String() != outC || gr.LocationType != api.InventoryLocationTypeOutlet || len(gr.Items) != 1 || gr.Items[0].Qty != 3 {
			t.Fatalf("goods receipt: %d %s", gw.Code, gw.Body.String())
		}
		if w404 := admin("/inventory/goods-receipts/00000000-0000-4000-8f69-0000000000ff"); w404.Code != 404 {
			t.Fatalf("unknown receipt: %d", w404.Code)
		}
		if w403 := get("manager", mvOutletA, "/inventory/goods-receipts/"+warrantyReceipt); w403.Code != 403 {
			t.Fatalf("receipt of another outlet for a manager: %d", w403.Code)
		}
	})

	t.Run("audit trail: approved adjustment and count rows show approver, reason and ADJ number; PB transfers show the PB number", func(t *testing.T) {
		const (
			outC     = "00000000-0000-4000-8f69-0000000000a7"
			approver = "00000000-0000-4000-8f69-0000000000d7"
			adjReq   = "00000000-0000-4000-8f69-0000000000e7"
			adjDoc   = "00000000-0000-4000-8f69-0000000000e8"
			countID  = "00000000-0000-4000-8f69-0000000000e9"
			pbOld    = "00000000-0000-4000-8f69-0000000000ea"
			pbID     = "00000000-0000-4000-8f69-0000000000eb"
			trfOld   = "00000000-0000-4000-8f69-0000000000ec"
			trfNew   = "00000000-0000-4000-8f69-0000000000ed"
			trfPlain = "00000000-0000-4000-8f69-0000000000ee"
			count2ID = "00000000-0000-4000-8f69-0000000000f0"
		)
		must := func(sql string, args ...any) {
			t.Helper()
			if _, err := pool.Exec(ctx, sql, args...); err != nil {
				t.Fatalf("%v: %s", err, sql)
			}
		}
		must(`INSERT INTO outlets(id,name) VALUES($1,'MV outlet C')`, outC)
		must(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'mv-appr@example.test','x','MV Penyetuju','manager')`, approver)
		must(`INSERT INTO stock_adjustment_requests(id,number,status,outlet_id,product_id,variant_size,qty_at_request,requested_new_qty,
		        reason_code,reason_text,requested_by,approved_by,approved_at)
		      VALUES($1,'ADJ-MV-1','approved',$2,$3,'M',5,3,'damaged','kena air',$4,$4,now())`, adjReq, outC, mvProductP, mvUser)
		must(`INSERT INTO warehouse_stock_adjustments(id,outlet_id,product_id,variant_size,new_qty,reason,request_id,reason_code)
		      VALUES($1,$2,$3,'M',3,'kena air',$4,'damaged')`, adjDoc, outC, mvProductP, adjReq)
		must(`UPDATE stock_adjustment_requests SET approved_by=$2 WHERE id=$1`, adjReq, approver)
		must(`INSERT INTO stock_counts(id,name,status,outlet_id,approved_by,reason_code,reason_text)
		      VALUES($1,'MV opname','completed',$2,$3,'count_variance','selisih opname')`, countID, outC, approver)
		must(`INSERT INTO transfers(id,transfer_no,source_warehouse_id,dest_outlet_id) VALUES($1,'TRF-MV-1',$3,$4),($2,'TRF-MV-2',$3,$4),($5,'TRF-MV-3',$3,$4)`,
			trfOld, trfNew, mvWarehouse, outC, trfPlain)
		must(`INSERT INTO stock_requisitions(id,number,status,outlet_id,warehouse_id,requested_by,transfer_id)
		      VALUES($1,'PB-MV-1','fulfilled',$2,$3,$4,$5)`, pbID, outC, mvWarehouse, mvUser, trfNew)
		// a count whose line carries its own reason, different from the count-level one
		must(`INSERT INTO stock_counts(id,name,status,outlet_id,approved_by,reason_code,reason_text)
		      VALUES($1,'MV opname 2','completed',$2,$3,'count_variance','selisih opname')`, count2ID, outC, approver)
		must(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size,reason_code,reason_text)
		      VALUES($1,$2,'MV kartu P','M','damaged','rusak satu')`, count2ID, mvProductP)
		// a re-fulfilment: the PB links the latest transfer, the older cancelled one is in the event data
		must(`INSERT INTO inventory_doc_events(doc_type,doc_id,action,data) VALUES
		      ('requisition',$1,'fulfilled',jsonb_build_object('transferId',$2::text)),
		      ('requisition',$1,'refulfilled',jsonb_build_object('transferId',$3::text,'previousTransferId',$2::text))`, pbID, trfOld, trfNew)
		n := 0
		row := func(kind string, qty int, refType, refID, refNumber string) {
			t.Helper()
			n++
			must(`INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,
			        qty,qty_before,qty_after,ref_type,ref_id,ref_number,occurred_at,recorded_at,flags)
			      VALUES(gen_random_uuid(),$1,$2,'outlet',$3,$4,'M',$5,0,$5,$6,$7::uuid,NULLIF($8,''),'2026-02-01T00:00:00Z','2026-02-01T00:00:00Z','{}')`,
				fmt.Sprintf("mv-audit:%d", n), kind, outC, mvProductP, qty, refType, refID, refNumber)
		}
		row("adjust", -2, "stock_adjustment", adjDoc, "")
		row("count", 1, "stock_count", countID, "")
		row("count", 1, "stock_count", count2ID, "")
		row("transfer_in", 4, "transfer", trfOld, "TRF-MV-1")
		row("transfer_in", 4, "transfer", trfNew, "TRF-MV-2")
		row("transfer_in", 4, "transfer", trfPlain, "TRF-MV-3")
		row("receipt", 1, "goods_receipt", "00000000-0000-4000-8f69-0000000000ef", "")

		p := list(t, "locationType=outlet&locationId="+outC+"&limit=50")
		if len(p.Data) != 7 {
			t.Fatalf("rows = %d, want 7 (a duplicated row from a join fan-out?)", len(p.Data))
		}
		byRef := map[string]api.StockMovementRow{}
		for _, m := range p.Data {
			if m.RefId != nil {
				byRef[m.RefId.String()] = m
			}
		}
		str := func(v *string) string {
			if v == nil {
				return ""
			}
			return *v
		}
		adj := byRef[adjDoc]
		if str(adj.DocNumber) != "ADJ-MV-1" || str(adj.ApprovedByName) != "MV Penyetuju" || adj.ReasonCode == nil || *adj.ReasonCode != "damaged" || str(adj.ReasonText) != "kena air" {
			t.Fatalf("adjustment row = doc %q approver %q reason %v/%q", str(adj.DocNumber), str(adj.ApprovedByName), adj.ReasonCode, str(adj.ReasonText))
		}
		cnt := byRef[countID]
		if str(cnt.ApprovedByName) != "MV Penyetuju" || cnt.ReasonCode == nil || *cnt.ReasonCode != "count_variance" || str(cnt.ReasonText) != "selisih opname" || cnt.DocNumber != nil {
			t.Fatalf("count row = approver %q reason %v/%q doc %v", str(cnt.ApprovedByName), cnt.ReasonCode, str(cnt.ReasonText), cnt.DocNumber)
		}
		cnt2 := byRef[count2ID]
		if cnt2.ReasonCode == nil || *cnt2.ReasonCode != "damaged" || str(cnt2.ReasonText) != "rusak satu" {
			t.Fatalf("count row with a line reason = %v/%q, want the line pair damaged/rusak satu", cnt2.ReasonCode, str(cnt2.ReasonText))
		}
		// F3: every transfer ever linked by a fulfil/refulfil event shows the PB number (not only the latest one)
		for _, id := range []string{trfOld, trfNew} {
			if got := str(byRef[id].RequisitionNumber); got != "PB-MV-1" {
				t.Fatalf("transfer %s requisitionNumber = %q, want PB-MV-1", id, got)
			}
		}
		if plain := byRef[trfPlain]; plain.RequisitionNumber != nil || plain.ApprovedByName != nil || plain.DocNumber != nil || plain.ReasonCode != nil {
			t.Fatalf("a plain transfer row gained audit fields: %+v", plain)
		}
		if rc := byRef["00000000-0000-4000-8f69-0000000000ef"]; rc.RequisitionNumber != nil || rc.ApprovedByName != nil || rc.DocNumber != nil {
			t.Fatalf("a receipt row gained audit fields: %+v", rc)
		}
		// the PB lookup must use the 0075 expression index (seq scan off: the fixture table is tiny)
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		if _, err := conn.Exec(ctx, `SET enable_seqscan = off`); err != nil {
			t.Fatal(err)
		}
		rowsPlan, err := conn.Query(ctx, `EXPLAIN SELECT sr.number FROM inventory_doc_events e JOIN stock_requisitions sr ON sr.id = e.doc_id
		  WHERE e.doc_type='requisition' AND e.action IN ('fulfilled','refulfilled') AND e.data->>'transferId' = $1`, trfNew)
		if err != nil {
			t.Fatal(err)
		}
		var plan []string
		for rowsPlan.Next() {
			var l string
			if err := rowsPlan.Scan(&l); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, l)
		}
		rowsPlan.Close()
		planText := strings.Join(plan, " | ")
		if !strings.Contains(planText, "inventory_doc_events_transfer") {
			t.Fatalf("PB lookup does not use inventory_doc_events_transfer: %s", planText)
		}
		w := admin("/inventory/movements/export?locationType=outlet&locationId=" + outC + "&from=2026-01-31&to=2026-02-02")
		if w.Code != 200 {
			t.Fatalf("export: %d %s", w.Code, w.Body.String())
		}
		recs, err := csv.NewReader(strings.NewReader(w.Body.String())).ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		col := map[string]int{}
		for i, h := range recs[0] {
			col[h] = i
		}
		var sawAdj, sawPB bool
		for _, rec := range recs[1:] {
			sawAdj = sawAdj || (rec[col["no_adj"]] == "ADJ-MV-1" && rec[col["penyetuju"]] == "MV Penyetuju" && rec[col["kode_alasan"]] == "damaged")
			sawPB = sawPB || (rec[col["no_pb"]] == "PB-MV-1" && rec[col["no_dokumen"]] == "TRF-MV-2")
		}
		if !sawAdj || !sawPB {
			t.Fatalf("export lacks the audit columns (adj %v, pb %v): %s", sawAdj, sawPB, w.Body.String())
		}
	})
}

const mvCSVColumns = "id,waktu_kejadian,waktu_tercatat,jenis,dokumen,no_dokumen,lokasi,sku,barcode,produk,ukuran,masuk,keluar,saldo,oleh,alasan,kode_alasan,penyetuju,no_adj,no_pb,tanda,status_erp"

func cursorAfter(t *testing.T, p api.StockMovementPage) string {
	t.Helper()
	if p.NextCursor == nil {
		t.Fatal("expected a next cursor")
	}
	return *p.NextCursor
}

// failAfterFirstWrite lets the first body write through and fails the next one, like a client
// that disconnects mid-download.
type failAfterFirstWrite struct {
	http.ResponseWriter
	writes int
}

func (f *failAfterFirstWrite) Write(b []byte) (int, error) {
	f.writes++
	if f.writes > 1 {
		return 0, errors.New("client went away")
	}
	return f.ResponseWriter.Write(b)
}

// explain runs EXPLAIN (ANALYZE, BUFFERS) and returns the plan text.
func explain(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	rows, err := pool.Query(ctx, "EXPLAIN (ANALYZE, BUFFERS) "+sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return strings.Join(plan, "\n")
}

func countGiveaway(rows []api.StockMovementRow) int {
	n := 0
	for _, r := range rows {
		if r.IsGiveaway {
			n++
		}
	}
	return n
}

func sumMap(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

// mvSeed inserts the fixture and returns the seq values of SKU P/M in application order.
//
// SKU P/M at outlet A (WIB): opening +10 (Jan 1), receipt +5, adjust -3 and sale -2, giveaway -1,
// shortage sale -10 (all on Jan 3 WIB; the shortage sale is offline, so its occurred_at is earlier
// than the rows before it in seq), then 24 receipts of +1 from Jan 5. Closing 23.
func mvSeed(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []int64 {
	t.Helper()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v\n%s", err, sql)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'MV outlet A'),($2,'MV outlet B')`, mvOutletA, mvOutletB)
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'MV gudang')`, mvWarehouse)
	exec(`INSERT INTO products(id,name) VALUES($1,'MV kartu P'),($2,'=SUM(A1)')`, mvProductP, mvProductQ)
	exec(`INSERT INTO product_variants(product_id,size,price,sku,barcode) VALUES
	      ($1,'M',100000,'MV-P-M','8990001'),($1,'L',100000,'MV-P-L','8990002'),($1,'XL',100000,'MV-P-XL','8990004'),($1,'S',100000,'MV-P-S','8990005'),($1,'T',100000,'MV-P-T','8990006'),
	      ($2,'M',100000,'MV-Q-M','8990003')`, mvProductP, mvProductQ)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'mv@example.test','x','MV Petugas','manager')`, mvUser)
	exec(`INSERT INTO warehouse_stock_adjustments(id,outlet_id,product_id,variant_size,new_qty,reason) VALUES($1,$2,$3,'M',12,'rusak kena air')`,
		mvAdjust, mvOutletA, mvProductP)

	var seqs []int64
	chain := map[string]int{}
	add := func(loc, locType, product, size, kind string, qty int, occurred string, opts mvOpts) int64 {
		t.Helper()
		key := loc + product + size
		before := chain[key]
		chain[key] = before + qty
		var s int64
		var doc any // nil lets the database mint a document id
		if opts.doc != "" {
			doc = opts.doc
		}
		dedupe := opts.dedupe
		if dedupe == "" {
			dedupe = fmt.Sprintf("mv:%s:%s:%s:%d:%s", loc, product, size, before, occurred)
		}
		refType := "order"
		if opts.refType != "" {
			refType = opts.refType
		}
		var refID, refNumber any
		if opts.refID != "" {
			refID = opts.refID
		}
		if opts.refNumber != "" {
			refNumber = opts.refNumber
		}
		flags := opts.flags
		if flags == nil {
			flags = []string{}
		}
		var recorded any // nil: recorded when it occurred
		if opts.recorded != "" {
			recorded = opts.recorded
		}
		var actor any
		if opts.actor != "" {
			actor = opts.actor
		}
		err := pool.QueryRow(ctx, `INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,
		  qty,qty_before,qty_after,ref_type,ref_id,ref_number,actor,occurred_at,flags,recorded_at)
		  VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17::timestamptz,$15::timestamptz)) RETURNING seq`,
			doc, dedupe, kind, locType, loc, product, size, qty, before, before+qty, refType, refID, refNumber, actor, occurred, flags, recorded).Scan(&s)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	rec := func(kind string, qty int, at string, o mvOpts) {
		seqs = append(seqs, add(mvOutletA, "outlet", mvProductP, "M", kind, qty, at, o))
	}
	// Rows are inserted in recorded order, like production (seq follows the transaction start).
	// P/XL: an offline sale that occurred on Jan 2 but was recorded inside Jan 3 (WIB), and a sale
	// that occurred inside Jan 3 but was recorded after it (Jan 4). Recorded time decides.
	rec("opening", 10, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvOutletA, "outlet", mvProductP, "L", "opening", 4, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvOutletA, "outlet", mvProductP, "XL", "opening", 4, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvOutletA, "outlet", mvProductP, "S", "opening", 5, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvOutletA, "outlet", mvProductP, "T", "opening", 6, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvOutletB, "outlet", mvProductP, "M", "opening", 9, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvWarehouse, "warehouse", mvProductP, "M", "opening", 50, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	rec("receipt", 5, "2026-01-02T02:00:00Z", mvOpts{refType: "goods_receipt", actor: mvUser})
	add(mvOutletA, "outlet", mvProductQ, "M", "receipt", 2, "2026-01-02T10:00:00Z", mvOpts{refType: "goods_receipt"})
	rec("sale", -2, "2026-01-02T18:00:00Z", mvOpts{doc: mvSaleDoc, refID: mvSaleDoc, refNumber: "INV-1", dedupe: "sale:mv-1"})
	add(mvOutletA, "outlet", mvProductP, "XL", "sale", -1, "2026-01-02T10:00:00Z", mvOpts{recorded: "2026-01-03T03:00:00Z", dedupe: "sale:mv-xl-late-a"})
	rec("sale", -1, "2026-01-03T05:00:00Z", mvOpts{dedupe: "giveaway:00000000-0000-4000-8f69-0000000000aa", refNumber: "INV-1"})
	rec("adjust", -3, "2026-01-03T06:00:00Z", mvOpts{refType: "stock_adjustment", refID: mvAdjust, dedupe: "adjust:" + mvAdjust})
	// the shortage sale was rung offline: earlier occurred_at than the giveaway and adjust before it in seq
	rec("sale", -10, "2026-01-03T04:00:00Z", mvOpts{dedupe: "sale:mv-shortage", flags: []string{"shortage"}, recorded: "2026-01-03T07:00:00Z"})
	// P/S straddles midnight (WIB): B was recorded 00:00:01 on Jan 4 and took its seq first; A was
	// recorded 23:59:58 on Jan 3 but took its seq after B (it waited on a lock). Seq decides.
	add(mvOutletA, "outlet", mvProductP, "S", "sale", -1, "2026-01-03T16:59:00Z", mvOpts{recorded: "2026-01-03T17:00:01Z", dedupe: "sale:mv-mid-b"})
	add(mvOutletA, "outlet", mvProductP, "S", "sale", -1, "2026-01-03T16:59:00Z", mvOpts{recorded: "2026-01-03T16:59:58Z", dedupe: "sale:mv-mid-a"})
	add(mvOutletA, "outlet", mvProductP, "XL", "sale", -1, "2026-01-03T12:00:00Z", mvOpts{recorded: "2026-01-04T02:00:00Z", dedupe: "sale:mv-xl-late-b"})
	for i := 0; i < 24; i++ {
		rec("receipt", 1, fmt.Sprintf("2026-01-05T%02d:00:00Z", i), mvOpts{refType: "goods_receipt"})
	}
	// P/T: the outlet is closed over midnight into Jan 8 (WIB), so no row is recorded near the day
	// boundary. The first morning pair is inverted: X started at 08:00:00.000 and Y at 08:00:00.010,
	// but Y took its seq first. Both belong to Jan 8 (the first row recorded in the new day is X,
	// whose seq is higher than Y's).
	add(mvOutletA, "outlet", mvProductP, "T", "sale", -1, "2026-01-08T01:00:00.010Z", mvOpts{recorded: "2026-01-08T01:00:00.010Z", dedupe: "sale:mv-morning-y"})
	add(mvOutletA, "outlet", mvProductP, "T", "sale", -1, "2026-01-08T01:00:00Z", mvOpts{recorded: "2026-01-08T01:00:00Z", dedupe: "sale:mv-morning-x"})
	exec(`INSERT INTO erp_outbox(document_id,doc_key,kind,location_type,location_id,ref_type,ref_id,status)
	      VALUES($1,'sale:mv-1','sale','outlet',$2,'order',$1,'delivered')`, mvSaleDoc, mvOutletA)
	return seqs
}

type mvOpts struct {
	doc, dedupe, refType, refID, refNumber, actor, recorded string
	flags                                                   []string
}
