package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
)

// Uses only the LF harness's verified empty, loopback-only disposable cluster.
// Financial/customer fields come from real browser captures. Only the operation
// namespace (UUID, number and key) changes between independent route cases.
func verifyGuestSales(t *testing.T, ctx context.Context, pool *pgxpool.Pool, direct, batch http.Handler, token string, snapshot func() string) {
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	const customer = "00000000-0000-4000-8300-000000000081"
	exec(`INSERT INTO customers(id,name,phone,points) VALUES($1,'Synthetic Customer','+62000000000',100)`, customer)
	exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES('00000000-0000-4000-8300-000000000080','00000000-0000-4000-8300-000000000090','00000000-0000-4000-8300-000000000091','Synthetic Cashier','open',now(),1100000)`)
	exec(`UPDATE loyalty_settings SET enabled=true,points_per_thousand=1,redemption_rate=100`)
	ledger := func() string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object('customers',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM customers x),'points',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM point_transactions x))::text`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	var cases []struct {
		Name string
		Item struct{ Payload map[string]any }
	}
	raw, err := os.ReadFile("testdata/guest_browser_orders.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 3 {
		t.Fatal("expected real browser cash, qris and registered captures")
	}
	for routeIndex, route := range []string{"direct", "batch"} {
		for i, c := range cases {
			t.Run(route+"/"+c.Name, func(t *testing.T) {
				p := c.Item.Payload
				p["orderUuid"] = fmt.Sprintf("00000000-0000-4000-8424-%012d", routeIndex*10+i+1)
				p["orderNumber"] = fmt.Sprintf("A24-%s-%d", route, i)
				key := "a24-browser:" + p["orderUuid"].(string)
				var body any = p
				handler, path := direct, "/orders"
				if route == "batch" {
					handler, path = batch, "/sync/batch"
					body = map[string]any{"items": []any{map[string]any{"type": "order", "idempotencyKey": key, "payload": p}}}
				}
				b, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				request := func() *httptest.ResponseRecorder {
					r := httptest.NewRequest("POST", path, strings.NewReader(string(b)))
					r.Header.Set("Authorization", "Bearer "+token)
					r.Header.Set("Idempotency-Key", key)
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, r)
					return w
				}
				beforeLedger := ledger()
				var stockBefore int
				if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id='00000000-0000-4000-8300-000000000090' AND product_id='00000000-0000-4000-8300-000000000001' AND variant_size='M'`).Scan(&stockBefore); err != nil {
					t.Fatal(err)
				}
				w := request()
				if route == "direct" && w.Code != 201 {
					t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
				}
				if route == "batch" {
					var r struct{ Data syncpkg.BatchResult }
					if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil || w.Code != 200 || len(r.Data.Results) != 1 || r.Data.Results[0].Status != "ok" {
						t.Fatalf("batch status=%d body=%s err=%v", w.Code, w.Body.String(), err)
					}
				}
				var cid *string
				var total, paid float64
				var earned, redeemed, stock, qty int
				if err := pool.QueryRow(ctx, `SELECT customer_id::text,total,amount_paid,points_earned,points_redeemed FROM orders WHERE idempotency_key=$1`, key).Scan(&cid, &total, &paid, &earned, &redeemed); err != nil {
					t.Fatal(err)
				}
				if total != 100000 || paid != 100000 || redeemed != 0 {
					t.Fatalf("money/points: total=%v paid=%v redeemed=%d", total, paid, redeemed)
				}
				if c.Name != "registered-preserved" {
					if cid != nil || earned != 0 || ledger() != beforeLedger {
						t.Fatal("guest changed customer identity/ledger or earned points")
					}
				} else if cid == nil || *cid != customer || earned != 100 || ledger() == beforeLedger {
					t.Fatal("registered customer behavior lost")
				}
				if err := pool.QueryRow(ctx, `SELECT stock FROM outlet_variant_stock WHERE outlet_id='00000000-0000-4000-8300-000000000090' AND product_id='00000000-0000-4000-8300-000000000001' AND variant_size='M'`).Scan(&stock); err != nil {
					t.Fatal(err)
				}
				if err := pool.QueryRow(ctx, `SELECT sum(quantity) FROM order_items WHERE order_id=(SELECT id FROM orders WHERE idempotency_key=$1)`, key).Scan(&qty); err != nil {
					t.Fatal(err)
				}
				if stock != stockBefore-1 || qty != 1 {
					t.Fatal("ordinary stock/physical effect changed")
				}
				committed, committedLedger := snapshot(), ledger()
				for n := 0; n < 2; n++ {
					r := request()
					if r.Code >= 400 || snapshot() != committed || ledger() != committedLedger {
						t.Fatalf("retry changed effects: status=%d body=%s", r.Code, r.Body.String())
					}
				}
				t.Logf("customer null=%v; total/paid=100000; stock delta=-1; earned=%d redeemed=0; customer/points snapshots and two same-key retries verified", cid == nil, earned)
			})
		}
	}
}
