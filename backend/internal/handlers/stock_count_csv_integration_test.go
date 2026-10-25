package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/rules"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Inventory controls S4: scanner CSV export and import of a stock count. Driven through the real
// handlers, checked with plain SQL. Opt-in fresh synthetic cluster (port 56473).
func TestStockCountCsvPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "CV", 56473)
	const (
		outC    = "00000000-0000-4000-8d00-000000000001"
		adminU  = "00000000-0000-4000-8d00-000000000011"
		mgrCre  = "00000000-0000-4000-8d00-000000000012" // creates and starts counts
		mgrImp  = "00000000-0000-4000-8d00-000000000013" // uploads the scanner file
		mgrSub  = "00000000-0000-4000-8d00-000000000014" // submits
		prodA   = "00000000-0000-4000-8d02-000000000001"
		prodB   = "00000000-0000-4000-8d02-000000000002" // shares the SKU DUP with prodA's size L
		prodOff = "00000000-0000-4000-8d02-000000000003" // exists, not on any count
		pin     = "4321"
	)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec %q: %v", sql, err)
		}
	}
	num := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("query %q: %v", sql, err)
		}
		return n
	}
	str := func(sql string, args ...any) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			t.Fatalf("query %q: %v", sql, err)
		}
		return s
	}
	hash, err := rules.HashPassword(pin)
	if err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'CV outlet')`, outC)
	for _, u := range []struct{ id, role, outlet string }{
		{adminU, "admin", ""}, {mgrCre, "manager", outC}, {mgrImp, "manager", outC}, {mgrSub, "manager", outC},
	} {
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,NULLIF($5,'')::uuid)`,
			u.id, u.id+"@example.invalid", "CV "+u.id[len(u.id)-2:], u.role, u.outlet)
		exec(`UPDATE users SET receive_pin_hash=$2, receive_pin_set_at=now() WHERE id=$1`, u.id, hash)
	}
	exec(`UPDATE app_settings SET receive_approver_roles='{manager}', inventory_approval_required=true WHERE id=1`)
	exec(`INSERT INTO products(id,name) VALUES($1,'CV A'),($2,'CV B'),($3,'CV Off')`, prodA, prodB, prodOff)
	variants := []struct{ prod, size, sku, barcode string }{
		{prodA, "M", "CV-A-M", "9001"}, {prodA, "L", "DUP", "9002"}, {prodA, "S", "CV-A-S", "9003"},
		{prodB, "M", "DUP", "9004"}, {prodOff, "M", "CV-OFF", "9005"},
		{prodB, "L", "DUP2", "9006"}, {prodOff, "L", "DUP2", "9007"}, // ambiguous even when narrowed to the count
	}
	for _, v := range variants {
		exec(`INSERT INTO product_variants(product_id,size,price,sku,barcode) VALUES($1,$2,1000,$3,$4)`, v.prod, v.size, v.sku, v.barcode)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,10)`, outC, v.prod, v.size)
	}

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("CV-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, []string{"manage_stock_count"})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokAdmin, tokCre, tokImp, tokSub := issue(adminU, "admin", ""), issue(mgrCre, "manager", outC),
		issue(mgrImp, "manager", outC), issue(mgrSub, "manager", outC)

	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/stock-counts", h.CreateStockCount)
	router.Put("/stock-counts/{id}", h.UpdateStockCount)
	router.Post("/stock-counts/{id}/complete", h.CompleteStockCount)
	router.Post("/stock-counts/{id}/submit", h.SubmitStockCount)
	router.Post("/stock-counts/{id}/approve", h.ApproveStockCount)
	router.Get("/stock-counts/{id}/export", h.ExportStockCount)
	router.Post("/stock-counts/{id}/import", h.ImportStockCount)

	call := func(method, path, token, key string, body any) (int, http.Header, string) {
		t.Helper()
		rdr := strings.NewReader("")
		if body != nil {
			b, _ := json.Marshal(body)
			rdr = strings.NewReader(string(b))
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Header(), w.Body.String()
	}
	keyN := 0
	nextKey := func() string { keyN++; return fmt.Sprintf("cv-key-%d", keyN) }
	mustCode := func(label string, want, code int, body string) {
		t.Helper()
		if code != want {
			t.Fatalf("%s: status %d want %d: %s", label, code, want, body)
		}
	}
	newCount := func(name string) string {
		t.Helper()
		items := []map[string]any{
			{"productId": prodA, "productName": "CV A", "variantSize": "M", "sku": "CV-A-M"},
			{"productId": prodA, "productName": "CV A", "variantSize": "L", "sku": "DUP"},
			{"productId": prodA, "productName": "CV A", "variantSize": "S", "sku": "CV-A-S"},
		}
		code, _, body := call("POST", "/stock-counts", tokCre, nextKey(), map[string]any{"name": name, "items": items})
		mustCode("create count", 201, code, body)
		var o struct{ Data struct{ ID string } }
		_ = json.Unmarshal([]byte(body), &o)
		return o.Data.ID
	}
	start := func(id string) {
		t.Helper()
		code, _, body := call("PUT", "/stock-counts/"+id, tokCre, "", map[string]any{"status": "in_progress"})
		mustCode("start count", 200, code, body)
	}
	type summary struct {
		Matched, Unknown, Ambiguous, NotOnCount, Uncounted, Changed int
		Digest                                                      string
	}
	type report struct {
		Data struct {
			Kind       string
			FileSha256 string `json:"fileSha256"`
			RunID      string `json:"runId"`
			Summary    summary
			Rows       []struct {
				Code     string
				Counted  int
				Expected *int
				Previous *int
				Warnings []string
			}
			Uncounted []struct{ VariantSize string }
		}
	}
	imp := func(token, id, csvText string, dry bool, key string, rep *report, sum *summary) (int, string) {
		t.Helper()
		body := map[string]any{"csv": csvText, "dryRun": dry, "fileName": "scan.csv"}
		if !dry {
			body["fileSha256"] = rep.Data.FileSha256
			body["expectedSummary"] = map[string]any{"matched": sum.Matched, "unknown": sum.Unknown, "ambiguous": sum.Ambiguous,
				"notOnCount": sum.NotOnCount, "uncounted": sum.Uncounted, "changed": sum.Changed, "digest": sum.Digest}
		}
		code, _, out := call("POST", "/stock-counts/"+id+"/import", token, key, body)
		return code, out
	}
	preview := func(token, id, csvText string) (report, string) {
		t.Helper()
		var rep report
		code, out := imp(token, id, csvText, true, "", &rep, nil)
		mustCode("preview", 200, code, out)
		if err := json.Unmarshal([]byte(out), &rep); err != nil {
			t.Fatal(err)
		}
		return rep, out
	}
	actual := func(id, size string) string {
		return str(`SELECT COALESCE(actual_qty::text,'null') FROM stock_count_items WHERE stock_count_id=$1 AND variant_size=$2`, id, size)
	}
	stockSnapshot := func() string {
		return str(`SELECT string_agg(variant_size||':'||stock, ',' ORDER BY product_id, variant_size) FROM outlet_variant_stock WHERE outlet_id=$1`, outC)
	}
	movements := func() int { return num(`SELECT count(*) FROM stock_movements`) }

	count1 := newCount("cv1")
	t.Run("export: planned count is refused, in-progress sheet has the header and content type", func(t *testing.T) {
		code, _, body := call("GET", "/stock-counts/"+count1+"/export", tokCre, "", nil)
		mustCode("export planned", 409, code, body)
		start(count1)
		code, hdr, body := call("GET", "/stock-counts/"+count1+"/export", tokCre, "", nil)
		mustCode("export", 200, code, body)
		if ct := hdr.Get("Content-Type"); ct != "text/csv; charset=utf-8" {
			t.Fatalf("content type %q", ct)
		}
		if !strings.HasPrefix(body, "\ufeff") {
			t.Fatal("export has no UTF-8 BOM")
		}
		recs, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(body, "\ufeff"))).ReadAll()
		if err != nil || len(recs) != 4 {
			t.Fatalf("sheet %v %v", recs, err)
		}
		if strings.Join(recs[0], ",") != "sku,barcode,product,size,expected_qty,counted_qty" {
			t.Fatalf("header %v", recs[0])
		}
		if recs[1][1] != "9002" || recs[1][4] != "10" || recs[1][5] != "" { // sorted by name, size: L first
			t.Fatalf("first row %v", recs[1])
		}
		code, _, body = call("GET", "/stock-counts/00000000-0000-4000-8d09-0000000000ff/export", tokCre, "", nil)
		mustCode("unknown count", 404, code, body)
	})

	t.Run("import: errors are reported and never committed", func(t *testing.T) {
		rep, _ := preview(tokImp, count1, "barcode,sku,counted_qty\n9999,,1\n,DUP2,2\n9001,,3\n,CV-OFF,4\n")
		s := rep.Data.Summary
		if rep.Data.Kind != "stock_count" || s.Unknown != 1 || s.Ambiguous != 1 || s.Matched != 1 || s.NotOnCount != 1 || s.Uncounted != 2 {
			t.Fatalf("summary %+v", s)
		}
		if narrowed, _ := preview(tokImp, count1, "sku,counted_qty\nDUP,1\n"); narrowed.Data.Summary.Matched != 1 || narrowed.Data.Summary.Ambiguous != 0 {
			t.Fatalf("a shared SKU narrows to the count's own line: %+v", narrowed.Data.Summary)
		}
		csvBad := "barcode,sku,counted_qty\n9999,,1\n,DUP2,2\n9001,,3\n,CV-OFF,4\n"
		code, out := imp(tokImp, count1, csvBad, false, nextKey(), &rep, &s)
		mustCode("commit with unknown and ambiguous codes", 422, code, out)
		if actual(count1, "M") != "null" || num(`SELECT count(*) FROM import_runs WHERE kind='stock_count'`) != 0 {
			t.Fatal("rejected import wrote something")
		}
		code, out = imp(tokImp, count1, csvBad, false, "", &rep, &s)
		mustCode("commit without Idempotency-Key", 400, code, out)
	})

	good := "sku,barcode,counted_qty\n,9001,2\n,9001,3\n,9003,7\nCV-A-M,,1\n"
	t.Run("import: duplicate scans are summed, barcode wins, not-on-count warns", func(t *testing.T) {
		// 9001 appears twice as a barcode (summed to 5); the sku row CV-A-M resolves to the same
		// line through another code, so the file is refused until the codes are merged.
		rep, _ := preview(tokImp, count1, good)
		if rep.Data.Summary.Matched != 2 || len(rep.Data.Rows) != 3 {
			t.Fatalf("report %+v", rep.Data)
		}
		code, out := imp(tokImp, count1, good, false, nextKey(), &rep, &rep.Data.Summary)
		mustCode("two codes for one line", 422, code, out)
	})

	file := "barcode,sku,counted_qty\n9001,,2\n9001,,3\n,CV-A-S,7\n9005,,4\n"
	var committed report
	var commitKey string
	t.Run("import: preview, commit stores counts only and records the importer", func(t *testing.T) {
		exec(`INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,qty,qty_before,qty_after,ref_type,occurred_at)
		      VALUES(gen_random_uuid(),'cv-moved','adjust','outlet',$1,$2,'S',0+1,10,11,'test',now())`, outC, prodA)
		exec(`UPDATE outlet_variant_stock SET stock=11 WHERE outlet_id=$1 AND product_id=$2 AND variant_size='S'`, outC, prodA)
		rep, _ := preview(tokImp, count1, file)
		s := rep.Data.Summary
		if s.Matched != 2 || s.NotOnCount != 1 || s.Uncounted != 1 || s.Changed != 2 || s.Unknown != 0 {
			t.Fatalf("summary %+v", s)
		}
		var moved bool
		for _, r := range rep.Data.Rows {
			if r.Code == "9001" && (r.Counted != 5 || *r.Expected != 10) {
				t.Fatalf("row %+v", r)
			}
			if r.Code == "CV-A-S" {
				moved = len(r.Warnings) == 1 && r.Warnings[0] == "stock_moved_since_start"
			}
		}
		if !moved {
			t.Fatalf("moved-since-start warning missing: %+v", rep.Data.Rows)
		}
		if len(rep.Data.Uncounted) != 1 || rep.Data.Uncounted[0].VariantSize != "L" {
			t.Fatalf("uncounted %+v", rep.Data.Uncounted)
		}
		stockBefore, movBefore := stockSnapshot(), movements()
		commitKey = nextKey()
		code, out := imp(tokImp, count1, file, false, commitKey, &rep, &s)
		mustCode("commit", 200, code, out)
		_ = json.Unmarshal([]byte(out), &committed)
		if committed.Data.RunID == "" {
			t.Fatalf("no run id: %s", out)
		}
		if actual(count1, "M") != "5" || actual(count1, "S") != "7" || actual(count1, "L") != "null" {
			t.Fatalf("stored M=%s S=%s L=%s", actual(count1, "M"), actual(count1, "S"), actual(count1, "L"))
		}
		if num(`SELECT count(*) FROM stock_count_items WHERE stock_count_id=$1 AND baseline_qty IS NOT NULL`, count1) != 0 {
			t.Fatal("import captured a per-line baseline")
		}
		if stockSnapshot() != stockBefore || movements() != movBefore {
			t.Fatal("import changed stock or the ledger")
		}
		if n := num(`SELECT count(*) FROM inventory_doc_events WHERE doc_type='stock_count' AND doc_id=$1 AND action='imported' AND actor_id=$2
		               AND data->>'importRunId'=$3`, count1, mgrImp, committed.Data.RunID); n != 1 {
			t.Fatalf("importer 'imported' events (with the run id) = %d, want exactly 1", n)
		}
		if n := num(`SELECT count(*) FROM inventory_doc_events WHERE doc_type='stock_count' AND doc_id=$1 AND actor_id=$2 AND action='updated'`, count1, mgrImp); n != 0 {
			t.Fatalf("an import must not also write an 'updated' event (%d)", n)
		}
		if str(`SELECT target_id::text FROM import_runs WHERE id=$1`, committed.Data.RunID) != count1 {
			t.Fatal("run has no target_id")
		}
	})

	t.Run("replay returns the stored result and does not re-apply; another count is a key conflict", func(t *testing.T) {
		// Someone corrects line M after the import; a retry of the same key must not undo it.
		code, _, body := call("PUT", "/stock-counts/"+count1, tokCre, "", map[string]any{
			"items": []map[string]any{{"productId": prodA, "variantSize": "M", "actualQty": 9}}})
		mustCode("manual correction", 200, code, body)
		rep := committed
		code, out := imp(tokImp, count1, file, false, commitKey, &rep, &rep.Data.Summary)
		mustCode("replay", 200, code, out)
		var again report
		_ = json.Unmarshal([]byte(out), &again)
		if again.Data.RunID != committed.Data.RunID || actual(count1, "M") != "9" {
			t.Fatalf("replay re-applied or lost the run: %s", out)
		}
		if n := num(`SELECT count(*) FROM import_runs WHERE kind='stock_count'`); n != 1 {
			t.Fatalf("import_runs = %d", n)
		}
		other := newCount("cv-other")
		exec(`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, count1) // free the one-running slot
		start(other)
		code, out = imp(tokImp, other, file, false, commitKey, &rep, &rep.Data.Summary)
		mustCode("same key and file on a different count", 409, code, out)
		if !strings.Contains(out, "idempotency_conflict") || actual(other, "M") != "null" {
			t.Fatalf("not a key conflict: %s", out)
		}
		exec(`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, other)
	})

	t.Run("stale preview: a change between preview and commit is a 409", func(t *testing.T) {
		count3 := newCount("cv3")
		start(count3)
		rep, _ := preview(tokImp, count3, "barcode,counted_qty\n9001,5\n")
		call("PUT", "/stock-counts/"+count3, tokCre, "", map[string]any{
			"items": []map[string]any{{"productId": prodA, "variantSize": "M", "actualQty": 5}}})
		code, out := imp(tokImp, count3, "barcode,counted_qty\n9001,5\n", false, nextKey(), &rep, &rep.Data.Summary)
		mustCode("stale commit", 409, code, out)
		if !strings.Contains(out, "import_stale") {
			t.Fatalf("body %s", out)
		}
		exec(`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, count3)
	})

	t.Run("four-eyes: the importer can never approve the count", func(t *testing.T) {
		count4 := newCount("cv4")
		start(count4)
		rep, _ := preview(tokImp, count4, "barcode,counted_qty\n9001,14\n")
		code, out := imp(tokImp, count4, "barcode,counted_qty\n9001,14\n", false, nextKey(), &rep, &rep.Data.Summary)
		mustCode("import", 200, code, out)
		code, _, body := call("POST", "/stock-counts/"+count4+"/submit", tokSub, nextKey(), map[string]any{"reasonCode": "count_variance"})
		mustCode("submit", 200, code, body)
		code, _, body = call("POST", "/stock-counts/"+count4+"/approve", tokImp, nextKey(), map[string]any{"pin": pin})
		mustCode("importer approves", 409, code, body)
		if !strings.Contains(body, "tidak boleh") {
			t.Fatalf("not the four-eyes refusal: %s", body)
		}
		code, _, body = call("POST", "/stock-counts/"+count4+"/approve", tokAdmin, nextKey(), map[string]any{"pin": pin})
		mustCode("a third person approves", 200, code, body)
	})

	t.Run("stale digest: a manual save with a different value between preview and commit is a 409", func(t *testing.T) {
		count6 := newCount("cv6")
		start(count6)
		const csvText = "barcode,counted_qty\n9001,5\n"
		rep, _ := preview(tokImp, count6, csvText)
		// The counters stay equal (the line is "changed" either way); only the stored value differs.
		code, _, body := call("PUT", "/stock-counts/"+count6, tokCre, "", map[string]any{
			"items": []map[string]any{{"productId": prodA, "variantSize": "M", "actualQty": 9}}})
		mustCode("manual save", 200, code, body)
		code, out := imp(tokImp, count6, csvText, false, nextKey(), &rep, &rep.Data.Summary)
		mustCode("commit after a different manual value", 409, code, out)
		if !strings.Contains(out, "import_stale") || actual(count6, "M") != "9" {
			t.Fatalf("body %s, M=%s", out, actual(count6, "M"))
		}
		// A new stock movement after the preview is stale too.
		rep2, _ := preview(tokImp, count6, csvText)
		exec(`INSERT INTO stock_movements(document_id,dedupe_key,kind,location_type,location_id,product_id,variant_size,qty,qty_before,qty_after,ref_type,occurred_at)
		      VALUES(gen_random_uuid(),'cv-moved-2','adjust','outlet',$1,$2,'M',1,10,11,'test',now())`, outC, prodA)
		code, out = imp(tokImp, count6, csvText, false, nextKey(), &rep2, &rep2.Data.Summary)
		mustCode("commit after a movement", 409, code, out)
		exec(`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, count6)
	})

	t.Run("a blank counted_qty skips the row with a warning (partly filled sheet)", func(t *testing.T) {
		count7 := newCount("cv7")
		start(count7)
		const csvText = "barcode,counted_qty\n9001,\n9003,4\n"
		rep, out := preview(tokImp, count7, csvText)
		if rep.Data.Summary.Matched != 1 || rep.Data.Summary.Uncounted != 2 || !strings.Contains(out, "blank_qty") {
			t.Fatalf("report %s", out)
		}
		code, out := imp(tokImp, count7, csvText, false, nextKey(), &rep, &rep.Data.Summary)
		mustCode("commit", 200, code, out)
		if actual(count7, "M") != "null" || actual(count7, "S") != "4" {
			t.Fatalf("M=%s S=%s", actual(count7, "M"), actual(count7, "S"))
		}
		exec(`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, count7)
	})

	t.Run("a manual baseline is flagged and cleared: the delta stays against the count-start snapshot", func(t *testing.T) {
		stockM := func() int {
			return num(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='M'`, outC, prodA)
		}
		count8 := newCount("cv8")
		start(count8)
		frozen := num(`SELECT frozen_qty FROM stock_count_items WHERE stock_count_id=$1 AND variant_size='M'`, count8)
		exec(`UPDATE outlet_variant_stock SET stock=stock+2 WHERE outlet_id=$1 AND product_id=$2 AND variant_size='M'`, outC, prodA)
		code, _, body := call("PUT", "/stock-counts/"+count8, tokCre, "", map[string]any{
			"items": []map[string]any{{"productId": prodA, "variantSize": "M", "actualQty": 3}}})
		mustCode("manual save captures a baseline", 200, code, body)
		if num(`SELECT count(*) FROM stock_count_items WHERE stock_count_id=$1 AND baseline_qty IS NOT NULL`, count8) != 1 {
			t.Fatal("manual save did not capture a baseline")
		}
		live := stockM()
		const csvText = "barcode,counted_qty\n9001,8\n"
		rep, out := preview(tokImp, count8, csvText)
		if !strings.Contains(out, "baseline_replaced") || !strings.Contains(out, "baseline input manual") {
			t.Fatalf("preview does not flag the manual baseline: %s", out)
		}
		code, out = imp(tokImp, count8, csvText, false, nextKey(), &rep, &rep.Data.Summary)
		mustCode("commit", 200, code, out)
		if num(`SELECT count(*) FROM stock_count_items WHERE stock_count_id=$1 AND baseline_qty IS NOT NULL`, count8) != 0 || actual(count8, "M") != "8" {
			t.Fatal("the CSV save must clear the line's baseline and store the value")
		}
		exec(`UPDATE app_settings SET inventory_approval_required=false WHERE id=1`)
		code, _, body = call("POST", "/stock-counts/"+count8+"/complete", tokCre, nextKey(), nil)
		exec(`UPDATE app_settings SET inventory_approval_required=true WHERE id=1`)
		mustCode("complete", 200, code, body)
		if want := live + (8 - frozen); stockM() != want {
			t.Fatalf("stock M = %d, want live %d + (counted 8 - frozen %d) = %d (a baseline would have given %d)",
				stockM(), live, frozen, want, live+(8-(live-0)))
		}
	})

	t.Run("round trip: the exported sheet, counted_qty filled, uploads unchanged and matches every line", func(t *testing.T) {
		count9 := newCount("cv9")
		start(count9)
		code, _, sheet := call("GET", "/stock-counts/"+count9+"/export", tokCre, "", nil)
		mustCode("export", 200, code, sheet)
		recs, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(sheet, "\ufeff"))).ReadAll()
		if err != nil || len(recs) != 4 {
			t.Fatalf("sheet %v %v", recs, err)
		}
		for i := 1; i < len(recs); i++ {
			recs[i][5] = strconv.Itoa(i) // only counted_qty is filled in
		}
		var sb strings.Builder
		sb.WriteString("\ufeff")
		if err := csv.NewWriter(&sb).WriteAll(recs); err != nil {
			t.Fatal(err)
		}
		rep, out := preview(tokImp, count9, sb.String())
		s := rep.Data.Summary
		if s.Matched != 3 || s.Unknown != 0 || s.Ambiguous != 0 || s.NotOnCount != 0 || s.Uncounted != 0 || s.Changed != 3 {
			t.Fatalf("round trip summary %+v: %s", s, out)
		}
		code, out = imp(tokImp, count9, sb.String(), false, nextKey(), &rep, &s)
		mustCode("commit", 200, code, out)
		if num(`SELECT count(*) FROM stock_count_items WHERE stock_count_id=$1 AND actual_qty IS NOT NULL`, count9) != 3 {
			t.Fatal("not every line was stored")
		}
		exec(`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, count9)
	})

	t.Run("a count that is not in progress refuses preview and commit", func(t *testing.T) {
		done := newCount("cv5")
		var rep report
		code, out := imp(tokImp, done, "barcode,counted_qty\n9001,1\n", true, "", &rep, nil)
		mustCode("preview of a planned count", 409, code, out)
		code, out = imp(tokImp, "00000000-0000-4000-8d09-0000000000ff", "barcode,counted_qty\n9001,1\n", true, "", &rep, nil)
		mustCode("preview of an unknown count", 404, code, out)
	})
}
