package handlers

import (
	"context"
	"encoding/csv"
	"encoding/json"
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
)

// TestStockMovementsReadPostgres is the S1 (kartu stok) gate: the saldo chain, keyset paging,
// location scope, the CSV export, the giveaway filter and the date-range opening/closing, all over
// seeded ledger rows read through the real handlers.
func TestStockMovementsReadPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "MV", 56469)
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
			if w := get("manager", mvOutletA, wh); w.Code != 403 {
				t.Fatalf("%s warehouse for an outlet user: %d, want 403", ep, w.Code)
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
		// 2026-01-03 in WIB (+7) is 2026-01-02T17:00Z..2026-01-03T17:00Z: four rows (the last by
		// seq has the earliest occurred_at, an offline sale).
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
		if len(recs) != len(js.Data)+1 || strings.Join(recs[0], ",") != strings.Join(movementCSVHeader, ",") {
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
		if resp.Meta.Total != 3 {
			t.Fatalf("total SKUs = %d, want 3", resp.Meta.Total)
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
	      ($1,'M',100000,'MV-P-M','8990001'),($1,'L',100000,'MV-P-L','8990002'),($2,'M',100000,'MV-Q-M','8990003')`, mvProductP, mvProductQ)
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
		var actor any
		if opts.actor != "" {
			actor = opts.actor
		}
		err := pool.QueryRow(ctx, `INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,
		  qty,qty_before,qty_after,ref_type,ref_id,ref_number,actor,occurred_at,flags)
		  VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING seq`,
			doc, dedupe, kind, locType, loc, product, size, qty, before, before+qty, refType, refID, refNumber, actor, occurred, flags).Scan(&s)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	rec := func(kind string, qty int, at string, o mvOpts) {
		seqs = append(seqs, add(mvOutletA, "outlet", mvProductP, "M", kind, qty, at, o))
	}
	rec("opening", 10, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	rec("receipt", 5, "2026-01-02T02:00:00Z", mvOpts{refType: "goods_receipt", actor: mvUser})
	rec("sale", -2, "2026-01-02T18:00:00Z", mvOpts{doc: mvSaleDoc, refID: mvSaleDoc, refNumber: "INV-1", dedupe: "sale:mv-1"})
	rec("sale", -1, "2026-01-03T05:00:00Z", mvOpts{dedupe: "giveaway:00000000-0000-4000-8f69-0000000000aa", refNumber: "INV-1"})
	rec("adjust", -3, "2026-01-03T06:00:00Z", mvOpts{refType: "stock_adjustment", refID: mvAdjust, dedupe: "adjust:" + mvAdjust})
	// the shortage sale was rung offline: earlier occurred_at than the giveaway and adjust before it in seq
	rec("sale", -10, "2026-01-03T04:00:00Z", mvOpts{dedupe: "sale:mv-shortage", flags: []string{"shortage"}})
	for i := 0; i < 24; i++ {
		rec("receipt", 1, fmt.Sprintf("2026-01-05T%02d:00:00Z", i), mvOpts{refType: "goods_receipt"})
	}
	// other SKUs and locations
	add(mvOutletA, "outlet", mvProductP, "L", "opening", 4, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvOutletA, "outlet", mvProductQ, "M", "receipt", 2, "2026-01-02T10:00:00Z", mvOpts{refType: "goods_receipt"})
	add(mvOutletB, "outlet", mvProductP, "M", "opening", 9, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	add(mvWarehouse, "warehouse", mvProductP, "M", "opening", 50, "2026-01-01T10:00:00Z", mvOpts{refType: "backfill"})
	exec(`INSERT INTO erp_outbox(document_id,doc_key,kind,location_type,location_id,ref_type,ref_id,status)
	      VALUES($1,'sale:mv-1','sale','outlet',$2,'order',$1,'delivered')`, mvSaleDoc, mvOutletA)
	return seqs
}

type mvOpts struct {
	doc, dedupe, refType, refID, refNumber, actor string
	flags                                         []string
}
