package handlers

import (
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/phone"
	"github.com/mandalika/pos-backend/internal/read"
)

// Order text search subtests (wave 2 slice A). Registered by runListSpeedSubtests; helpers live
// here to keep that file small. All rows added here carry the order number prefix SRCH- and are
// removed by the subtest that seeds them.

func (e *speedEnv) seedSearchOrders() {
	const budi, merged = "00000000-0000-4000-8703-000000000001", "00000000-0000-4000-8703-000000000004"
	rows := []struct {
		no, customer, customerName, cashier, method, status string
		outlet                                              int
		day                                                 int
	}{
		{"SRCH-A100", merged, "", "Kasir M", "cash", "completed", 1, 1},               // linked to a merged-away customer
		{"SRCH-50%OFF", "", "", "Kasir M", "cash", "completed", 2, 2},                 // LIKE wildcard in the order number
		{"SRCH-a_b", "", "", "Kasir M", "qris", "completed", 1, 3},                    // underscore
		{"SRCH-Budi", budi, "SPD Budi Santoso", "Kasir M", "cash", "completed", 1, 4}, // matches both arms
		{"SRCH-W1", "", "Budi Walkin", "Kasir M", "split", "refunded", 2, 5},          // NULL customer_id, stored name
		{"SRCH-X1", "", "", "Kasir ab", "cash", "completed", 1, 6},                    // short-term cashier match
	}
	for i, r := range rows {
		var cust any
		if r.customer != "" {
			cust = r.customer
		}
		var cname any
		if r.customerName != "" {
			cname = r.customerName
		}
		e.exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,customer_id,customer_name,subtotal,total,payment_method,status,shift_id,created_at)
		  VALUES(('00000000-0000-4000-8719-'||lpad(($1::int)::text,12,'0'))::uuid, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, 100, 100, $9, $10, $11,
		    '2026-10-01T05:00:00Z'::timestamptz + $12::int * interval '1 day')`,
			i+1, r.no, "spd:srch:"+r.no, speedOutlet(r.outlet), speedCashier, r.cashier, cust, cname, r.method, r.status, speedShift(r.outlet), r.day)
	}
	e.exec(`INSERT INTO order_tenders(order_id,seq,method,amount,tendered)
	  SELECT id,1,'qris',total,total FROM orders WHERE order_number='SRCH-a_b'`)
	e.exec(`INSERT INTO order_refunds(order_id,outlet_id,seq,scope,amount,computed_amount,payment_method,reason,ledger_document_key,refunded_at,refund_business_date)
	  SELECT id,outlet_id,1,'partial',1,1,'cash','SPD','spd-srch-rf-'||id, created_at + interval '1 day', (created_at + interval '1 day')::date
	  FROM orders WHERE order_number IN ('SRCH-Budi','SRCH-A100')`)
}

func (e *speedEnv) dropSearchOrders() {
	e.exec(`DELETE FROM orders WHERE order_number LIKE 'SRCH-%'`)
}

func searchFilters() map[string]read.OrderFilter {
	all := read.Scope{CrossAll: true}
	one := read.Scope{OutletID: speedOutlet(1)}
	out := map[string]read.OrderFilter{}
	// Selective terms get every filter crossed; broad ones (matching most of the table) only
	// the bare filter, to keep the 90 s fixture budget.
	crossed := map[string]bool{"SRCH": true, "Budi": true, "0815000444": true, "0812000111": true, "50%": true, "a_b": true, "ab": true, "walkin": true, "%": true, "_": true}
	for _, cs := range []bool{true, false} {
		for _, q := range []string{
			"SRCH", "Budi", "0815000444", "0812000111", "+62 812 000 111", "50%", "a_b", "%", "_", "Kasir",
			"Sari", "walkin", "PX-1", "PX", "ab", "12", "a_", "no-such-zzz", "Kasir M",
		} {
			tag := fmt.Sprintf("cs=%v/q=%s", cs, q)
			out[tag] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs}
			if !crossed[q] {
				continue
			}
			out[tag+"/outlet"] = read.OrderFilter{Scope: one, Q: q, CustomerSearch: cs}
			out[tag+"/status"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, Status: "refunded"}
			out[tag+"/dates"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, DateFrom: "2026-10-02", DateTo: "2026-10-06"}
			out[tag+"/pay-cash"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, PaymentMethod: "cash"}
			out[tag+"/pay-split"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, PaymentMethod: "split"}
			out[tag+"/pay-tender"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, PaymentMethod: " QRIS"}
			out[tag+"/refund"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, DateBasis: "refund"}
			out[tag+"/refund-days"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, DateBasis: "refund", DateFrom: "2026-10-03", DateTo: "2026-10-12"}
			out[tag+"/legacy"] = read.OrderFilter{Scope: all, Q: q, CustomerSearch: cs, LegacyFrom: "2026-10-02", LegacyTo: "2026-10-08"}
		}
	}
	return out
}

// ordersSearchParity: for every filter, the legacy form, the indexed UNION form and the gated
// default return the legacy oracle's ids in order and its total, on pages and by keyset.
func (e *speedEnv) ordersSearchParity(t *testing.T) {
	e.seedSearchOrders()
	defer e.dropSearchOrders()
	for name, f := range searchFilters() {
		t.Run(name, func(t *testing.T) {
			if err := e.ctx.Err(); err != nil {
				t.Fatalf("fixture deadline reached before this case: %v", err)
			}
			ee := *e // helpers fail on ee.t: the subtest, not the parent
			ee.t = t
			e := &ee
			wantIDs, wantTotal := e.legacyOrders(f, 1, 100)
			small := wantTotal <= 60
			for form, ff := range map[string]read.OrderFilter{"auto": f, "legacy": forced(f, false), "indexed": forced(f, true)} {
				got, total, err := e.repo.Orders(e.ctx, ff, 1, 100)
				if err != nil {
					t.Fatalf("%s: %v", form, err)
				}
				if len(wantIDs) > 0 && total != wantTotal {
					t.Fatalf("%s: total %d, oracle %d", form, total, wantTotal)
				}
				if !reflect.DeepEqual(orderIDs(got), wantIDs) {
					t.Fatalf("%s: ids differ\n got  %v\n want %v", form, orderIDs(got), wantIDs)
				}
				if !small {
					continue
				}
				// pages of 2 concatenate to the same order
				var paged []string
				for p := 1; p <= 40; p++ {
					rows, tot, err := e.repo.Orders(e.ctx, ff, p, 2)
					if err != nil {
						t.Fatal(err)
					}
					if len(wantIDs) > 0 && tot != wantTotal {
						t.Fatalf("%s page %d: total %d, oracle %d", form, p, tot, wantTotal)
					}
					paged = append(paged, orderIDs(rows)...)
					if len(rows) < 2 {
						break
					}
				}
				if len(paged) != len(wantIDs) || (len(wantIDs) > 0 && !reflect.DeepEqual(paged, wantIDs)) {
					t.Fatalf("%s: paged ids differ (%d vs %d)", form, len(paged), len(wantIDs))
				}
				if f.DateBasis == "refund" {
					continue
				}
				kids, ktotal, _ := e.keysetAll(ff, 2)
				if ktotal != wantTotal || (len(wantIDs) > 0 && !reflect.DeepEqual(kids, wantIDs)) || len(kids) != len(wantIDs) {
					t.Fatalf("%s: keyset ids/total differ from offset (%d/%d vs %d/%d)", form, len(kids), ktotal, len(wantIDs), wantTotal)
				}
			}
		})
	}
}

func forced(f read.OrderFilter, indexed bool) read.OrderFilter {
	read.ForceSearchForm(&f, indexed)
	return f
}

// ordersSearchKeyset: keyset pages with q and a cursor concatenate to the offset order.
func (e *speedEnv) ordersSearchKeyset(t *testing.T) {
	f := read.OrderFilter{Scope: read.Scope{CrossAll: true}, Q: "SPD", CustomerSearch: true}
	want, wantTotal := e.legacyOrders(f, 1, 100000)
	if wantTotal < 3000 {
		t.Fatalf("fixture too small for a multi-page keyset (%d)", wantTotal)
	}
	for _, indexed := range []bool{false, true} {
		ids, total, pages := e.keysetAll(forced(f, indexed), 1000)
		if pages < 3 || total != wantTotal || !reflect.DeepEqual(ids, want) {
			t.Fatalf("indexed=%v: pages %d total %d/%d ids equal=%v", indexed, pages, total, wantTotal, reflect.DeepEqual(ids, want))
		}
	}
}

// restrictedShortTermParity: the `|| ”` wrap on short restricted terms changes no row.
func (e *speedEnv) restrictedShortTermParity(t *testing.T) {
	e.seedSearchOrders()
	defer e.dropSearchOrders()
	for _, q := range []string{"ab", "12", "a_", "K"} {
		f := read.OrderFilter{Scope: read.Scope{CrossAll: true}, Q: q}
		wantIDs, wantTotal := e.hardCodedRestricted(q)
		ids, total := e.legacyOrders(f, 1, 100000)
		if total != wantTotal && len(wantIDs) > 0 || !reflect.DeepEqual(ids, wantIDs) {
			t.Fatalf("q=%q: wrapped clause differs from the unwrapped one (%d vs %d rows)", q, len(ids), len(wantIDs))
		}
		if q == "ab" && len(wantIDs) == 0 {
			t.Fatal("fixture must match the short term")
		}
	}
}

// hardCodedRestricted is today's restricted clause, spelled out without the wrap.
func (e *speedEnv) hardCodedRestricted(q string) ([]string, int) {
	args := []any{"%" + q + "%"}
	clause := `(o.order_number ILIKE $1 OR o.cashier_name ILIKE $1`
	if norm := phone.Normalize(q); norm != "" {
		args = append(args, norm)
		clause += ` OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.phone_norm = $2)`
	}
	rows, err := e.pool.Query(e.ctx, `SELECT o.id::text, count(*) OVER() FROM orders o WHERE `+clause+`) ORDER BY o.created_at DESC, o.id DESC`, args...)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	ids, total := []string{}, 0
	for rows.Next() {
		var id string
		if err := rows.Scan(&id, &total); err != nil {
			e.t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids, total
}

func (e *speedEnv) searchPlanLocal(t *testing.T) {
	cfg := e.pool.Config().Copy()
	cfg.MaxConns = 1
	cfg.ConnConfig.RuntimeParams["jit"] = "on"
	cfg.ConnConfig.RuntimeParams["plan_cache_mode"] = "force_generic_plan"
	p1, err := pgxpool.NewWithConfig(e.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer p1.Close()
	jitIn, planIn, jitAfter, planAfter, err := read.New(p1).SearchPlanProbe(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if jitIn != "off" || planIn != "force_custom_plan" {
		t.Fatalf("inside the search batch jit=%q plan_cache_mode=%q", jitIn, planIn)
	}
	if jitAfter != "on" || planAfter != "force_generic_plan" {
		t.Fatalf("settings leaked past the batch: jit=%q plan_cache_mode=%q", jitAfter, planAfter)
	}
}

func (e *speedEnv) searchIndexesExist(t *testing.T) {
	for _, name := range []string{"idx_orders_order_number_trgm", "idx_orders_cashier_name_trgm", "idx_orders_customer_name_trgm"} {
		var valid bool
		err := e.pool.QueryRow(e.ctx, `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1`, name).Scan(&valid)
		if err != nil || !valid {
			t.Fatalf("index %s missing or invalid: %v", name, err)
		}
	}
	raw, err := os.ReadFile("../db/migrations/0088_orders_search_trgm.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, need := range []string{"lock_timeout", "IF NOT EXISTS", "CONCURRENTLY"} {
		if !strings.Contains(string(raw), need) {
			t.Fatalf("migration 0088 lacks %q", need)
		}
	}
}
