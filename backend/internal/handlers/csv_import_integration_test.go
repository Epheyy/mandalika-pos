package handlers

import (
	"bytes"
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
	pool, ctx := gatePool(t, "IM", 56456)
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
		exec(`UPDATE stock_counts SET status='completed' WHERE id=$1`, sc)
		if rep := preview("/products/import", rename); hasCode(rep, "size_in_flight") || rep.HasErrors() {
			t.Fatalf("a completed count must not block: %+v", rep.Issues)
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

	sub("products: an open document created between plan and apply makes the rename stale (409)", func(t *testing.T) {
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
		go func() { c, _ := commit("/products/import", csv, rep, "p-late-doc"); done <- c }()
		waitForLockWait(t)
		// a stock count for the OLD size appears after the import planned, before it applies
		sc := text(`INSERT INTO stock_counts(name,status,outlet_id) VALUES('late count','planned',$1) RETURNING id::text`, outlet)
		exec(`INSERT INTO stock_count_items(stock_count_id,product_id,product_name,variant_size) VALUES ($1,$2,'Melati','100 ml')`, sc, melatiID)
		if err = holder.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if code := <-done; code != http.StatusConflict {
			t.Errorf("commit status %d, want 409 import_stale", code)
		}
		if got := text(`SELECT size FROM product_variants WHERE sku='MEL-100'`); got != "100 ml" {
			t.Errorf("rename was applied despite the open count: %s", got)
		}
		if stockSnapshot() != before {
			t.Error("stale commit moved stock rows")
		}
		exec(`DELETE FROM stock_counts WHERE id=$1`, sc)
	})

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

}
