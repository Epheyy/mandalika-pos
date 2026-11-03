package handlers

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/csvimport"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// A39 CSV import: dry run writes nothing, commit is all-or-nothing and idempotent, the
// customer import never merges, the product import is merge-only and never touches stock,
// and a 30,000-row customer commit finishes in time. Opt-in only, same isolation contract
// as the other PostgreSQL gates; everything speaks raw JSON over the real HTTP handlers.
func TestCsvImportPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "IM", 26456)
	cur := t
	sub := func(name string, fn func(t *testing.T)) {
		t.Run(name, func(st *testing.T) {
			prev := cur
			cur = st
			defer func() { cur = prev }()
			fn(st)
		})
	}
	exec := func(sql string, args ...any) {
		cur.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			cur.Fatal(err)
		}
	}
	count := func(sql string, args ...any) (n int) {
		cur.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			cur.Fatal(err)
		}
		return
	}
	text := func(sql string, args ...any) (s string) {
		cur.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			cur.Fatal(err)
		}
		return
	}
	const (
		outlet = "00000000-0000-4000-8f10-000000000001"
		admin  = "00000000-0000-4000-8f10-000000000002"
		other  = "00000000-0000-4000-8f10-000000000003"
		wh     = "00000000-0000-4000-8f10-000000000004"
	)
	exec(`INSERT INTO outlets(id,name) VALUES($1,'IM outlet')`, outlet)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'im@example.invalid','x','IM admin','admin')`, admin)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'im2@example.invalid','x','IM cashier','cashier',$2)`, other, outlet)
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'IM warehouse')`, wh)
	exec(`UPDATE app_settings SET recipes_enabled=true`)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	h.importSlots = make(chan struct{}, 16) // the concurrency tests fire 6 at once; the 429 limit has its own unit test
	secret := []byte("IM-INTEGRATION-SYNTHETIC-KEY")
	issue := func(uid, role string, perms ...string) string {
		tk, err := auth.IssueAccess(secret, time.Hour, uid, role, "", perms)
		if err != nil {
			t.Fatal(err)
		}
		return tk
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("manage_customers")).Post("/customers/import", h.ImportCustomers)
	router.With(authWrap, mw.RequirePermission("manage_products")).Post("/products/import", h.ImportProducts)
	router.With(authWrap, mw.RequirePermission("manage_inventory")).Post("/ingredients/import", h.ImportIngredients)
	tok := issue(admin, "admin", "manage_customers", "manage_products", "manage_inventory")
	noPerm := issue(other, "cashier", "create_order")

	call := func(token, path string, body map[string]any, key string) (int, []byte) {
		cur.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			cur.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.Bytes()
	}
	type reportEnv struct {
		Data  csvimport.Report `json:"data"`
		Error string           `json:"error"`
	}
	type codeEnv struct {
		Data  struct{ Code string } `json:"data"`
		Error string                `json:"error"`
	}
	decodeReport := func(raw []byte) csvimport.Report {
		cur.Helper()
		var e reportEnv
		if err := json.Unmarshal(raw, &e); err != nil {
			cur.Fatalf("decode %s: %v", raw, err)
		}
		return e.Data
	}
	preview := func(path, csv string) csvimport.Report {
		cur.Helper()
		code, raw := call(tok, path, map[string]any{"csv": csv, "dryRun": true}, "")
		if code != http.StatusOK {
			cur.Fatalf("preview %s -> %d %s", path, code, raw)
		}
		return decodeReport(raw)
	}
	commit := func(path, csv string, rep csvimport.Report, key string) (int, []byte) {
		cur.Helper()
		return call(tok, path, map[string]any{"csv": csv, "dryRun": false, "fileSha256": rep.FileSHA256,
			"expectedSummary": rep.Summary}, key)
	}
	mustApply := func(path, csv, key string) csvimport.Report {
		cur.Helper()
		rep := preview(path, csv)
		code, raw := commit(path, csv, rep, key)
		if code != http.StatusOK {
			cur.Fatalf("commit %s -> %d %s", path, code, raw)
		}
		return decodeReport(raw)
	}
	manifest := func(key string) int {
		cur.Helper()
		return count(`SELECT COALESCE(max((data_manifest->>$1)::int),0) FROM content_versions`, key)
	}
	versions := func() string {
		cur.Helper()
		return text(`SELECT COALESCE(string_agg(version::text || data_manifest::text, ';' ORDER BY outlet_id),'') FROM content_versions`)
	}

	sub("auth: 403 without permission", func(t *testing.T) {
		for _, p := range []string{"/customers/import", "/products/import", "/ingredients/import"} {
			if code, _ := call(noPerm, p, map[string]any{"csv": "x", "dryRun": true}, ""); code != http.StatusForbidden {
				t.Errorf("%s without permission = %d, want 403", p, code)
			}
		}
	})

	sub("limits: oversize body is an explicit 413", func(t *testing.T) {
		code, _ := call(tok, "/customers/import", map[string]any{"csv": strings.Repeat("a", importBodyCap), "dryRun": true}, "")
		if code != http.StatusRequestEntityTooLarge {
			t.Errorf("status %d, want 413", code)
		}
	})

	// ── customers ───────────────────────────────────────────────
	const custHeader = "Nama,Telepon,Email,Tanggal Lahir,Anniversary,Catatan\n"
	sub("customers: dry run writes nothing", func(t *testing.T) {
		before, v := count(`SELECT count(*) FROM customers`), versions()
		rep := preview("/customers/import", custHeader+"Ayu,081100000001,,17/05/1990,,\nBudi,081100000002,,,,\n")
		if rep.Summary.Create != 2 || rep.HasErrors() {
			t.Fatalf("%+v", rep.Summary)
		}
		if count(`SELECT count(*) FROM customers`) != before || versions() != v || count(`SELECT count(*) FROM import_runs`) != 0 {
			t.Error("a dry run changed data, content versions or import_runs")
		}
	})

	var firstRun csvimport.Report
	var firstFile string
	sub("customers: commit creates rows, records the run and bumps customers once", func(t *testing.T) {
		firstFile = custHeader + "Ayu,0811-0000-0001,ayu@x.co,17/05/1990,,VIP\nBudi,081100000002,,,,\nCici,081100000003,,,,\n"
		before := versions()
		firstRun = mustApply("/customers/import", firstFile, "key-1")
		if firstRun.RunID == "" || firstRun.Summary.Create != 3 {
			t.Fatalf("%+v", firstRun)
		}
		if count(`SELECT count(*) FROM customers`) != 3 || count(`SELECT count(*) FROM import_runs`) != 1 {
			t.Error("expected 3 customers and 1 import run")
		}
		if got := text(`SELECT phone FROM customers WHERE name='Ayu'`); got != "081100000001" {
			t.Errorf("phone stored as %q, want the format-cleaned 081100000001", got)
		}
		if got := text(`SELECT birthday::text FROM customers WHERE name='Ayu'`); got != "1990-05-17" {
			t.Errorf("birthday %q", got)
		}
		after := versions()
		if after == before || strings.Count(after, `"customers": 1`) == 0 {
			t.Errorf("customers content version not bumped once: %s -> %s", before, after)
		}
	})

	sub("customers: the same key and file replays, with no second write", func(t *testing.T) {
		code, raw := commit("/customers/import", firstFile, firstRun, "key-1")
		if code != http.StatusOK {
			t.Fatalf("replay -> %d %s", code, raw)
		}
		rep := decodeReport(raw)
		if rep.RunID != firstRun.RunID || rep.Summary != firstRun.Summary {
			t.Errorf("replay differs: %+v vs %+v", rep.Summary, firstRun.Summary)
		}
		if count(`SELECT count(*) FROM customers`) != 3 || count(`SELECT count(*) FROM import_runs`) != 1 {
			t.Error("replay wrote again")
		}
	})

	sub("customers: the stored import_runs result holds no phone, email or name; the live response and the replay stay coherent", func(t *testing.T) {
		csv := custHeader + "Rahasia Nama,812345678,rahasia@bocor,,,\n"
		rep := preview("/customers/import", csv)
		if rep.Summary.Create != 1 || rep.Summary.Warning != 2 {
			t.Fatalf("want 1 create and 2 warnings (leading zero, email): %+v", rep.Summary)
		}
		code, live := commit("/customers/import", csv, rep, "key-pii")
		if code != http.StatusOK || !strings.Contains(string(live), "812345678") {
			t.Fatalf("live response must stay unredacted: %d %s", code, live)
		}
		stored := text(`SELECT result::text FROM import_runs WHERE idempotency_key='key-pii'`)
		for _, secret := range []string{"812345678", "rahasia@bocor", "Rahasia Nama"} {
			if strings.Contains(stored, secret) {
				t.Errorf("import_runs.result contains %q: %s", secret, stored)
			}
		}
		if count(`SELECT count(*) FROM import_runs WHERE idempotency_key='key-pii' AND file_name IS NULL`) != 1 {
			t.Error("file_name handling changed (this request sent none, so it must stay NULL)")
		}
		code, raw := commit("/customers/import", csv, rep, "key-pii")
		replay := decodeReport(raw)
		if code != http.StatusOK || replay.Summary != rep.Summary || len(replay.Issues) != 2 || replay.Issues[0].Code == "" || replay.Issues[0].Value != "" {
			t.Errorf("replay: %d %+v", code, replay)
		}
		if strings.Contains(string(raw), "812345678") {
			t.Error("replay leaked the phone")
		}
	})

	sub("customers: the same key with a different file is a 409 idempotency_conflict", func(t *testing.T) {
		beforeCustomers := count(`SELECT count(*) FROM customers`)
		other := custHeader + "Dewi,081100000009,,,,\n"
		rep := preview("/customers/import", other)
		code, raw := commit("/customers/import", other, rep, "key-1")
		var e codeEnv
		_ = json.Unmarshal(raw, &e)
		if code != http.StatusConflict || e.Data.Code != "idempotency_conflict" {
			t.Errorf("%d %s", code, raw)
		}
		if count(`SELECT count(*) FROM customers`) != beforeCustomers {
			t.Error("conflicting key wrote data")
		}
	})

	sub("customers: an existing phone is skipped, never created or merged; a merged-away phone is skipped with a warning", func(t *testing.T) {
		exec(`INSERT INTO customers(name,phone) VALUES('Gone','081100000050')`)
		exec(`UPDATE customers SET merged_into=(SELECT id FROM customers WHERE name='Ayu'), merged_at=now() WHERE name='Gone'`)
		before := count(`SELECT count(*) FROM customers`)
		rep := mustApply("/customers/import", custHeader+"Ayu Lagi,081100000001,,,,\nBaru,081100000050,,,,\n", "key-skip")
		if rep.Summary.Skip != 2 || rep.Summary.Create != 0 || rep.Summary.Warning != 1 {
			t.Fatalf("%+v", rep.Summary)
		}
		if len(rep.Issues) != 1 || rep.Issues[0].Code != "merged_away" || !strings.Contains(rep.Issues[0].Message, "Ayu") ||
			!strings.Contains(rep.Issues[0].Message, "0001") || strings.Contains(rep.Issues[0].Message, "081100000001") {
			t.Errorf("warning must name the keeper and a masked phone only: %+v", rep.Issues)
		}
		if got := text(`SELECT result::text FROM import_runs WHERE idempotency_key='key-skip'`); strings.Contains(got, "Ayu") || strings.Contains(got, "0001") {
			t.Errorf("the stored report must not carry the keeper's name or phone: %s", got)
		}
		if count(`SELECT count(*) FROM customers`) != before {
			t.Error("a merged-away customer must not be re-created")
		}
		if count(`SELECT count(*) FROM customers WHERE name='Ayu Lagi'`) != 0 {
			t.Error("a customer with an existing phone must not be created")
		}
		if count(`SELECT count(*) FROM customers WHERE merged_into IS NOT NULL`) != 1 || count(`SELECT count(*) FROM customer_merges`) != 0 {
			t.Error("import must never merge")
		}
		if count(`SELECT count(*) FROM customer_dup_candidates`) != 0 {
			t.Error("no dup candidate expected for a clean import")
		}
	})

	sub("customers: a merge chain A to B to C resolves to the terminal keeper C", func(t *testing.T) {
		exec(`INSERT INTO customers(name,phone) VALUES('Chain C','081100000903')`)
		exec(`INSERT INTO customers(name,phone,merged_into,merged_at) VALUES('Chain B','081100000902',(SELECT id FROM customers WHERE name='Chain C'),now())`)
		exec(`INSERT INTO customers(name,phone,merged_into,merged_at) VALUES('Chain A','0811-0000-0901',(SELECT id FROM customers WHERE name='Chain B'),now())`)
		before := count(`SELECT count(*) FROM customers`)
		rep := preview("/customers/import", custHeader+"Chain A again,081100000901,,,,\nChain B again,081100000902,,,,\n")
		if rep.Summary.Skip != 2 || rep.Summary.Create != 0 || rep.Summary.Warning != 2 {
			t.Fatalf("%+v", rep.Summary)
		}
		for _, is := range rep.Issues {
			if is.Code != "merged_away" || !strings.Contains(is.Message, "Chain C") || !strings.Contains(is.Message, "0903") ||
				strings.Contains(is.Message, "Chain B") || strings.Contains(is.Message, "081100000903") {
				t.Errorf("both rows must point at keeper C by name and masked phone only: %+v", is)
			}
		}
		mustApply("/customers/import", custHeader+"Chain A again,081100000901,,,,\n", "key-chain")
		if count(`SELECT count(*) FROM customers`) != before {
			t.Error("a merged-away customer was re-created")
		}
	})

	sub("customers: a live customer with the phone makes it a normal skip, not a merged-away warning", func(t *testing.T) {
		exec(`INSERT INTO customers(name,phone) VALUES('Both live','081100000911')`)
		exec(`INSERT INTO customers(name,phone,merged_into,merged_at) VALUES('Both tomb','081100000911',(SELECT id FROM customers WHERE name='Chain C'),now())`)
		rep := preview("/customers/import", custHeader+"Both again,081100000911,,,,\n")
		if rep.Summary.Skip != 1 || rep.Summary.Warning != 0 || len(rep.Issues) != 0 {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
	})

	sub("customers: a merge between preview and commit is a 409 import_stale and writes nothing", func(t *testing.T) {
		exec(`INSERT INTO customers(name,phone) VALUES('Mrg live','081100000921')`)
		exec(`INSERT INTO customers(name,phone) VALUES('Mrg keeper','081100000922')`)
		csv := custHeader + "Mrg again,081100000921,,,,\n"
		rep := preview("/customers/import", csv)
		if rep.Summary.Skip != 1 || rep.Summary.Warning != 0 {
			t.Fatalf("%+v", rep.Summary)
		}
		exec(`UPDATE customers SET merged_into=(SELECT id FROM customers WHERE name='Mrg keeper'), merged_at=now() WHERE name='Mrg live'`)
		before := count(`SELECT count(*) FROM customers`)
		code, raw := commit("/customers/import", csv, rep, "key-merge-stale")
		var e codeEnv
		_ = json.Unmarshal(raw, &e)
		if code != http.StatusConflict || e.Data.Code != "import_stale" {
			t.Fatalf("%d %s", code, raw)
		}
		if count(`SELECT count(*) FROM customers`) != before || count(`SELECT count(*) FROM import_runs WHERE idempotency_key='key-merge-stale'`) != 0 {
			t.Error("stale commit wrote data")
		}
	})

	sub("customers: apply re-checks inside the transaction; a merged-away phone planned as create is stale", func(t *testing.T) {
		// the plan saw no customer with this phone; a merge tombstoned it before apply ran
		exec(`INSERT INTO customers(name,phone,merged_into,merged_at) VALUES('Late tomb','081100000931',(SELECT id FROM customers WHERE name='Chain C'),now())`)
		before := count(`SELECT count(*) FROM customers`)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		err = write.ApplyCustomerImportCreates(ctx, tx, []csvimport.CustomerCreate{{Name: "Recreated", Phone: "081100000931"}, {Name: "Fine", Phone: "081100000932"}})
		if !errors.Is(err, write.ErrImportStale) {
			t.Fatalf("want ErrImportStale, got %v", err)
		}
		_ = tx.Rollback(ctx)
		if count(`SELECT count(*) FROM customers`) != before {
			t.Error("the stale apply wrote rows")
		}
	})

	sub("customers: the apply re-check is not stale when a live customer and a tombstone share the phone", func(t *testing.T) {
		exec(`INSERT INTO customers(name,phone) VALUES('Share live','081100000941')`)
		exec(`INSERT INTO customers(name,phone,merged_into,merged_at) VALUES('Share tomb','081100000941',(SELECT id FROM customers WHERE name='Chain C'),now())`)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err = write.ApplyCustomerImportCreates(ctx, tx, []csvimport.CustomerCreate{{Name: "Share new", Phone: "081100000941"}}); err != nil {
			t.Fatalf("a live holder of the phone must not make the apply stale: %v", err)
		}
		_ = tx.Rollback(ctx)
	})

	sub("customers: a same-phone customer landing between plan and apply gets a dup candidate, not a merge", func(t *testing.T) {
		exec(`INSERT INTO customers(name,phone) VALUES('POS older','081100000777')`)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		// apply runs as if the plan saw no 081100000777 (the POS row arrived after it)
		if err = write.ApplyCustomerImportCreates(ctx, tx, []csvimport.CustomerCreate{{Name: "Imported", Phone: "081100000777"}}); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if count(`SELECT count(*) FROM customers WHERE phone='081100000777' AND merged_into IS NULL`) != 2 {
			t.Error("both customers must stay live (nothing merged)")
		}
		if count(`SELECT count(*) FROM customer_dup_candidates d JOIN customers n ON n.id=d.new_customer_id JOIN customers e ON e.id=d.existing_customer_id
		            WHERE n.name='Imported' AND e.name='POS older' AND d.status='pending'`) != 1 {
			t.Error("expected one pending dup candidate imported -> POS older")
		}
	})

	sub("customers: a data change after the preview is a 409 import_stale and writes nothing", func(t *testing.T) {
		csv := custHeader + "Eka,081100000101,,,,\nFani,081100000102,,,,\n"
		rep := preview("/customers/import", csv)
		exec(`INSERT INTO customers(name,phone) VALUES('Race','081100000101')`)
		before := count(`SELECT count(*) FROM customers`)
		code, raw := commit("/customers/import", csv, rep, "key-stale")
		var e codeEnv
		_ = json.Unmarshal(raw, &e)
		if code != http.StatusConflict || e.Data.Code != "import_stale" {
			t.Fatalf("%d %s", code, raw)
		}
		if count(`SELECT count(*) FROM customers`) != before || count(`SELECT count(*) FROM import_runs WHERE idempotency_key='key-stale'`) != 0 {
			t.Error("stale commit wrote data")
		}
	})

	sub("customers: one bad row is a 422 with the report and zero writes", func(t *testing.T) {
		csv := custHeader + "Gita,081100000201,,,,\nHani,6.28E+11,,,,\n"
		rep := preview("/customers/import", csv)
		if rep.Summary.Error != 1 || rep.Summary.Create != 1 {
			t.Fatalf("%+v", rep.Summary)
		}
		before, runs := count(`SELECT count(*) FROM customers`), count(`SELECT count(*) FROM import_runs`)
		code, raw := commit("/customers/import", csv, rep, "key-bad")
		if code != http.StatusUnprocessableEntity {
			t.Fatalf("%d %s", code, raw)
		}
		got := decodeReport(raw)
		if got.Summary.Error != 1 || len(got.Issues) == 0 || got.Issues[0].Code != "phone_scientific" {
			t.Errorf("422 must carry the row report: %+v", got.Issues)
		}
		if count(`SELECT count(*) FROM customers`) != before || count(`SELECT count(*) FROM import_runs`) != runs {
			t.Error("a 422 must write nothing (the good row too)")
		}
	})

	sub("customers: commit without Idempotency-Key is a 400", func(t *testing.T) {
		rep := preview("/customers/import", custHeader+"Ina,081100000301,,,,\n")
		if code, _ := commit("/customers/import", custHeader+"Ina,081100000301,,,,\n", rep, ""); code != http.StatusBadRequest {
			t.Errorf("status %d", code)
		}
	})

	sub("customers: concurrent commits of one kind serialise (different keys, same file)", func(t *testing.T) {
		csv := custHeader + "Conc A,081100000401,,,,\nConc B,081100000402,,,,\n"
		rep := preview("/customers/import", csv)
		var wg sync.WaitGroup
		codes := make([]int, 6)
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				codes[i], _ = commit("/customers/import", csv, rep, fmt.Sprintf("conc-%d", i))
			}(i)
		}
		wg.Wait()
		ok, stale := 0, 0
		for _, c := range codes {
			switch c {
			case http.StatusOK:
				ok++
			case http.StatusConflict:
				stale++
			}
		}
		if ok != 1 || stale != 5 {
			t.Errorf("want exactly one winner and five stale, got %v", codes)
		}
		if count(`SELECT count(*) FROM customers WHERE name LIKE 'Conc %'`) != 2 {
			t.Error("duplicates were created by concurrent imports")
		}
	})

	sub("customers: concurrent retries of the SAME key replay, never a second write", func(t *testing.T) {
		csv := custHeader + "Same A,081100000501,,,,\n"
		rep := preview("/customers/import", csv)
		var wg sync.WaitGroup
		runs := make([]string, 6)
		codes := make([]int, 6)
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				c, raw := commit("/customers/import", csv, rep, "same-key")
				codes[i] = c
				if c == http.StatusOK {
					runs[i] = decodeReport(raw).RunID
				}
			}(i)
		}
		wg.Wait()
		for i := range codes {
			if codes[i] != http.StatusOK || runs[i] != runs[0] || runs[0] == "" {
				t.Fatalf("codes %v runs %v", codes, runs)
			}
		}
		if count(`SELECT count(*) FROM customers WHERE name='Same A'`) != 1 {
			t.Error("same-key retries created duplicates")
		}
	})

	// ── products ────────────────────────────────────────────────
	const prodHeader = "Nama,Brand,Kategori,Deskripsi,Ukuran,Harga,SKU,Barcode,Jual,Aktif,Unggulan\n"
	var melatiID, mawarID, catFloral string
	sub("products: seed a catalog with stock, favourites and per-outlet rows", func(t *testing.T) {
		catFloral = text(`INSERT INTO categories(name) VALUES('Floral') RETURNING id::text`)
		melatiID = text(`INSERT INTO products(name,brand,category_id,description,is_favourite,images) VALUES('Melati','Mandalika',$1,'wangi',true,'["img1.jpg"]') RETURNING id::text`, catFloral)
		mawarID = text(`INSERT INTO products(name,brand) VALUES('Mawar','Flamboyan') RETURNING id::text`)
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,barcode) VALUES
		      ($1,'50 ml',100000,7,'MEL-50','MEL-50'),($1,'100 ml',180000,9,'MEL-100','8990001'),($2,'50 ml',90000,3,'MAW-50','MAW-50')`, melatiID, mawarID)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES
		      ($1,$2,'50 ml',7),($1,$2,'100 ml',9),($1,$3,'50 ml',3)`, outlet, melatiID, mawarID)
		exec(`INSERT INTO outlet_variant_price(outlet_id,product_id,variant_size,price) VALUES ($1,$2,'100 ml',175000),($1,$2,'50 ml',99000)`, outlet, melatiID)
		exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES ($1,$2,'100 ml',40),($1,$2,'50 ml',11)`, wh, melatiID)
	})
	stockSnapshot := func() string {
		return text(`SELECT COALESCE((SELECT string_agg(product_id::text||variant_size||stock::text, ',' ORDER BY product_id,variant_size) FROM outlet_variant_stock),'')
		          || '|' || COALESCE((SELECT string_agg(product_id::text||variant_size||price::text, ',' ORDER BY product_id,variant_size) FROM outlet_variant_price),'')
		          || '|' || COALESCE((SELECT string_agg(product_id::text||variant_size||stock::text, ',' ORDER BY product_id,variant_size) FROM warehouse_variant_stock),'')
		          || '|' || COALESCE((SELECT string_agg(id::text||stock::text, ',' ORDER BY id) FROM product_variants),'')`)
	}

	sub("products: a file listing 1 of 2 variants leaves the other variant and ALL stock rows unchanged", func(t *testing.T) {
		stock := stockSnapshot()
		rep := mustApply("/products/import", prodHeader+"Melati,Mandalika,,,50 ml,125.000,MEL-50,,,,\n", "p-1")
		if rep.Summary.Update != 1 || rep.Summary.Error != 0 {
			t.Fatalf("%+v", rep.Summary)
		}
		if count(`SELECT count(*) FROM product_variants WHERE product_id=$1`, melatiID) != 2 {
			t.Fatal("the unlisted variant was deleted")
		}
		if got := text(`SELECT price::text FROM product_variants WHERE sku='MEL-50'`); got != "125000.00" {
			t.Errorf("150.000-style price stored as %s, want 125000.00", got)
		}
		// price changed; everything stock-shaped is untouched
		if after := stockSnapshot(); after != stock {
			t.Errorf("stock rows changed:\n%s\n%s", stock, after)
		}
		if text(`SELECT is_favourite::text||images::text||COALESCE(description,'') FROM products WHERE id=$1`, melatiID) != `true["img1.jpg"]wangi` {
			t.Error("is_favourite, images or description changed by a blank-cell update")
		}
	})

	sub("products: a re-upload of the same file is all skips and bumps nothing", func(t *testing.T) {
		v := versions()
		rep := mustApply("/products/import", prodHeader+"Melati,Mandalika,,,50 ml,125000,MEL-50,,,,\n", "p-1b")
		if rep.Summary.Skip != 1 || rep.Summary.Update != 0 || rep.Summary.Create != 0 {
			t.Fatalf("%+v", rep.Summary)
		}
		if versions() != v {
			t.Error("a no-op import bumped the content version")
		}
	})

	sub("products: new products and variants get no stock rows and stock 0; new categories are created; versions bump", func(t *testing.T) {
		stockRows := count(`SELECT count(*) FROM outlet_variant_stock`)
		v, prodBefore, catBefore := versions(), manifest("products"), manifest("categories")
		rep := mustApply("/products/import", prodHeader+
			"Anggrek,Mandalika,Baru,Harum,30 ml,75000,ANG-30,,,,Ya\n"+
			"Melati,Mandalika,,,200 ml,300.000,MEL-200,SCAN-200,,,\n", "p-2")
		if rep.Summary.Create != 2 || rep.Summary.NewCategories != 1 {
			t.Fatalf("%+v", rep.Summary)
		}
		if count(`SELECT count(*) FROM outlet_variant_stock`) != stockRows {
			t.Error("import created outlet stock rows")
		}
		if count(`SELECT count(*) FROM product_variants WHERE sku IN ('ANG-30','MEL-200') AND stock<>0`) != 0 {
			t.Error("a new variant must start at stock 0")
		}
		if text(`SELECT barcode FROM product_variants WHERE sku='ANG-30'`) != "ANG-30" || text(`SELECT barcode FROM product_variants WHERE sku='MEL-200'`) != "SCAN-200" {
			t.Error("barcode must default to the SKU unless given")
		}
		if count(`SELECT count(*) FROM categories WHERE name='Baru'`) != 1 || count(`SELECT count(*) FROM products WHERE name='Anggrek' AND is_featured AND sellable AND is_active`) != 1 {
			t.Error("category or product defaults wrong")
		}
		if got := versions(); got == v || manifest("products") != prodBefore+1 || manifest("categories") != catBefore+1 {
			t.Errorf("one bump each for categories and products expected (products %d->%d, categories %d->%d)",
				prodBefore, manifest("products"), catBefore, manifest("categories"))
		}
	})

	sub("products: D13 a rename away from a size that still holds stock is a row error and apply refuses", func(t *testing.T) {
		before := stockSnapshot()
		csv := prodHeader + "Melati,Mandalika,,,75 ml,125000,MEL-50,,,,\n"
		rep := preview("/products/import", csv)
		found := false
		for _, i := range rep.Issues {
			found = found || (i.Code == "size_has_stock" && strings.Contains(i.Message, "masih punya stok di"))
		}
		if !found || !rep.HasErrors() {
			t.Fatalf("want size_has_stock naming a location: %+v", rep.Issues)
		}
		if code, raw := commit("/products/import", csv, rep, "p-d13"); code != http.StatusUnprocessableEntity {
			t.Errorf("commit -> %d %s, want 422", code, raw)
		}
		if stockSnapshot() != before {
			t.Error("a refused rename changed stock rows")
		}
	})

	sub("products: a size rename moves the (zeroed) outlet stock, outlet price and warehouse stock rows", func(t *testing.T) {
		// D13: only an empty key may be renamed, so empty the 50 ml rows first.
		exec(`UPDATE outlet_variant_stock SET stock=0 WHERE product_id=$1 AND variant_size='50 ml'`, melatiID)
		exec(`UPDATE warehouse_variant_stock SET stock=0 WHERE product_id=$1 AND variant_size='50 ml'`, melatiID)
		exec(`DELETE FROM outlet_variant_stock WHERE product_id=$1 AND variant_size='75 ml'`, melatiID)
		rep := mustApply("/products/import", prodHeader+"Melati,Mandalika,,,75 ml,125000,MEL-50,,,,\n", "p-3")
		if rep.Summary.Update != 1 || rep.Summary.Warning == 0 {
			t.Fatalf("%+v", rep.Summary)
		}
		if count(`SELECT count(*) FROM outlet_variant_stock WHERE product_id=$1 AND variant_size='75 ml' AND stock=0`, melatiID) != 1 ||
			count(`SELECT count(*) FROM outlet_variant_stock WHERE product_id=$1 AND variant_size='50 ml'`, melatiID) != 0 {
			t.Error("outlet stock did not follow the rename")
		}
		if count(`SELECT count(*) FROM outlet_variant_price WHERE product_id=$1 AND variant_size='75 ml' AND price=99000`, melatiID) != 1 ||
			count(`SELECT count(*) FROM warehouse_variant_stock WHERE product_id=$1 AND variant_size='75 ml' AND stock=0`, melatiID) != 1 ||
			count(`SELECT count(*) FROM outlet_variant_price WHERE product_id=$1 AND variant_size='50 ml'`, melatiID)+count(`SELECT count(*) FROM warehouse_variant_stock WHERE product_id=$1 AND variant_size='50 ml'`, melatiID) != 0 {
			t.Error("outlet price or warehouse stock did not follow the rename")
		}
		if count(`SELECT count(*) FROM product_variants WHERE sku='MEL-50' AND size='75 ml' AND stock=7`) != 1 {
			t.Error("variant identity or its mirror stock changed")
		}
	})

	sub("products: rename onto another variant's size, a swap and a stale stock row are row errors", func(t *testing.T) {
		before := stockSnapshot()
		for name, row := range map[string]struct{ csv, code string }{
			"collision": {"Melati,Mandalika,,,100 ml,1000,MEL-50,,,,\n", "size_collision"},
			"swap":      {"Melati,Mandalika,,,100 ml,1000,MEL-50,,,,\nMelati,Mandalika,,,75 ml,1000,MEL-100,,,,\n", "size_collision"},
			"residue":   {"Melati,Mandalika,,,300 ml,1000,MEL-50,,,,\n", "size_stock_residue"},
		} {
			if name == "residue" {
				exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES ($1,$2,'300 ml',1)`, outlet, melatiID)
			}
			rep := preview("/products/import", prodHeader+row.csv)
			found := false
			for _, i := range rep.Issues {
				found = found || i.Code == row.code
			}
			if !found || !rep.HasErrors() {
				t.Errorf("%s: want %s, got %+v", name, row.code, rep.Issues)
			}
			code, raw := commit("/products/import", prodHeader+row.csv, rep, "p-bad-"+name)
			if code != http.StatusUnprocessableEntity {
				t.Errorf("%s: commit -> %d %s", name, code, raw)
			}
		}
		exec(`DELETE FROM outlet_variant_stock WHERE product_id=$1 AND variant_size='300 ml'`, melatiID)
		if stockSnapshot() != before {
			t.Error("a refused import changed stock")
		}
	})

	sub("products: a SKU on another product and a barcode collision are row errors, never a 500", func(t *testing.T) {
		for name, row := range map[string]struct{ csv, code string }{
			"sku on another product": {"Melati,Mandalika,,,50 ml,1000,MAW-50,,,,\n", "sku_on_other_product"},
			"explicit barcode taken": {"Mawar,Flamboyan,,,50 ml,90000,MAW-50,8990001,,,\n", "barcode_in_use"},
			"sku used as barcode":    {"Mawar,Flamboyan,,,75 ml,90000,8990001,,,,\n", "barcode_in_use"},
		} {
			code, raw := call(tok, "/products/import", map[string]any{"csv": prodHeader + row.csv, "dryRun": true}, "")
			rep := decodeReport(raw)
			found := false
			for _, i := range rep.Issues {
				found = found || i.Code == row.code
			}
			if code != http.StatusOK || !found {
				t.Errorf("%s: %d %+v", name, code, rep.Issues)
			}
		}
	})

	sub("products: blank Brand is an error (no default brand)", func(t *testing.T) {
		rep := preview("/products/import", prodHeader+"Tanpa,,,,50 ml,1000,TB-1,,,,\n")
		if rep.Summary.Error != 1 {
			t.Errorf("%+v", rep.Summary)
		}
	})

	sub("products: a Deskripsi starting with a dash round-trips through the guard apostrophe", func(t *testing.T) {
		mustApply("/products/import", prodHeader+"Dahlia,Mandalika,,'- bahan alami,30 ml,50000,DAH-30,,,,\n", "p-dash")
		if got := text(`SELECT description FROM products WHERE name='Dahlia'`); got != "- bahan alami" {
			t.Errorf("stored %q, want the text without the apostrophe", got)
		}
	})

	hasCode := func(rep csvimport.Report, code string) bool {
		for _, i := range rep.Issues {
			if i.Code == code {
				return true
			}
		}
		return false
	}
	sub("products: a rename is blocked while an open transfer or stock count still uses the size, and allowed otherwise", func(t *testing.T) {
		rename := prodHeader + "Melati,Mandalika,,,120 ml,180000,MEL-100,,,,\n"
		// D13: a stocked size cannot be renamed at all, so empty the 100 ml rows first.
		if rep := preview("/products/import", rename); !hasCode(rep, "size_has_stock") {
			t.Fatalf("100 ml still holds stock, the rename must be refused: %+v", rep.Issues)
		}
		exec(`UPDATE outlet_variant_stock SET stock=0 WHERE product_id=$1 AND variant_size='100 ml'`, melatiID)
		exec(`UPDATE warehouse_variant_stock SET stock=0 WHERE product_id=$1 AND variant_size='100 ml'`, melatiID)
		if rep := preview("/products/import", rename); hasCode(rep, "size_in_flight") || rep.HasErrors() {
			t.Fatalf("no open document yet, the rename must be allowed: %+v", rep.Issues)
		}
		trf := text(`INSERT INTO transfers(status,source_outlet_id,dest_warehouse_id) VALUES('in_transit',$1,$2) RETURNING id::text`, outlet, wh)
		exec(`INSERT INTO transfer_items(transfer_id,product_id,variant_size,sent_qty) VALUES ($1,$2,'100 ml',2)`, trf, melatiID)
		rep := preview("/products/import", rename)
		if !hasCode(rep, "size_in_flight") || !rep.HasErrors() {
			t.Fatalf("in-transit transfer must block the rename: %+v", rep.Issues)
		}
		if code, _ := commit("/products/import", rename, rep, "p-trf"); code != http.StatusUnprocessableEntity {
			t.Errorf("commit -> %d, want 422", code)
		}
		// a price-only change on the same variant is still fine
		if rep := preview("/products/import", prodHeader+"Melati,Mandalika,,,100 ml,181000,MEL-100,,,,\n"); rep.HasErrors() {
			t.Errorf("price-only change must not be blocked: %+v", rep.Issues)
		}
		exec(`UPDATE transfers SET status='completed' WHERE id=$1`, trf)
		if rep := preview("/products/import", rename); hasCode(rep, "size_in_flight") {
			t.Fatalf("a completed transfer must not block: %+v", rep.Issues)
		}
		sc := text(`INSERT INTO stock_counts(name,status,outlet_id) VALUES('open count','in_progress',$1) RETURNING id::text`, outlet)
		exec(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size) VALUES ($1,$2,'Melati','100 ml')`, sc, melatiID)
		if rep := preview("/products/import", rename); !hasCode(rep, "size_in_flight") {
			t.Fatalf("an open stock count must block the rename: %+v", rep.Issues)
		}
		// S3: a count waiting for approval still applies deltas by size text, so it blocks too
		exec(`UPDATE stock_counts SET status='pending_approval' WHERE id=$1`, sc)
		if rep := preview("/products/import", rename); !hasCode(rep, "size_in_flight") {
			t.Fatalf("a count pending approval must block the rename: %+v", rep.Issues)
		}
		exec(`UPDATE stock_counts SET status='completed' WHERE id=$1`, sc)
		if rep := preview("/products/import", rename); hasCode(rep, "size_in_flight") || rep.HasErrors() {
			t.Fatalf("a completed count must not block: %+v", rep.Issues)
		}
		// S3: so does a pending stock adjustment request for the size
		ar := text(`INSERT INTO stock_adjustment_requests(number,outlet_id,product_id,variant_size,qty_at_request,requested_new_qty,reason_code,requested_by)
			VALUES('ADJ-IM-1',$1,$2,'100 ml',1,0,'damaged',gen_random_uuid()) RETURNING id::text`, outlet, melatiID)
		if rep := preview("/products/import", rename); !hasCode(rep, "size_in_flight") {
			t.Fatalf("a pending adjustment request must block the rename: %+v", rep.Issues)
		}
		exec(`UPDATE stock_adjustment_requests SET status='cancelled' WHERE id=$1`, ar)
		if rep := preview("/products/import", rename); hasCode(rep, "size_in_flight") || rep.HasErrors() {
			t.Fatalf("a cancelled request must not block: %+v", rep.Issues)
		}
	})

	// waitForLockWait polls until some backend is blocked on a heavyweight lock (the import's
	// guarded UPDATE waiting for the held row), bounded so a regression fails instead of hanging.
	waitForLockWait := func(t *testing.T) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			if count(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`) > 0 {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("the import never blocked on the held row")
	}

	// A document that uses the old size can appear after the import planned and before it applies:
	// the commit re-checks the renamed pairs inside its transaction and goes stale (409).
	for i, late := range []struct {
		label string
		make  func() (cleanup func())
	}{
		{"planned stock count", func() func() {
			sc := text(`INSERT INTO stock_counts(name,status,outlet_id) VALUES('late count','planned',$1) RETURNING id::text`, outlet)
			exec(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size) VALUES ($1,$2,'Melati','100 ml')`, sc, melatiID)
			return func() { exec(`DELETE FROM stock_counts WHERE id=$1`, sc) }
		}},
		{"stock count pending approval", func() func() {
			sc := text(`INSERT INTO stock_counts(name,status,outlet_id) VALUES('late pending count','pending_approval',$1) RETURNING id::text`, outlet)
			exec(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size) VALUES ($1,$2,'Melati','100 ml')`, sc, melatiID)
			return func() { exec(`DELETE FROM stock_counts WHERE id=$1`, sc) }
		}},
		{"pending adjustment request", func() func() {
			ar := text(`INSERT INTO stock_adjustment_requests(number,outlet_id,product_id,variant_size,qty_at_request,requested_new_qty,reason_code,requested_by)
				VALUES('ADJ-IM-LATE',$1,$2,'100 ml',1,0,'damaged',gen_random_uuid()) RETURNING id::text`, outlet, melatiID)
			return func() { exec(`DELETE FROM stock_adjustment_requests WHERE id=$1`, ar) }
		}},
	} {
		sub("products: a "+late.label+" created between plan and apply makes the rename stale (409)", func(t *testing.T) {
			csv := prodHeader + "Melati,Mandalika,,,130 ml,180000,MEL-100,,,,\n"
			rep := preview("/products/import", csv)
			if rep.HasErrors() || hasCode(rep, "size_in_flight") {
				t.Fatalf("%+v", rep.Issues)
			}
			before := stockSnapshot()
			holder, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(ctx)
			if _, err = holder.Exec(ctx, `UPDATE product_variants SET price=price WHERE sku='MEL-100'`); err != nil {
				t.Fatal(err)
			}
			done := make(chan int, 1)
			go func() { c, _ := commit("/products/import", csv, rep, fmt.Sprintf("p-late-doc-%d", i)); done <- c }()
			waitForLockWait(t)
			cleanup := late.make()
			defer cleanup()
			if err = holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if code := <-done; code != http.StatusConflict {
				t.Errorf("commit status %d, want 409 import_stale", code)
			}
			if got := text(`SELECT size FROM product_variants WHERE sku='MEL-100'`); got != "100 ml" {
				t.Errorf("rename was applied despite the open document: %s", got)
			}
			if stockSnapshot() != before {
				t.Error("stale commit moved stock rows")
			}
		})
	}

	sub("products: a variant renamed by the form between plan and apply makes the commit stale (409), nothing written", func(t *testing.T) {
		csv := prodHeader + "Melati,Mandalika,,,100 ml,182000,MEL-100,,,,\n"
		rep := preview("/products/import", csv)
		if rep.HasErrors() || rep.Summary.Update != 1 {
			t.Fatalf("%+v", rep.Issues)
		}
		before := stockSnapshot()
		// The "form" holds the variant row (renamed, uncommitted) while the import plans on
		// the old size and then blocks in apply; when the form commits, apply must notice.
		form, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer form.Rollback(ctx)
		if _, err = form.Exec(ctx, `UPDATE product_variants SET size='101 ml' WHERE sku='MEL-100'`); err != nil {
			t.Fatal(err)
		}
		done := make(chan int, 1)
		go func() { c, _ := commit("/products/import", csv, rep, "p-form"); done <- c }()
		waitForLockWait(t)
		if err = form.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if code := <-done; code != http.StatusConflict {
			t.Errorf("commit status %d, want 409 import_stale", code)
		}
		if got := text(`SELECT price::text FROM product_variants WHERE sku='MEL-100'`); got != "180000.00" {
			t.Errorf("stale commit changed the price to %s", got)
		}
		if stockSnapshot() != before {
			t.Error("stale commit changed stock rows")
		}
		if count(`SELECT count(*) FROM import_runs WHERE idempotency_key='p-form'`) != 0 {
			t.Error("stale commit recorded a run")
		}
		exec(`UPDATE product_variants SET size='100 ml' WHERE sku='MEL-100'`)
	})

	sub("customers: a stored phone with formatting still matches the cleaned file phone (skipped, not duplicated)", func(t *testing.T) {
		exec(`INSERT INTO customers(name,phone) VALUES('Formatted','0811-222-333')`)
		rep := mustApply("/customers/import", custHeader+"Formatted Lagi,0811222333,,,,\nFresh,081100000888,,,,\n", "key-fmt")
		if rep.Summary.Skip != 1 || rep.Summary.Create != 1 {
			t.Fatalf("%+v", rep.Summary)
		}
		if count(`SELECT count(*) FROM customers WHERE name='Formatted Lagi'`) != 0 {
			t.Error("formatted phone was duplicated")
		}
	})

	sub("products and ingredients: non-ASCII names and categories link up (Go folding, not the database locale)", func(t *testing.T) {
		mustApply("/products/import", prodHeader+"ÇİÇEK Äyu,Ünal Ä,ÄÖÜ Kategori,,30 ml,50000,CIC-30,,,,\n", "p-utf8")
		if count(`SELECT count(*) FROM products p JOIN categories c ON c.id=p.category_id
		           WHERE p.name='ÇİÇEK Äyu' AND p.brand='Ünal Ä' AND c.name='ÄÖÜ Kategori'`) != 1 ||
			count(`SELECT count(*) FROM product_variants WHERE sku='CIC-30'`) != 1 {
			t.Error("non-ASCII product was not created with its category and variant")
		}
		mustApply("/ingredients/import", "Nama,SKU,Satuan,Kategori,Biaya Default,Catatan,Status\nÄyu Oil,AY-1,g,Ünik Ä,,,\n", "i-utf8")
		if count(`SELECT count(*) FROM ingredients i JOIN ingredient_categories c ON c.id=i.category_id
		           WHERE i.sku='AY-1' AND c.name='Ünik Ä'`) != 1 {
			t.Error("non-ASCII ingredient category not linked")
		}
	})

	// ── ingredients ─────────────────────────────────────────────
	sub("ingredients: create and update never touch ingredient stock or the content version", func(t *testing.T) {
		const ingHeader = "Nama,SKU,Satuan,Kategori,Biaya Default,Catatan,Status\n"
		ingID := text(`INSERT INTO ingredients(name,unit,sku) VALUES('Rose Oil','g','RO-001') RETURNING id::text`)
		exec(`INSERT INTO ingredient_warehouse_stock(warehouse_id,ingredient_id,qty) VALUES ($1,$2,12.5)`, wh, ingID)
		v := versions()
		rep := mustApply("/ingredients/import", ingHeader+"Rose Oil,RO-001,g,Fragrance,\"15,5\",Catatan,Aktif\nJasmine,JA-1,ml,Fragrance,1.500,,\n", "i-1")
		if rep.Summary.Create != 1 || rep.Summary.Update != 1 || rep.Summary.NewCategories != 1 {
			t.Fatalf("%+v", rep.Summary)
		}
		if got := text(`SELECT qty::text FROM ingredient_warehouse_stock WHERE ingredient_id=$1`, ingID); got != "12.500" {
			t.Errorf("ingredient stock changed: %s", got)
		}
		if got := text(`SELECT default_unit_cost::text FROM ingredients WHERE sku='JA-1'`); got != "1500.00" {
			t.Errorf("1.500 stored as %s, want 1500.00 (grouping, not a decimal)", got)
		}
		if versions() != v {
			t.Error("ingredient import must not bump the POS content version")
		}
	})

	sub("ingredients: a new SKU on a unique blank-SKU same-name ingredient assigns it; ambiguous and non-blank matches still create", func(t *testing.T) {
		const ingHeader = "Nama,SKU,Satuan,Kategori,Biaya Default,Catatan,Status\n"
		blank := text(`INSERT INTO ingredients(name,unit,sku) VALUES('Sku Blank','g','') RETURNING id::text`)
		exec(`INSERT INTO ingredients(name,unit,sku) VALUES('Sku Twin','g',''),('sku twin','g','')`)
		exec(`INSERT INTO ingredients(name,unit,sku) VALUES('Sku Owned','g','OWN-1')`)
		before := count(`SELECT count(*) FROM ingredients`)
		csv := ingHeader + "sku blank,SB-1,g,,,,\nSku Twin,ST-1,g,,,,\nSku Owned,OWN-2,g,,,,\n"
		rep := mustApply("/ingredients/import", csv, "i-assign")
		if rep.Summary.Update != 1 || rep.Summary.Create != 2 || rep.Summary.Warning != 2 {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
		if got := text(`SELECT sku FROM ingredients WHERE id=$1`, blank); got != "SB-1" {
			t.Errorf("the blank-SKU ingredient got SKU %q, want SB-1", got)
		}
		if got := text(`SELECT name FROM ingredients WHERE id=$1`, blank); got != "Sku Blank" {
			t.Errorf("stored name changed to %q", got)
		}
		if count(`SELECT count(*) FROM ingredients`) != before+2 {
			t.Error("expected two new ingredients (twin and owned)")
		}
		if count(`SELECT count(*) FROM ingredients WHERE sku IN ('SB-1','ST-1','OWN-2')`) != 3 {
			t.Error("each SKU must exist exactly once")
		}
	})

	sub("ingredients: two rows targeting one ingredient, or a unit change on a SKU assign, are row errors", func(t *testing.T) {
		const ingHeader = "Nama,SKU,Satuan,Kategori,Biaya Default,Catatan,Status\n"
		exec(`INSERT INTO ingredients(name,unit,sku) VALUES('Dual Target','g','')`)
		rep := preview("/ingredients/import", ingHeader+"Dual Target,DT-1,g,,,,\nDual Target,,g,,9.000,,\n")
		if rep.Summary.Error != 1 || len(rep.Issues) == 0 || rep.Issues[0].Row != 2 || rep.Issues[0].Code != "duplicate_in_file" {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
		rep = preview("/ingredients/import", ingHeader+"Dual Target,DT-1,kg,,,,\n")
		if rep.Summary.Error != 1 || rep.Issues[0].Code != "unit_mismatch" {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
	})

	// ── scale ───────────────────────────────────────────────────
	sub("scale: a 30,000-row customer commit completes in under 60 seconds", func(t *testing.T) {
		var sb strings.Builder
		sb.WriteString(custHeader)
		for i := 0; i < 30000; i++ {
			fmt.Fprintf(&sb, "Skala %d,0899%08d,s%d@example.invalid,,,\n", i, i, i)
		}
		csv := sb.String()
		start := time.Now()
		rep := preview("/customers/import", csv)
		if rep.Summary.Create != 30000 || rep.HasErrors() || len(rep.Rows) != csvimport.MaxReportRows {
			t.Fatalf("%+v rows=%d", rep.Summary, len(rep.Rows))
		}
		code, raw := commit("/customers/import", csv, rep, "scale-1")
		took := time.Since(start)
		if code != http.StatusOK {
			t.Fatalf("%d %s", code, raw[:min(300, len(raw))])
		}
		t.Logf("30,000-row customer preview+commit took %s", took)
		if took > 60*time.Second {
			t.Errorf("took %s, limit 60s", took)
		}
		if count(`SELECT count(*) FROM customers WHERE name LIKE 'Skala %'`) != 30000 {
			t.Error("not all 30,000 customers were created")
		}
	})

	// ── ERP SKU mapping (plan 4.2) + global SKU check ───────────
	const (
		zAlpha = "00000000-0000-4000-8f10-0000000000a1"
		zBeta  = "00000000-0000-4000-8f10-0000000000a2"
		zLeg1  = "00000000-0000-4000-8f10-0000000000a3"
		zLeg2  = "00000000-0000-4000-8f10-0000000000a4"
		zA50   = "00000000-0000-4000-8f10-0000000000b1"
		zA100  = "00000000-0000-4000-8f10-0000000000b2"
		zB50   = "00000000-0000-4000-8f10-0000000000b3"
		zL1    = "00000000-0000-4000-8f10-0000000000b4"
		zL2    = "00000000-0000-4000-8f10-0000000000b5"
		skuMap = "/admin/erp/sku-mapping/import"
		skuHdr = "variant_id,product,size,sku,has_stock,barcode,fg_code,fg_slug,erp_group_key\n"
	)
	adminOnly := router.With(authWrap, mw.RequireRole("admin"))
	adminOnly.Get("/admin/erp/sku-mapping/export", h.ExportSkuMapping)
	adminOnly.Post(skuMap, h.ImportSkuMapping)
	productsRW := router.With(authWrap, mw.RequirePermission("manage_products"))
	productsRW.Post("/products", h.CreateProduct)
	productsRW.Put("/products/{id}", h.UpdateProduct)
	do := func(method, token, path string, body any) (int, []byte) {
		cur.Helper()
		var rdr *bytes.Reader
		if body == nil {
			rdr = bytes.NewReader(nil)
		} else {
			raw, err := json.Marshal(body)
			if err != nil {
				cur.Fatal(err)
			}
			rdr = bytes.NewReader(raw)
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.Bytes()
	}
	exec(`INSERT INTO products(id,name) VALUES($1,'ZMap Alpha'),($2,'ZMap Beta'),($3,'ZMap Leg One'),($4,'ZMap Leg Two')`, zAlpha, zBeta, zLeg1, zLeg2)
	exec(`INSERT INTO product_variants(id,product_id,size,price,sku,barcode) VALUES
		($1,$6,'100 ml',200000,'ZA-100','ZA-100'),($2,$6,'50 ml',100000,'ZA-50','ZA-50'),
		($3,$7,'50 ml',100000,'ZB-50','ZB-50'),
		($4,$8,'50 ml',100000,'LEG-DUP','LEG-BC1'),($5,$9,'50 ml',100000,'LEG-DUP','LEG-BC2')`,
		zA100, zA50, zB50, zL1, zL2, zAlpha, zBeta, zLeg1, zLeg2)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'50 ml',3)`, outlet, zAlpha)
	exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,'50 ml',2),($1,$3,'50 ml',0)`, wh, zBeta, zAlpha)
	variantState := func() string {
		cur.Helper()
		return text(`SELECT string_agg(v.id::text||'|'||v.size||'|'||v.sku||'|'||v.barcode||'|'||COALESCE(v.erp_slug,'-')||'|'||COALESCE(p.erp_group_key,'-'), ';' ORDER BY v.id)
		              FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.name LIKE 'ZMap%'`)
	}
	exportCSV := func() [][]string {
		cur.Helper()
		code, raw := do(http.MethodGet, tok, "/admin/erp/sku-mapping/export", nil)
		if code != http.StatusOK {
			cur.Fatalf("export -> %d %s", code, raw)
		}
		recs, err := csv.NewReader(bytes.NewReader(raw)).ReadAll()
		if err != nil {
			cur.Fatalf("export is not CSV: %v", err)
		}
		return recs
	}

	sub("sku-mapping: validateVariants refuses a new or changed SKU used by another product (409)", func(t *testing.T) {
		before := variantState()
		// change Alpha 50 ml to Beta's SKU
		code, raw := do(http.MethodPut, tok, "/products/"+zAlpha, map[string]any{"name": "ZMap Alpha", "isActive": true, "variants": []map[string]any{
			{"id": zA100, "size": "100 ml", "price": 200000, "sku": "ZA-100"},
			{"id": zA50, "size": "50 ml", "price": 100000, "sku": "ZB-50"}}})
		if code != http.StatusConflict || !strings.Contains(string(raw), "SKU sudah dipakai produk lain: ZB-50") {
			t.Fatalf("changed SKU -> %d %s, want 409", code, raw)
		}
		// a brand-new variant with a taken SKU
		code, raw = do(http.MethodPut, tok, "/products/"+zAlpha, map[string]any{"name": "ZMap Alpha", "isActive": true, "variants": []map[string]any{
			{"id": zA100, "size": "100 ml", "price": 200000, "sku": "ZA-100"},
			{"id": zA50, "size": "50 ml", "price": 100000, "sku": "ZA-50"},
			{"size": "30 ml", "price": 50000, "sku": "ZB-50"}}})
		if code != http.StatusConflict {
			t.Fatalf("new variant with taken SKU -> %d %s, want 409", code, raw)
		}
		code, raw = do(http.MethodPost, tok, "/products", map[string]any{"name": "ZMap Create", "isActive": true, "variants": []map[string]any{
			{"size": "50 ml", "price": 1, "sku": "ZB-50"}}})
		if code != http.StatusConflict || count(`SELECT count(*) FROM products WHERE name='ZMap Create'`) != 0 {
			t.Fatalf("create with taken SKU -> %d %s, want 409 and no row", code, raw)
		}
		if variantState() != before {
			t.Error("a refused save changed variants")
		}
	})

	sub("sku-mapping: an unchanged legacy duplicate SKU still saves (200)", func(t *testing.T) {
		code, raw := do(http.MethodPut, tok, "/products/"+zLeg2, map[string]any{"name": "ZMap Leg Two", "isActive": true, "variants": []map[string]any{
			{"id": zL2, "size": "50 ml", "price": 123000, "sku": "LEG-DUP"}}})
		if code != http.StatusOK {
			t.Fatalf("unchanged legacy duplicate -> %d %s, want 200", code, raw)
		}
		if count(`SELECT count(*) FROM product_variants WHERE id=$1 AND price=123000`, zL2) != 1 {
			t.Error("the save did not apply")
		}
	})

	sub("sku-mapping: admin only (403 for non-admin on export and import)", func(t *testing.T) {
		if code, _ := do(http.MethodGet, noPerm, "/admin/erp/sku-mapping/export", nil); code != http.StatusForbidden {
			t.Errorf("export as cashier = %d, want 403", code)
		}
		if code, _ := call(noPerm, skuMap, map[string]any{"csv": "x", "dryRun": true}, ""); code != http.StatusForbidden {
			t.Errorf("import as cashier = %d, want 403", code)
		}
	})

	sub("sku-mapping: export has the exact columns, one row per variant, has_stock and empty fg columns", func(t *testing.T) {
		recs := exportCSV()
		if strings.Join(recs[0], ",") != "variant_id,product,size,sku,has_stock,barcode,fg_code,fg_slug,erp_group_key" {
			t.Fatalf("header = %v", recs[0])
		}
		if len(recs)-1 != count(`SELECT count(*) FROM product_variants`) {
			t.Errorf("rows = %d, want one per variant", len(recs)-1)
		}
		by := map[string][]string{}
		var order []string
		for _, r := range recs[1:] {
			by[r[0]] = r
			if strings.HasPrefix(r[1], "ZMap Alpha") || strings.HasPrefix(r[1], "ZMap Beta") {
				order = append(order, r[0])
			}
		}
		if strings.Join(order, ",") != strings.Join([]string{zA100, zA50, zB50}, ",") {
			t.Errorf("order (product name, size text) = %v", order)
		}
		for id, want := range map[string]string{zA50: "true", zA100: "false", zB50: "true"} {
			if by[id][4] != want {
				t.Errorf("has_stock(%s) = %s, want %s (outlet or warehouse stock)", id, by[id][4], want)
			}
			if by[id][6] != "" || by[id][7] != "" || by[id][8] != "" {
				t.Errorf("unlinked variant must have empty fg/group columns: %v", by[id])
			}
		}
	})

	sub("sku-mapping: dry run writes nothing", func(t *testing.T) {
		before, v, runs := variantState(), versions(), count(`SELECT count(*) FROM import_runs`)
		rep := preview(skuMap, skuHdr+zA50+",,,,,,FG-A50,slug-a50,grp-a\n")
		if rep.Summary.Update != 1 || rep.HasErrors() {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
		if variantState() != before || versions() != v || count(`SELECT count(*) FROM import_runs`) != runs {
			t.Error("a dry run changed data, versions or import_runs")
		}
	})

	sub("sku-mapping: invalid files are 422 with zero writes", func(t *testing.T) {
		cases := map[string]string{
			"duplicate fg_code":       zA50 + ",,,,,,FG-D,s1,\n" + zA100 + ",,,,,,FG-D,s2,\n",
			"duplicate fg_slug":       zA50 + ",,,,,,FG-1,sd,\n" + zA100 + ",,,,,,FG-2,sd,\n",
			"variant listed twice":    zA50 + ",,,,,,FG-1,s1,\n" + zA50 + ",,,,,,FG-2,s2,\n",
			"unknown variant id":      "00000000-0000-4000-8f10-0000000000ff,,,,,,FG-1,s1,\n",
			"fg_code used by another": zA50 + ",,,,,,ZB-50,s1,\n",
			"only fg_code given":      zA50 + ",,,,,,FG-1,,\n",
			"group key disagrees":     zA50 + ",,,,,,FG-1,s1,k1\n" + zA100 + ",,,,,,FG-2,s2,k2\n",
		}
		for name, body := range cases {
			before, v := variantState(), versions()
			csv := skuHdr + body
			rep := preview(skuMap, csv)
			if !rep.HasErrors() {
				t.Errorf("%s: preview has no error: %+v", name, rep.Summary)
				continue
			}
			if code, raw := commit(skuMap, csv, rep, "skumap-bad-"+strings.ReplaceAll(name, " ", "-")); code != http.StatusUnprocessableEntity {
				t.Errorf("%s: commit -> %d %s, want 422", name, code, raw)
			}
			if variantState() != before || versions() != v {
				t.Errorf("%s: rejected file wrote data", name)
			}
		}
	})

	sub("sku-mapping: fg_slug already linked to another variant is a 422", func(t *testing.T) {
		exec(`UPDATE product_variants SET erp_slug='taken-slug' WHERE id=$1`, zB50)
		defer exec(`UPDATE product_variants SET erp_slug=NULL WHERE id=$1`, zB50)
		before := variantState()
		csv := skuHdr + zA50 + ",,,,,,FG-1,taken-slug,\n"
		rep := preview(skuMap, csv)
		if !rep.HasErrors() {
			t.Fatalf("no error: %+v", rep.Issues)
		}
		if code, raw := commit(skuMap, csv, rep, "skumap-slug"); code != http.StatusUnprocessableEntity {
			t.Errorf("commit -> %d %s, want 422", code, raw)
		}
		if variantState() != before {
			t.Error("rejected file wrote data")
		}
	})

	sub("sku-mapping: apply sets sku/erp_slug/group key, keeps barcode and size, bumps products once; re-upload is all skips", func(t *testing.T) {
		prodBefore := manifest("products")
		csv := skuHdr +
			zA50 + ",ZMap Alpha,50 ml,ZA-50,true,ZA-50,FG-A50,slug-a50,grp-alpha\n" +
			zA100 + ",ZMap Alpha,100 ml,ZA-100,false,ZA-100,FG-A100,slug-a100,grp-alpha\n" +
			zB50 + ",ZMap Beta,50 ml,ZB-50,true,ZB-50,,,\n"
		rep := mustApply(skuMap, csv, "skumap-apply")
		if rep.Summary.Update != 2 || rep.Summary.Skip != 1 || rep.Summary.Error != 0 || rep.RunID == "" {
			t.Fatalf("%+v", rep.Summary)
		}
		if count(`SELECT count(*) FROM product_variants WHERE id=$1 AND sku='FG-A50' AND erp_slug='slug-a50' AND barcode='ZA-50' AND size='50 ml'`, zA50) != 1 ||
			count(`SELECT count(*) FROM product_variants WHERE id=$1 AND sku='FG-A100' AND erp_slug='slug-a100' AND barcode='ZA-100' AND size='100 ml'`, zA100) != 1 {
			t.Errorf("variant fields wrong: %s", variantState())
		}
		if count(`SELECT count(*) FROM product_variants WHERE id=$1 AND sku='ZB-50' AND erp_slug IS NULL`, zB50) != 1 {
			t.Error("the unmapped row must be untouched")
		}
		if text(`SELECT erp_group_key FROM products WHERE id=$1`, zAlpha) != "grp-alpha" {
			t.Error("group key not set")
		}
		if got := manifest("products"); got != prodBefore+1 {
			t.Errorf("products bumped %d times, want once", got-prodBefore)
		}
		if count(`SELECT count(*) FROM import_runs WHERE kind='sku_mapping' AND idempotency_key='skumap-apply'`) != 1 {
			t.Error("one sku_mapping import_runs row expected")
		}

		// the export now shows the link
		for _, r := range exportCSV()[1:] {
			if r[0] == zA50 && (r[3] != "FG-A50" || r[6] != "FG-A50" || r[7] != "slug-a50" || r[8] != "grp-alpha") {
				t.Errorf("export of a linked variant = %v", r)
			}
		}

		// re-upload: all skips, nothing bumped
		v := versions()
		again := mustApply(skuMap, csv, "skumap-apply-2")
		if again.Summary.Update != 0 || again.Summary.Skip != 3 || versions() != v {
			t.Errorf("re-upload: %+v (versions changed: %v)", again.Summary, versions() != v)
		}
		// replay of the first key returns the stored result without writing
		if code, _ := commit(skuMap, csv, rep, "skumap-apply"); code != http.StatusOK {
			t.Errorf("replay -> %d, want 200", code)
		}
	})

	sub("sku-mapping: an fg_code held by another variant is refused after the mapping too", func(t *testing.T) {
		before := variantState()
		rep := preview(skuMap, skuHdr+zB50+",,,,,,FG-A50,slug-b50,\n")
		if !rep.HasErrors() {
			t.Fatalf("fg_code in use must be an error: %+v", rep.Issues)
		}
		if variantState() != before {
			t.Error("preview wrote data")
		}
	})

	sub("sku-mapping: a SKU swap and a chain inside one product apply cleanly (barcode and size untouched)", func(t *testing.T) {
		const (
			pSwap, pChain = "00000000-0000-4000-8f10-0000000000a5", "00000000-0000-4000-8f10-0000000000a6"
			s1, s2        = "00000000-0000-4000-8f10-0000000000c1", "00000000-0000-4000-8f10-0000000000c2"
			c1, c2        = "00000000-0000-4000-8f10-0000000000c3", "00000000-0000-4000-8f10-0000000000c4"
		)
		exec(`INSERT INTO products(id,name) VALUES($1,'ZMap Swap'),($2,'ZMap Chain')`, pSwap, pChain)
		exec(`INSERT INTO product_variants(id,product_id,size,price,sku,barcode) VALUES
			($1,$5,'50 ml',1,'SW-X','SW-BC1'),($2,$5,'100 ml',1,'SW-Y','SW-BC2'),
			($3,$6,'50 ml',1,'CH-1','CH-BC1'),($4,$6,'100 ml',1,'CH-2','CH-BC2')`, s1, s2, c1, c2, pSwap, pChain)
		rep := mustApply(skuMap, skuHdr+
			s1+",,,,,,SW-Y,slug-sw1,\n"+s2+",,,,,,SW-X,slug-sw2,\n"+
			c1+",,,,,,CH-2,slug-ch1,\n"+c2+",,,,,,CH-3,slug-ch2,\n", "skumap-swap-chain")
		if rep.Summary.Update != 4 || rep.HasErrors() {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
		for id, want := range map[string]string{
			s1: "SW-Y|50 ml|SW-BC1|slug-sw1", s2: "SW-X|100 ml|SW-BC2|slug-sw2",
			c1: "CH-2|50 ml|CH-BC1|slug-ch1", c2: "CH-3|100 ml|CH-BC2|slug-ch2"} {
			if got := text(`SELECT sku||'|'||size||'|'||barcode||'|'||erp_slug FROM product_variants WHERE id=$1`, id); got != want {
				t.Errorf("%s = %s, want %s", id, got, want)
			}
		}
		if count(`SELECT count(*) FROM product_variants WHERE sku LIKE 'tmp:%'`) != 0 {
			t.Error("a temporary SKU was left behind")
		}
	})

	sub("sku-mapping: an erp_group_key on a row without fg_code and fg_slug is a row error", func(t *testing.T) {
		before := variantState()
		rep := preview(skuMap, skuHdr+zB50+",,,,,,,,grp-orphan\n")
		if !rep.HasErrors() || rep.Summary.Error != 1 {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
		if variantState() != before {
			t.Error("preview wrote data")
		}
	})

	// ── ERP-owned fields are read-only on linked rows (plan 4.5) ──
	const (
		eLinked = "00000000-0000-4000-8f10-0000000000d1"
		ePlain  = "00000000-0000-4000-8f10-0000000000d2"
		eOutlet = "00000000-0000-4000-8f10-0000000000d3"
		eV50    = "00000000-0000-4000-8f10-0000000000e1"
		eV100   = "00000000-0000-4000-8f10-0000000000e2"
		eVPlain = "00000000-0000-4000-8f10-0000000000e3"
	)
	productsRW.Delete("/products/{id}", h.DeleteProduct)
	adminOnly.Put("/outlets/{id}", h.UpdateOutlet)
	catKeep := text(`INSERT INTO categories(name) VALUES('ZErp Keep') RETURNING id::text`)
	catOther := text(`INSERT INTO categories(name) VALUES('ZErp Other') RETURNING id::text`)
	exec(`INSERT INTO products(id,name,brand,category_id,erp_group_key) VALUES($1,'ZErp Linked','ZBrand',$3,'grp-zerp'),($2,'ZErp Plain','ZBrand',$3,NULL)`, eLinked, ePlain, catKeep)
	exec(`INSERT INTO product_variants(id,product_id,size,price,sku,barcode,erp_slug,is_active) VALUES
		($1,$4,'50 ml',100000,'ZE-50','ZE-BC50','slug-ze50',true),($2,$4,'100 ml',180000,'ZE-100','ZE-BC100','slug-ze100',false),
		($3,$5,'50 ml',90000,'ZP-50','ZP-BC50',NULL,true)`, eV50, eV100, eVPlain, eLinked, ePlain)
	exec(`INSERT INTO outlets(id,name,code,address,phone,erp_slug,erp_code) VALUES($1,'ZErp Outlet','ZE1','Jl. ERP 1',NULL,'slug-outlet','ERP-01')`, eOutlet)
	nstr := func(n nullable.Nullable[string]) string {
		v, _ := n.Get()
		return v
	}
	variantBody := func(id, size, sku string, price float64, bc string) map[string]any {
		m := map[string]any{"size": size, "sku": sku, "price": price, "barcode": bc}
		if id != "" {
			m["id"] = id
		}
		return m
	}
	linkedPayload := func(name, cat string, vs ...map[string]any) map[string]any {
		return map[string]any{"name": name, "brand": "ZBrand", "categoryId": cat, "isActive": true, "sellable": true, "variants": vs}
	}
	erpState := func() string {
		cur.Helper()
		return text(`SELECT (SELECT string_agg(p.id::text||'|'||p.name||'|'||COALESCE(p.category_id::text,'')||'|'||p.is_active::text, ';' ORDER BY p.id) FROM products p WHERE p.name LIKE 'ZErp%')
		  || '#' || (SELECT string_agg(v.id::text||'|'||v.size||'|'||v.sku||'|'||v.price::text||'|'||v.barcode, ';' ORDER BY v.id) FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.name LIKE 'ZErp%')`)
	}

	sub("erp-owned: the read JSON exposes erpGroupKey, erpLinked and the variants' erpSlug and isActive (both branches)", func(t *testing.T) {
		for _, sc := range []read.Scope{{CrossAll: true}, {OutletID: outlet}} {
			p, err := rd.Product(ctx, sc, eLinked)
			if err != nil {
				t.Fatal(err)
			}
			if p.ErpLinked == nil || !*p.ErpLinked || nstr(p.ErpGroupKey) != "grp-zerp" {
				t.Errorf("scope %+v: linked product = erpLinked %v key %v", sc, p.ErpLinked, p.ErpGroupKey)
			}
			slugs := map[string]bool{}
			for _, v := range p.Variants {
				if s := nstr(v.ErpSlug); s != "" {
					slugs[s] = true
				}
				if v.IsActive == nil {
					t.Errorf("scope %+v: variant %s has no isActive", sc, v.Sku)
				} else if v.Sku == "ZE-100" && *v.IsActive {
					t.Errorf("scope %+v: inactive variant reads active", sc)
				}
			}
			if !slugs["slug-ze50"] || !slugs["slug-ze100"] {
				t.Errorf("scope %+v: variant slugs %v", sc, slugs)
			}
			pl, err := rd.Product(ctx, sc, ePlain)
			if err != nil {
				t.Fatal(err)
			}
			if pl.ErpLinked == nil || *pl.ErpLinked || nstr(pl.ErpGroupKey) != "" || nstr(pl.Variants[0].ErpSlug) != "" {
				t.Errorf("scope %+v: plain product reads linked: %v %v", sc, pl.ErpLinked, pl.ErpGroupKey)
			}
		}
		outs, _, err := rd.Outlets(ctx)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, o := range outs {
			if o.Id.String() == eOutlet {
				found = true
				if nstr(o.ErpSlug) != "slug-outlet" || nstr(o.ErpCode) != "ERP-01" {
					t.Errorf("outlet erp fields: %v %v", o.ErpSlug, o.ErpCode)
				}
			}
		}
		if !found {
			t.Error("linked outlet missing from the read")
		}
	})

	sub("erp-owned: a linked product's name and category are POS-owned: a change is a 200 and is written", func(t *testing.T) {
		vs := []map[string]any{variantBody(eV50, "50 ml", "ZE-50", 100000, "ZE-BC50"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100")}
		code, raw := do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Renamed", catOther, vs...))
		if code != http.StatusOK || count(`SELECT count(*) FROM products WHERE id=$1 AND name='ZErp Renamed' AND category_id=$2`, eLinked, catOther) != 1 {
			t.Fatalf("name+category change -> %d %s, want 200 and written", code, raw)
		}
		// restore, later subtests expect the original name and category
		if code, raw = do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Linked", catKeep, vs...)); code != http.StatusOK ||
			count(`SELECT count(*) FROM products WHERE id=$1 AND name='ZErp Linked' AND category_id=$2`, eLinked, catKeep) != 1 {
			t.Fatalf("restore -> %d %s", code, raw)
		}
	})

	sub("erp-owned: an unchanged save, and a price or barcode change, on a linked product is a 200", func(t *testing.T) {
		code, raw := do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Linked", catKeep,
			variantBody(eV50, "50 ml", "ZE-50", 110000, "ZE-BC50"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100-NEW")))
		if code != http.StatusOK {
			t.Fatalf("price/barcode change -> %d %s, want 200", code, raw)
		}
		if count(`SELECT count(*) FROM product_variants WHERE id=$1 AND price=110000`, eV50) != 1 ||
			count(`SELECT count(*) FROM product_variants WHERE id=$1 AND barcode='ZE-BC100-NEW'`, eV100) != 1 {
			t.Error("price or barcode was not applied")
		}
		code, raw = do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Linked", catKeep,
			variantBody(eV50, "50 ml", "ZE-50", 110000, "ZE-BC50"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100-NEW")))
		if code != http.StatusOK {
			t.Fatalf("unchanged save -> %d %s, want 200", code, raw)
		}
	})

	sub("erp-owned: a linked variant's size or SKU change, and dropping it, is a 409", func(t *testing.T) {
		before := erpState()
		for name, body := range map[string]map[string]any{
			"size": linkedPayload("ZErp Linked", catKeep,
				variantBody(eV50, "30 ml", "ZE-50", 110000, "ZE-BC50"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100-NEW")),
			"sku": linkedPayload("ZErp Linked", catKeep,
				variantBody(eV50, "50 ml", "ZE-50X", 110000, "ZE-BC50"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100-NEW")),
			"drop": linkedPayload("ZErp Linked", catKeep, variantBody(eV50, "50 ml", "ZE-50", 110000, "ZE-BC50")),
		} {
			code, raw := do(http.MethodPut, tok, "/products/"+eLinked, body)
			if code != http.StatusConflict || !strings.Contains(string(raw), "ERP") {
				t.Errorf("%s -> %d %s, want 409", name, code, raw)
			}
		}
		if erpState() != before {
			t.Error("a refused save changed data")
		}
	})

	sub("erp-owned: adding an unlinked variant to a linked product is a 200; it can be removed again", func(t *testing.T) {
		code, raw := do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Linked", catKeep,
			variantBody(eV50, "50 ml", "ZE-50", 110000, "ZE-BC50"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100-NEW"),
			variantBody("", "30 ml", "ZE-30", 50000, "ZE-BC30")))
		if code != http.StatusOK || count(`SELECT count(*) FROM product_variants WHERE sku='ZE-30' AND erp_slug IS NULL`) != 1 {
			t.Fatalf("add unlinked variant -> %d %s", code, raw)
		}
		code, raw = do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Linked", catKeep,
			variantBody(eV50, "50 ml", "ZE-50", 110000, "ZE-BC50"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100-NEW")))
		if code != http.StatusOK || count(`SELECT count(*) FROM product_variants WHERE sku='ZE-30'`) != 0 {
			t.Fatalf("remove the unlinked variant -> %d %s", code, raw)
		}
	})

	sub("erp-owned: an unlinked product still renames freely, and an unlinked product deletes", func(t *testing.T) {
		code, raw := do(http.MethodPut, tok, "/products/"+ePlain, linkedPayload("ZErp Plain Renamed", catOther,
			variantBody(eVPlain, "60 ml", "ZP-60", 91000, "ZP-BC50")))
		if code != http.StatusOK || count(`SELECT count(*) FROM products WHERE id=$1 AND name='ZErp Plain Renamed' AND category_id=$2`, ePlain, catOther) != 1 {
			t.Fatalf("unlinked rename -> %d %s", code, raw)
		}
		if code, raw = do(http.MethodDelete, tok, "/products/"+ePlain, nil); code != http.StatusOK || count(`SELECT count(*) FROM products WHERE id=$1`, ePlain) != 0 {
			t.Fatalf("unlinked delete -> %d %s", code, raw)
		}
	})

	sub("erp-owned: deleting an ERP-linked product is a 409 and the product stays", func(t *testing.T) {
		code, raw := do(http.MethodDelete, tok, "/products/"+eLinked, nil)
		if code != http.StatusConflict || !strings.Contains(string(raw), "dikelola ERP") || count(`SELECT count(*) FROM products WHERE id=$1`, eLinked) != 1 {
			t.Fatalf("linked delete -> %d %s, want 409", code, raw)
		}
	})

	sub("erp-owned: a linked outlet's name, address and phone are POS-owned and editable; code and an empty phone too", func(t *testing.T) {
		put := func(name, code, address, phone string) (int, []byte) {
			return do(http.MethodPut, tok, "/outlets/"+eOutlet, map[string]any{"name": name, "code": code, "address": address, "phone": phone, "isActive": true})
		}
		if code, raw := put("ZErp Outlet Baru", "ZE1", "Jl. Lain", "0812"); code != http.StatusOK ||
			text(`SELECT name||'|'||address||'|'||phone FROM outlets WHERE id=$1`, eOutlet) != "ZErp Outlet Baru|Jl. Lain|0812" {
			t.Fatalf("name/address/phone change -> %d %s, want 200 and written", code, raw)
		}
		if code, raw := put("ZErp Outlet", "ZE1-NEW", "Jl. ERP 1", ""); code != http.StatusOK {
			t.Fatalf("restore + code change (empty phone = stored NULL) -> %d %s, want 200", code, raw)
		}
		if text(`SELECT code FROM outlets WHERE id=$1`, eOutlet) != "ZE1-NEW" {
			t.Error("the code change was not applied")
		}
	})

	sub("erp-owned: a CSV row of a linked product applies the category (POS-owned), warns and skips size, and still applies price and barcode", func(t *testing.T) {
		csv := prodHeader + "ZErp Linked,ZBrand,ZErp Other,,40 ml,125.000,ZE-50,ZE-BC50-CSV,,,\n"
		rep := mustApply("/products/import", csv, "p-erp-1")
		if rep.Summary.Error != 0 || rep.Summary.Update != 1 || rep.Summary.Warning != 1 || rep.Summary.NewCategories != 0 {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
		codes := map[string]bool{}
		for _, i := range rep.Issues {
			if i.Code == "erp_owned" && i.Severity == csvimport.SevWarning {
				codes[i.Column] = true
			}
		}
		if codes["Kategori"] || !codes["Ukuran"] {
			t.Errorf("want an erp_owned warning on Ukuran only: %+v", rep.Issues)
		}
		if got := text(`SELECT p.name||'|'||p.category_id::text||'|'||v.size||'|'||v.price::text||'|'||v.barcode
		                  FROM products p JOIN product_variants v ON v.product_id=p.id WHERE v.id=$1`, eV50); got != "ZErp Linked|"+catOther+"|50 ml|125000.00|ZE-BC50-CSV" {
			t.Errorf("after the import: %s", got)
		}
	})

	sub("erp-owned: a CSV row moving the category back and keeping the size is no warning, and a linked product's Aktif still applies", func(t *testing.T) {
		csv := prodHeader + "ZErp Linked,ZBrand,ZErp Keep,,50 ml,125000,ZE-50,,,Tidak,\n"
		rep := mustApply("/products/import", csv, "p-erp-2")
		if rep.Summary.Warning != 0 || rep.Summary.Error != 0 || rep.Summary.Update != 1 {
			t.Fatalf("%+v %+v", rep.Summary, rep.Issues)
		}
		if count(`SELECT count(*) FROM products WHERE id=$1 AND NOT is_active`, eLinked) != 1 {
			t.Error("is_active is admin-owned and must apply")
		}
	})

	sub("erp-owned: a variant sent without an id but with a linked SKU and a new size is a 409", func(t *testing.T) {
		before := erpState()
		code, raw := do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Linked", catKeep,
			variantBody("", "30 ml", "ZE-50", 125000, "ZE-BC50-CSV"), variantBody(eV100, "100 ml", "ZE-100", 180000, "ZE-BC100-NEW")))
		if code != http.StatusConflict || !strings.Contains(string(raw), "ERP") {
			t.Fatalf("-> %d %s, want 409", code, raw)
		}
		if erpState() != before {
			t.Error("a refused save changed data")
		}
	})

	sub("erp-owned: a whitespace-only difference on a linked variant passes and the STORED size and SKU are kept", func(t *testing.T) {
		code, raw := do(http.MethodPut, tok, "/products/"+eLinked, linkedPayload("ZErp Linked", catKeep,
			variantBody(eV50, " 50 ml ", "ZE-50 ", 126000, "ZE-BC50-CSV"), variantBody(eV100, "100 ml", " ZE-100", 180000, "ZE-BC100-NEW")))
		if code != http.StatusOK {
			t.Fatalf("product -> %d %s, want 200", code, raw)
		}
		if got := text(`SELECT p.name||'|'||v.size||'|'||v.sku||'|'||v.price::text FROM products p JOIN product_variants v ON v.product_id=p.id WHERE v.id=$1`, eV50); got != "ZErp Linked|50 ml|ZE-50|126000.00" {
			t.Errorf("stored values drifted: %q", got)
		}
		if got := text(`SELECT sku FROM product_variants WHERE id=$1`, eV100); got != "ZE-100" {
			t.Errorf("sku drifted: %q", got)
		}
	})
}
