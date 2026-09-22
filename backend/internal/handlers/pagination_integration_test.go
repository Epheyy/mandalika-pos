package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Fresh synthetic cluster only; exact target + data directory + empty schema.
// Never loads application secrets or reuses a stopped historical fixture.
func TestPaginationPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_A26_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated A26 pagination PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56443 || cfg.ConnConfig.Database != "mandalika_a26_synthetic" || cfg.ConnConfig.User != "a26_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var dir string
	if err = pool.QueryRow(ctx, "SHOW data_directory").Scan(&dir); err != nil {
		t.Fatal(err)
	}
	expected := os.Getenv("MANDALIKA_A26_TEST_DATA_DIR")
	if expected == "" || filepath.Clean(dir) != filepath.Clean(expected) {
		t.Fatal("fixture directory mismatch")
	}
	var tables int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("fixture must be empty: tables=%d err=%v", tables, err)
	}
	if err = (&db.DB{Pool: pool}).Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	const cashier = "00000000-0000-4000-8600-000000000001"
	outletID := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8601-%012d", n) }
	shiftID := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8602-%012d", n) }
	for _, n := range []int{0, 51, 201, 1000} {
		exec(`INSERT INTO outlets(id,name) VALUES($1,'A26 synthetic')`, outletID(n))
		exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at) VALUES($1,$2,$3,'A26','open','2026-09-21T01:00:00Z')`, shiftID(n), outletID(n), cashier)
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id,created_at)
  SELECT ('00000000-0000-4000-8603-'||lpad(($4::int*10000+i)::text,12,'0'))::uuid,gen_random_uuid(),'A26-'||$4::text||'-'||i,'a26:'||$4::text||':'||i,$1,$2,'A26',1000,1000,'cash','completed',$3,'2026-09-21T02:00:00Z' FROM generate_series(1,$4::int) i`, outletID(n), cashier, shiftID(n), n)
	}
	exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at) SELECT ('00000000-0000-4000-8604-'||lpad(i::text,12,'0'))::uuid,$1,$2,'A26 past','closed','2026-09-20T01:00:00Z' FROM generate_series(1,250) i`, outletID(1000), cashier)
	exec(`INSERT INTO cash_flows(id,outlet_id,shift_id,type,amount,description,created_at) SELECT ('00000000-0000-4000-8605-'||lpad(i::text,12,'0'))::uuid,$1,$2,'in',100,'A26 synthetic','2026-09-21T02:00:00Z' FROM generate_series(1,401) i`, outletID(1000), shiftID(1000))
	exec(`INSERT INTO products(id,name,created_at) SELECT ('00000000-0000-4000-8606-'||lpad(i::text,12,'0'))::uuid,'A26 product '||i,'2026-09-21T02:00:00Z' FROM generate_series(1,201) i`)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) SELECT id,'M',1000,10,'A26-'||id FROM products`)

	h := New(read.New(pool), nil, nil, nil, nil, nil, nil)
	secret := []byte("A26-SYNTHETIC-TEST-KEY")
	wrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/orders", h.Orders)
	mux.HandleFunc("/api/v1/shifts", h.Shifts)
	mux.HandleFunc("/api/v1/cash-flows", h.CashFlows)
	mux.HandleFunc("/api/v1/products", h.Products)
	handler := wrap(mux)
	fetch := func(t *testing.T, outlet, path string) json.RawMessage {
		t.Helper()
		token, err := auth.IssueAccess(secret, time.Hour, cashier, "cashier", outlet, []string{})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("GET %s: %d %s", path, w.Code, w.Body.String())
		}
		return append(json.RawMessage{}, w.Body.Bytes()...)
	}
	type row struct {
		ID     string  `json:"id"`
		Outlet string  `json:"outletId"`
		Total  float64 `json:"total"`
	}
	type response struct {
		Data []row                            `json:"data"`
		Meta struct{ Total, Page, Limit int } `json:"meta"`
	}
	type record struct {
		Name  string            `json:"name"`
		Total int               `json:"total"`
		Pages []json.RawMessage `json:"pages"`
	}
	records := []record{}
	verify := func(t *testing.T, name, path string, n, total int, scoped bool) {
		t.Helper()
		record := record{Name: name, Total: total}
		ids := map[string]bool{}
		last := ""
		sum := 0.0
		for page := 1; page <= max(1, (total+199)/200); page++ {
			raw := fetch(t, outletID(n), fmt.Sprintf("%s&page=%d&limit=200", path, page))
			var r response
			if err := json.Unmarshal(raw, &r); err != nil {
				t.Fatal(err)
			}
			if r.Meta.Page != page || r.Meta.Limit != 200 || r.Meta.Total != total {
				t.Fatalf("%s metadata %+v", name, r.Meta)
			}
			if len(r.Data) != min(200, total-(page-1)*200) {
				t.Fatalf("%s row count %d", name, len(r.Data))
			}
			for _, v := range r.Data {
				if ids[v.ID] {
					t.Fatalf("%s duplicate %s", name, v.ID)
				}
				ids[v.ID] = true
				// Orders/cash flows/products fixtures deliberately tie every timestamp.
				if name != "shifts" && last != "" && last <= v.ID {
					t.Fatalf("%s non-deterministic tie ordering", name)
				}
				last = v.ID
				if scoped && v.Outlet != outletID(n) {
					t.Fatalf("%s outlet scope escaped", name)
				}
				sum += v.Total
			}
			record.Pages = append(record.Pages, raw)
		}
		if len(ids) != total {
			t.Fatal("incomplete IDs")
		}
		if name == fmt.Sprintf("orders-%d", n) && sum != float64(n*1000) {
			t.Fatal("incomplete order total")
		}
		records = append(records, record)
		t.Logf("%s: %d unique rows in %d pages; total=%.0f", name, total, len(record.Pages), sum)
	}
	for _, n := range []int{0, 51, 201, 1000} {
		t.Run(fmt.Sprintf("orders-%d", n), func(t *testing.T) { verify(t, fmt.Sprintf("orders-%d", n), "/api/v1/orders?outletId=all", n, n, true) })
		if n > 0 {
			t.Run(fmt.Sprintf("old-limit-truncation-%d", n), func(t *testing.T) {
				for _, limit := range []int{500, 1000} {
					var r response
					raw := fetch(t, outletID(n), fmt.Sprintf("/api/v1/orders?limit=%d", limit))
					if err := json.Unmarshal(raw, &r); err != nil {
						t.Fatal(err)
					}
					if len(r.Data) != 50 || r.Meta.Limit != 50 || r.Meta.Total != n {
						t.Fatalf("legacy cap mismatch %+v", r.Meta)
					}
					t.Logf("request limit=%d receives50 of%d", limit, n)
				}
			})
		}
	}
	t.Run("shifts-251", func(t *testing.T) { verify(t, "shifts", "/api/v1/shifts?", 1000, 251, true) })
	t.Run("flows-401", func(t *testing.T) { verify(t, "flows", "/api/v1/cash-flows?shiftId="+shiftID(1000), 1000, 401, true) })
	t.Run("products-201", func(t *testing.T) { verify(t, "products", "/api/v1/products?", 1000, 201, false) })
	t.Run("shift-and-date-filters", func(t *testing.T) {
		verify(t, "filtered", "/api/v1/orders?shiftId="+shiftID(201)+"&from=2026-09-21&to=2026-09-21", 201, 201, true)
		verify(t, "empty-date", "/api/v1/orders?from=2026-09-22", 201, 0, true)
		verify(t, "foreign-shift", "/api/v1/orders?shiftId="+shiftID(1000), 201, 0, true)
	})
	if path := os.Getenv("MANDALIKA_A26_TEST_OUTPUT"); path != "" {
		raw, err := json.Marshal(records)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}
