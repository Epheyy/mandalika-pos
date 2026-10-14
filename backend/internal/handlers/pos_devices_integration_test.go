package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// POS device registration: the server hands each install a receipt-number code per outlet.
// Opt-in synthetic cluster only.
func TestDeviceRegisterPostgres(t *testing.T) {
	dsn := os.Getenv("MANDALIKA_DV_TEST_DSN")
	if dsn == "" {
		t.Skip("isolated device-register PostgreSQL fixture not configured")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 56452 || cfg.ConnConfig.Database != "mandalika_dv_synthetic" || cfg.ConnConfig.User != "dv_test" {
		t.Fatal("refusing non-fixture target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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
	expected := os.Getenv("MANDALIKA_DV_TEST_DATA_DIR")
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

	const outletA = "00000000-0000-4000-8c00-000000000001"
	const outletB = "00000000-0000-4000-8c00-000000000002"
	const cashierA = "00000000-0000-4000-8c00-000000000011"
	const headOffice = "00000000-0000-4000-8c00-000000000013"
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'DV outlet A'),($2,'DV outlet B')`, outletA, outletB)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES
		($1,'a@example.invalid','x','DV cashier A','cashier',$3),
		($2,'ho@example.invalid','x','DV head office','admin',NULL)`, cashierA, headOffice, outletA)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("DV-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, nil)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokA := issue(cashierA, "cashier", outletA)
	tokHOatB := issue(headOffice, "admin", outletB)
	tokHONone := issue(headOffice, "admin", "")
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/pos/devices/register", h.RegisterPOSDevice)
	register := func(token, body string) (int, string) {
		r := httptest.NewRequest("POST", "/pos/devices/register", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	codeOf := func(token, deviceID string) string {
		t.Helper()
		code, body := register(token, fmt.Sprintf(`{"deviceId":%q}`, deviceID))
		var out struct {
			Data struct {
				Code string `json:"code"`
			} `json:"data"`
		}
		if code != 200 || json.Unmarshal([]byte(body), &out) != nil || out.Data.Code == "" {
			t.Fatalf("register: %d %s", code, body)
		}
		return out.Data.Code
	}
	dev := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8c00-0000000001%02d", n) }

	t.Run("same device twice returns the same code", func(t *testing.T) {
		first := codeOf(tokA, dev(1))
		if first != "AA" {
			t.Fatalf("first code = %s, want AA", first)
		}
		if again := codeOf(tokA, dev(1)); again != first {
			t.Fatalf("second call = %s, want %s", again, first)
		}
	})
	t.Run("a second device gets the next code", func(t *testing.T) {
		if got := codeOf(tokA, dev(2)); got != "AB" {
			t.Fatalf("code = %s, want AB", got)
		}
	})
	t.Run("the same device at another outlet gets a different code, stable per outlet", func(t *testing.T) {
		atB := codeOf(tokHOatB, dev(1))
		if atB != "AC" {
			t.Fatalf("code at outlet B = %s, want AC (codes are unique fleet-wide)", atB)
		}
		if got := codeOf(tokHOatB, dev(1)); got != atB {
			t.Fatalf("code at outlet B changed to %s", got)
		}
		if got := codeOf(tokA, dev(1)); got != "AA" {
			t.Fatalf("code at outlet A changed to %s", got)
		}
	})
	t.Run("concurrent registrations across two outlets get distinct codes", func(t *testing.T) {
		var wg sync.WaitGroup
		codes := make([]string, 10)
		for i := range codes {
			wg.Add(1)
			go func() {
				defer wg.Done()
				tok := tokA
				if i%2 == 1 {
					tok = tokHOatB
				}
				code, body := register(tok, fmt.Sprintf(`{"deviceId":%q}`, dev(10+i)))
				var out struct {
					Data struct {
						Code string `json:"code"`
					} `json:"data"`
				}
				if code == 200 && json.Unmarshal([]byte(body), &out) == nil {
					codes[i] = out.Data.Code
				}
			}()
		}
		wg.Wait()
		sort.Strings(codes)
		for i, c := range codes {
			if c == "" || (i > 0 && c == codes[i-1]) {
				t.Fatalf("codes = %v", codes)
			}
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(DISTINCT code) FROM pos_devices`).Scan(&n); err != nil || n != 13 {
			t.Fatalf("distinct codes fleet-wide = %d err=%v, want 13", n, err)
		}
	})
	t.Run("the sequence rolls from ZZ to AAA to AAB", func(t *testing.T) {
		exec(`INSERT INTO pos_devices(device_id,outlet_id,code) VALUES($1,$2,'ZZ')`, dev(50), outletA)
		if got := codeOf(tokA, dev(51)); got != "AAA" {
			t.Fatalf("after ZZ = %s, want AAA", got)
		}
		if got := codeOf(tokHOatB, dev(52)); got != "AAB" {
			t.Fatalf("after AAA = %s, want AAB", got)
		}
	})
	t.Run("no outlet is refused", func(t *testing.T) {
		if code, body := register(tokHONone, fmt.Sprintf(`{"deviceId":%q}`, dev(1))); code != 403 {
			t.Fatalf("got %d %s", code, body)
		}
	})
	t.Run("a non-UUID caller outlet is a 400, not a database error", func(t *testing.T) {
		tok := issue(headOffice, "admin", "not-a-uuid")
		if code, body := register(tok, fmt.Sprintf(`{"deviceId":%q}`, dev(1))); code != 400 {
			t.Fatalf("got %d %s", code, body)
		}
	})
	t.Run("a bad deviceId is refused", func(t *testing.T) {
		for _, body := range []string{`{"deviceId":"not-a-uuid"}`, `{}`, `{"deviceId":""}`} {
			if code, out := register(tokA, body); code != 400 {
				t.Fatalf("%s: got %d %s", body, code, out)
			}
		}
	})
}
