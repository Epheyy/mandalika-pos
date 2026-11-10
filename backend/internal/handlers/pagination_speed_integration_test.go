package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/phone"
	"github.com/mandalika/pos-backend/internal/read"
)

// Subtests of TestPaginationPostgres for the list/export speed slice (id-first pages, keyset
// export). They seed their own outlets/customers, never touch the shared fixture rows, and
// delete what they add before the parent test's later stages run.

const speedCashier = "00000000-0000-4000-8600-000000000001"

func speedOutlet(n int) string { return fmt.Sprintf("00000000-0000-4000-8701-%012d", n) }
func speedShift(n int) string  { return fmt.Sprintf("00000000-0000-4000-8702-%012d", n) }
func speedOrder(g, i int) string {
	return fmt.Sprintf("00000000-0000-4000-87%02d-%012d", 10+g, i)
}

type speedEnv struct {
	t     *testing.T
	ctx   context.Context
	pool  *pgxpool.Pool
	repo  *read.Repo
	fetch func(t *testing.T, outlet, path string) json.RawMessage
}

func (e *speedEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, sql, args...); err != nil {
		e.t.Fatalf("%v\n%s", err, sql)
	}
}

func runListSpeedSubtests(t *testing.T, ctx context.Context, pool *pgxpool.Pool, fetch func(t *testing.T, outlet, path string) json.RawMessage) {
	e := &speedEnv{t: t, ctx: ctx, pool: pool, repo: read.New(pool), fetch: fetch}
	defer e.cleanup()
	e.seed()
	t.Run("jit-off-is-statement-local", e.jitOff)
	t.Run("orders-filter-parity", e.ordersParity)
	t.Run("customers-filter-parity", e.customersParity)
	t.Run("customers-ties", e.customersTies)
	t.Run("keyset-ties", e.keysetTies)
	t.Run("keyset-drift", e.keysetDrift)
	t.Run("keyset-scope", e.keysetScope)
	t.Run("empty-and-past-end", e.emptyAndPastEnd)
}

func (e *speedEnv) cleanup() {
	for _, q := range []string{
		`DELETE FROM orders WHERE outlet_id::text LIKE '00000000-0000-4000-8701-%'`,
		`DELETE FROM shifts WHERE outlet_id::text LIKE '00000000-0000-4000-8701-%'`,
		`DELETE FROM customer_tags WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'SPD %')`,
		`DELETE FROM customers WHERE name LIKE 'SPD %'`,
		`DELETE FROM tags WHERE name = 'SPD tag'`,
		`DELETE FROM customer_segments WHERE name = 'SPD seg'`,
		`DELETE FROM outlets WHERE id::text LIKE '00000000-0000-4000-8701-%'`,
	} {
		if _, err := e.pool.Exec(e.ctx, q); err != nil {
			e.t.Errorf("cleanup %q: %v", q, err)
		}
	}
}

// Outlets 1/2: mixed parity data. 3: 2,000 orders (exact page multiple). 4: ties and
// microsecond straddle. 5: drift/scope data (30 orders).
func (e *speedEnv) seed() {
	for n := 1; n <= 5; n++ {
		e.exec(`INSERT INTO outlets(id,name) VALUES($1,'SPD')`, speedOutlet(n))
		e.exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at) VALUES($1,$2,$3,'SPD','open','2026-10-01T01:00:00Z')`,
			speedShift(n), speedOutlet(n), speedCashier)
	}
	// customers: two named, plus spend-ranked ones for the segment, a tag, and a merged-away one.
	e.exec(`INSERT INTO customers(id,name,phone,email,total_spent,created_at) VALUES
	  ('00000000-0000-4000-8703-000000000001','SPD Budi Santoso','0812000111','budi@spd.test',9000,'2026-09-01T00:00:00Z'),
	  ('00000000-0000-4000-8703-000000000002','SPD Sari','+62 813-000-222','sari@spd.test',4000,'2026-09-02T00:00:00Z'),
	  ('00000000-0000-4000-8703-000000000003','SPD Budi Kecil','0814000333',NULL,6000,'2026-09-03T00:00:00Z')`)
	e.exec(`INSERT INTO customers(id,name,phone,merged_into,total_spent) VALUES
	  ('00000000-0000-4000-8703-000000000004','SPD Budi Merged','0815000444','00000000-0000-4000-8703-000000000001',99999)`)
	e.exec(`INSERT INTO tags(id,name,color) VALUES('00000000-0000-4000-8704-000000000001','SPD tag','#fff')`)
	e.exec(`INSERT INTO customer_tags(customer_id,tag_id) VALUES('00000000-0000-4000-8703-000000000002','00000000-0000-4000-8704-000000000001'),('00000000-0000-4000-8703-000000000001','00000000-0000-4000-8704-000000000001')`)
	e.exec(`INSERT INTO customer_segments(id,name,color,sort_order,m_min) VALUES('00000000-0000-4000-8705-000000000001','SPD seg','#000',-1000,5000)`)

	// Parity orders on outlets 1 and 2: 36 rows over 9 days, varied status/method/customer.
	e.exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,customer_id,customer_name,subtotal,total,payment_method,status,shift_id,created_at)
	  SELECT ('00000000-0000-4000-8710-'||lpad(i::text,12,'0'))::uuid, gen_random_uuid(), 'PX-'||i, 'spd:p:'||i,
	    CASE WHEN i%2=0 THEN $1::uuid ELSE $2::uuid END, $3::uuid, CASE WHEN i%3=0 THEN 'Kasir A' ELSE 'Kasir B' END,
	    CASE WHEN i%6=0 THEN '00000000-0000-4000-8703-000000000001'::uuid WHEN i%6=1 THEN '00000000-0000-4000-8703-000000000002'::uuid END,
	    CASE WHEN i%6=0 THEN 'SPD Budi Santoso' WHEN i%6=1 THEN 'SPD Sari' END,
	    1000+i, 1000+i, CASE WHEN i%5=0 THEN 'split' WHEN i%5=1 THEN 'qris' ELSE 'cash' END,
	    CASE WHEN i%7=0 THEN 'refunded' ELSE 'completed' END,
	    CASE WHEN i%2=0 THEN $4::uuid ELSE $5::uuid END,
	    '2026-10-01T03:00:00Z'::timestamptz + (i/4) * interval '1 day' + (i%4) * interval '1 hour'
	  FROM generate_series(1,36) i`,
		speedOutlet(1), speedOutlet(2), speedCashier, speedShift(1), speedShift(2))
	// tender lines: qris orders get one qris line, split orders get cash+card.
	e.exec(`INSERT INTO order_tenders(order_id,seq,method,amount,tendered)
	  SELECT id,1,'qris',total,total FROM orders WHERE payment_method='qris' AND outlet_id::text LIKE '00000000-0000-4000-8701-%'`)
	e.exec(`INSERT INTO order_tenders(order_id,seq,method,amount,tendered)
	  SELECT id,1,'cash',total-100,total-100 FROM orders WHERE payment_method='split' AND outlet_id::text LIKE '00000000-0000-4000-8701-%'`)
	e.exec(`INSERT INTO order_tenders(order_id,seq,method,amount,tendered)
	  SELECT id,2,'card',100,100 FROM orders WHERE payment_method='split' AND outlet_id::text LIKE '00000000-0000-4000-8701-%'`)
	// refunds on the refunded orders, one with two refund rows (order must appear once).
	// (a trigger already wrote the seq-1 legacy_full row of every refunded order; spread its time)
	e.exec(`UPDATE order_refunds r SET refunded_at = o.created_at + interval '2 days', refund_business_date = (o.created_at + interval '2 days')::date
	  FROM orders o WHERE o.id = r.order_id AND o.outlet_id::text LIKE '00000000-0000-4000-8701-%'`)
	e.exec(`INSERT INTO order_refunds(order_id,outlet_id,seq,scope,amount,computed_amount,payment_method,reason,ledger_document_key,refunded_at,refund_business_date)
	  SELECT id,outlet_id,2,'partial',1,1,'cash','SPD','spd-rf-2-'||id, created_at + interval '3 days', (created_at + interval '3 days')::date
	  FROM orders WHERE order_number='PX-7'`)

	// outlet 3: 2,000 orders, all distinct instants.
	e.exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id,created_at)
	  SELECT ('00000000-0000-4000-8711-'||lpad(i::text,12,'0'))::uuid, gen_random_uuid(),'SPD3-'||i,'spd:3:'||i,$1,$2,'SPD',1,1,'cash','completed',$3,
	    '2026-10-02T00:00:00Z'::timestamptz + i * interval '1 second' FROM generate_series(1,2000) i`,
		speedOutlet(3), speedCashier, speedShift(3))
	// outlet 4: 1,000 rows 1 microsecond newer than 1,501 rows that share ONE instant.
	e.exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id,created_at)
	  SELECT ('00000000-0000-4000-8712-'||lpad(i::text,12,'0'))::uuid, gen_random_uuid(),'SPD4-'||i,'spd:4:'||i,$1,$2,'SPD',1,1,'cash','completed',$3,
	    CASE WHEN i<=1000 THEN '2026-10-03T00:00:00.000001Z'::timestamptz ELSE '2026-10-03T00:00:00Z'::timestamptz END
	  FROM generate_series(1,2501) i`, speedOutlet(4), speedCashier, speedShift(4))
	// outlet 5: 30 orders.
	e.exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id,created_at)
	  SELECT ('00000000-0000-4000-8713-'||lpad(i::text,12,'0'))::uuid, gen_random_uuid(),'SPD5-'||i,'spd:5:'||i,$1,$2,'SPD',1,1,'cash','completed',$3,
	    '2026-10-05T00:00:00Z'::timestamptz + i * interval '1 minute' FROM generate_series(1,30) i`,
		speedOutlet(5), speedCashier, speedShift(5))
	// 450 customers with identical created_at and total_spent for the tie-break test.
	e.exec(`INSERT INTO customers(id,name,phone,total_spent,created_at)
	  SELECT ('00000000-0000-4000-8706-'||lpad(i::text,12,'0'))::uuid, 'SPD Tie '||i, '0899'||lpad(i::text,6,'0'), 0, '2026-08-01T00:00:00Z' FROM generate_series(1,450) i`)
}

func (e *speedEnv) jitOff(t *testing.T) {
	cfg := e.pool.Config().Copy()
	cfg.MaxConns = 1 // one connection: "the next query" is guaranteed to reuse the batch's
	p1, err := pgxpool.NewWithConfig(e.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer p1.Close()
	var baseline string
	if err := p1.QueryRow(e.ctx, `SELECT current_setting('jit')`).Scan(&baseline); err != nil {
		t.Fatal(err)
	}
	in, after, err := read.New(p1).JITProbe(e.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if in != "off" {
		t.Fatalf("jit inside the list batch = %q, want off (baseline %q)", in, baseline)
	}
	if after != baseline {
		t.Fatalf("jit after the batch = %q, want the connection default %q: SET LOCAL leaked", after, baseline)
	}
	t.Logf("jit: default %q, inside batch %q, next query %q", baseline, in, after)
}

// --- orders parity --------------------------------------------------------------------

// legacyOrdersSQL is the retired statement shape (count(*) OVER() over the whole filtered set),
// kept here as the oracle: ids and total only.
func legacyOrdersSQL(f read.OrderFilter, limitArg, offArg int) string {
	where, _ := read.OrderWhere(f)
	order := "o.created_at DESC, o.id DESC"
	if f.DateBasis == "refund" {
		order = "(SELECT max(r.refunded_at) FROM order_refunds r WHERE r.order_id=o.id) DESC NULLS LAST, o.id DESC"
	}
	return fmt.Sprintf(`SELECT o.id::text, count(*) OVER() FROM orders o %s ORDER BY %s LIMIT $%d OFFSET $%d`, where, order, limitArg, offArg)
}

func (e *speedEnv) legacyOrders(f read.OrderFilter, page, limit int) ([]string, int) {
	_, args := read.OrderWhere(f)
	args = append(args, limit, (page-1)*limit)
	rows, err := e.pool.Query(e.ctx, legacyOrdersSQL(f, len(args)-1, len(args)), args...)
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

func orderIDs(rows []api.Order) []string {
	out := []string{}
	for _, o := range rows {
		out = append(out, o.Id.String())
	}
	return out
}

func (e *speedEnv) ordersParity(t *testing.T) {
	one := read.Scope{OutletID: speedOutlet(1)}
	all := read.Scope{CrossAll: true}
	cases := map[string]read.OrderFilter{
		"all":               {Scope: all},
		"one":               {Scope: one},
		"dates":             {Scope: all, DateFrom: "2026-10-02", DateTo: "2026-10-05"},
		"status":            {Scope: all, Status: "completed"},
		"status-refunded":   {Scope: all, Status: "refunded"},
		"pay-cash":          {Scope: all, PaymentMethod: "cash"},
		"pay-split":         {Scope: all, PaymentMethod: "split"},
		"pay-tender-line":   {Scope: all, PaymentMethod: " QRIS"},
		"q-order-number":    {Scope: all, Q: "PX-1", CustomerSearch: true},
		"q-restricted":      {Scope: all, Q: "PX-1"},
		"q-customer-on":     {Scope: all, Q: "Budi", CustomerSearch: true},
		"q-customer-off":    {Scope: all, Q: "Budi"},
		"q-phone-norm":      {Scope: all, Q: "0812000111"},
		"q-cashier":         {Scope: all, Q: "Kasir A"},
		"shift":             {Scope: all, ShiftID: speedShift(2)},
		"customer":          {Scope: all, CustomerID: "00000000-0000-4000-8703-000000000001"},
		"legacy":            {Scope: all, LegacyFrom: "2026-10-02", LegacyTo: "2026-10-04"},
		"refund-basis":      {Scope: all, DateBasis: "refund"},
		"refund-basis-days": {Scope: all, DateBasis: "refund", DateFrom: "2026-10-03", DateTo: "2026-10-08"},
		"nothing":           {Scope: all, Q: "no-such-text-zzz", CustomerSearch: true},
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			for _, limit := range []int{7, 500} {
				pages := 1
				if limit == 7 {
					pages = 4
				}
				for page := 1; page <= pages; page++ {
					wantIDs, wantTotal := e.legacyOrders(f, page, limit)
					got, total, err := e.repo.Orders(e.ctx, f, page, limit)
					if err != nil {
						t.Fatal(err)
					}
					if len(wantIDs) > 0 && total != wantTotal {
						t.Fatalf("page %d limit %d: total %d, legacy %d", page, limit, total, wantTotal)
					}
					if !reflect.DeepEqual(orderIDs(got), wantIDs) {
						t.Fatalf("page %d limit %d: ids differ\n new %v\n old %v", page, limit, orderIDs(got), wantIDs)
					}
				}
			}
			if f.DateBasis == "refund" {
				return
			}
			// keyset pages concatenate to the offset order and report one stable total.
			wantIDs, wantTotal := e.legacyOrders(f, 1, 100000)
			var gotIDs []string
			var after *read.OrderCursor
			pageSize := 5 // small sets cross many boundaries; the shared-fixture sets take big pages
			if wantTotal > 200 {
				pageSize = 1000
			}
			for n := 0; n < 100; n++ {
				rows, total, next, err := e.repo.OrdersKeyset(e.ctx, f, after, pageSize)
				if err != nil {
					t.Fatal(err)
				}
				if total != wantTotal {
					t.Fatalf("keyset total %d, legacy %d", total, wantTotal)
				}
				gotIDs = append(gotIDs, orderIDs(rows)...)
				if next == nil {
					break
				}
				after = next
			}
			if len(gotIDs) != len(wantIDs) || (len(wantIDs) > 0 && !reflect.DeepEqual(gotIDs, wantIDs)) {
				t.Fatalf("keyset ids differ from offset ids (%d vs %d)", len(gotIDs), len(wantIDs))
			}
		})
	}
	// Both statement forms (plain and MATERIALIZED) must be exercised: q/pay use the second.
	if _, _, _, err := e.repo.OrdersKeyset(e.ctx, read.OrderFilter{Scope: all, DateBasis: "refund"}, nil, 5); err == nil {
		t.Fatal("keyset must reject the refund basis")
	}
}

// --- customers ------------------------------------------------------------------------

func (e *speedEnv) legacyCustomers(page, limit int, q, sort, tagID string) ([]string, int) {
	order := `total_spent DESC, created_at DESC, id DESC`
	if sort == "terbaru" {
		order = `created_at DESC, id DESC`
	}
	args := []any{(page - 1) * limit, limit, q}
	tag := ""
	if tagID != "" {
		args = append(args, tagID)
		tag = fmt.Sprintf(` AND EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = customers.id AND ct.tag_id = $%d::uuid)`, len(args))
	}
	text := `name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%'`
	if _, like := phone.SearchKeys(q); like != "" {
		args = append(args, like)
		text += fmt.Sprintf(` OR phone_norm LIKE $%d`, len(args))
	}
	rows, err := e.pool.Query(e.ctx, `SELECT id::text, count(*) OVER() FROM customers WHERE ($3 = '' OR `+text+`) AND merged_into IS NULL`+tag+
		` ORDER BY `+order+` OFFSET $1 LIMIT $2`, args...)
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

func customerIDs(rows []api.Customer) []string {
	out := []string{}
	for _, c := range rows {
		out = append(out, c.Id.String())
	}
	return out
}

func (e *speedEnv) customersParity(t *testing.T) {
	tag := "00000000-0000-4000-8704-000000000001"
	for _, c := range []struct{ name, q, sort, tag string }{
		{"all", "", "", ""}, {"all-terbaru", "", "terbaru", ""},
		{"name", "Budi", "", ""}, {"name-terbaru", "budi", "terbaru", ""},
		{"phone-raw", "0812", "", ""}, {"phone-intl", "+62813", "", ""}, {"phone-norm", "813000", "", ""},
		{"email", "spd.test", "", ""}, {"tie-set", "SPD Tie", "", ""}, {"nothing", "no-such-zzz", "", ""},
		{"tag", "", "", tag}, {"tag-and-q", "Budi", "terbaru", tag},
	} {
		t.Run(c.name, func(t *testing.T) {
			for page := 1; page <= 3; page++ {
				wantIDs, wantTotal := e.legacyCustomers(page, 20, c.q, c.sort, c.tag)
				got, total, err := e.repo.Customers(e.ctx, page, 20, c.q, c.sort, c.tag, "")
				if err != nil {
					t.Fatal(err)
				}
				if len(wantIDs) > 0 && total != wantTotal {
					t.Fatalf("page %d total %d, legacy %d", page, total, wantTotal)
				}
				if !reflect.DeepEqual(customerIDs(got), wantIDs) {
					t.Fatalf("page %d ids differ", page)
				}
			}
		})
	}
	t.Run("tags-survive-the-join", func(t *testing.T) {
		got, _, err := e.repo.Customers(e.ctx, 1, 20, "SPD Sari", "", "", "")
		if err != nil || len(got) != 1 || !got[0].Tags.IsSpecified() || len(got[0].Tags.MustGet()) != 1 {
			t.Fatalf("tags lost (alias trap): %v %+v", err, got)
		}
	})
	t.Run("segment", func(t *testing.T) {
		// 'SPD seg' sorts first and matches total_spent >= 5000: Budi Santoso and Budi Kecil.
		got, total, err := e.repo.Customers(e.ctx, 1, 50, "SPD ", "", "", "00000000-0000-4000-8705-000000000001")
		if err != nil {
			t.Fatal(err)
		}
		if total != 2 || len(got) != 2 {
			t.Fatalf("segment filter returned %d rows total %d, want 2", len(got), total)
		}
	})
}

func (e *speedEnv) customersTies(t *testing.T) {
	for _, sort := range []string{"", "terbaru"} {
		seen := map[string]bool{}
		last := "~"
		count := 0
		for page := 1; page <= 5; page++ {
			got, total, err := e.repo.Customers(e.ctx, page, 100, "SPD Tie ", sort, "", "")
			if err != nil {
				t.Fatal(err)
			}
			if total != 450 {
				t.Fatalf("sort %q page %d total %d", sort, page, total)
			}
			for _, id := range customerIDs(got) {
				if seen[id] {
					t.Fatalf("sort %q: duplicate %s across pages", sort, id)
				}
				seen[id] = true
				if id >= last {
					t.Fatalf("sort %q: ties not in id DESC order", sort)
				}
				last = id
				count++
			}
		}
		if count != 450 {
			t.Fatalf("sort %q: %d rows, want 450", sort, count)
		}
	}
}

// --- keyset ---------------------------------------------------------------------------

func (e *speedEnv) keysetAll(f read.OrderFilter, limit int) (ids []string, total int, pages int) {
	var after *read.OrderCursor
	for {
		rows, tot, next, err := e.repo.OrdersKeyset(e.ctx, f, after, limit)
		if err != nil {
			e.t.Fatal(err)
		}
		total = tot
		pages++
		ids = append(ids, orderIDs(rows)...)
		if next == nil || pages > 50 {
			return
		}
		after = next
	}
}

func (e *speedEnv) keysetTies(t *testing.T) {
	f := read.OrderFilter{Scope: read.Scope{OutletID: speedOutlet(4)}}
	wantIDs, _ := e.legacyOrders(f, 1, 5000)
	ids, total, _ := e.keysetAll(f, 1000)
	if total != 2501 || len(ids) != 2501 {
		t.Fatalf("total %d rows %d, want 2501", total, len(ids))
	}
	if !reflect.DeepEqual(ids, wantIDs) {
		t.Fatal("keyset pages of 1000 do not concatenate to the offset order (gap, overlap or reorder at a tie/µs boundary)")
	}
	// The cursor after page 1 sits on the 1000 rows 1 µs newer than the tie group.
	_, _, next, err := e.repo.OrdersKeyset(e.ctx, f, nil, 1000)
	if err != nil || next == nil {
		t.Fatalf("no cursor: %v", err)
	}
	dec, err := read.DecodeOrderCursor(read.EncodeOrderCursor(*next))
	if err != nil || !dec.CreatedAt.Equal(time.Date(2026, 10, 3, 0, 0, 0, 1000, time.UTC)) {
		t.Fatalf("cursor lost microseconds: %v %v", dec.CreatedAt, err)
	}
}

func (e *speedEnv) keysetDrift(t *testing.T) {
	f := read.OrderFilter{Scope: read.Scope{OutletID: speedOutlet(5)}}
	insert := func(n int, created string, extra ...any) string {
		id := speedOrder(9, n)
		e.exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status,shift_id,created_at)
		  VALUES($1,gen_random_uuid(),'SPD5-x'||$2::text,'spd:5:x'||$2::text,$3,$4,'SPD',1,1,'cash','completed',$5,`+created+`)`,
			append([]any{id, fmt.Sprint(n), speedOutlet(5), speedCashier, speedShift(5)}, extra...)...)
		return id
	}
	remove := func(id string) { e.exec(`DELETE FROM orders WHERE id=$1`, id) }

	// A row dated in the future was committed before page 1: outside asOf, so neither counted
	// nor listed on any page.
	future := insert(1, `now() + interval '1 hour'`)
	ids, total, _ := e.keysetAll(f, 10)
	if total != 30 || len(ids) != 30 {
		t.Fatalf("future-dated row leaked into the frozen set: total %d rows %d", total, len(ids))
	}
	for _, id := range ids {
		if id == future {
			t.Fatal("future-dated row listed")
		}
	}
	remove(future)

	_, total1, next1 := func() ([]api.Order, int, *read.OrderCursor) {
		r, tot, nx, err := e.repo.OrdersKeyset(e.ctx, f, nil, 10)
		if err != nil || nx == nil {
			t.Fatalf("page 1: %v", err)
		}
		return r, tot, nx
	}()
	if total1 != 30 {
		t.Fatalf("page 1 total %d", total1)
	}
	// After page 1: a sale that arrives after asOf is outside the frozen filter.
	late := insert(2, `now()`)
	_, total2, _, err := e.repo.OrdersKeyset(e.ctx, f, next1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total2 != 30 {
		t.Fatalf("a sale after asOf changed the total: %d", total2)
	}
	remove(late)
	// A transaction that began before asOf and commits later has created_at before asOf: the
	// count moves, which the client check turns into a failed export.
	back := insert(3, `$6::timestamptz - interval '1 hour'`, next1.AsOf)
	_, total3, _, err := e.repo.OrdersKeyset(e.ctx, f, next1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total3 != 31 {
		t.Fatalf("a row committed late but dated before asOf must raise the total to 31, got %d", total3)
	}
	remove(back)

	// A refund that moves a row out of a status filter changes the count.
	fs := f
	fs.Status = "completed"
	_, t1, n1, err := e.repo.OrdersKeyset(e.ctx, fs, nil, 10)
	if err != nil || n1 == nil || t1 != 30 {
		t.Fatalf("status page 1: total %d err %v", t1, err)
	}
	e.exec(`UPDATE orders SET status='refunded' WHERE id=$1`, speedOrder(3, 5))
	_, t2, _, err := e.repo.OrdersKeyset(e.ctx, fs, n1, 10)
	if err != nil || t2 != 29 {
		t.Fatalf("a refund under status=completed must change the total (29), got %d err %v", t2, err)
	}
	e.exec(`UPDATE orders SET status='completed' WHERE id=$1`, speedOrder(3, 5))
}

func (e *speedEnv) keysetScope(t *testing.T) {
	// A cashier of outlet 5 asking for outletId=all, replaying a cursor, still sees only outlet 5.
	first := e.fetch(t, speedOutlet(5), "/api/v1/orders?outletId=all&paging=keyset&limit=10")
	var page struct {
		Data []struct {
			Outlet string `json:"outletId"`
		} `json:"data"`
		Meta       struct{ Total, Page, Limit int }
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(first, &page); err != nil {
		t.Fatal(err)
	}
	if page.NextCursor == "" || page.Meta.Total != 30 || page.Meta.Page != 1 || page.Meta.Limit != 10 || len(page.Data) != 10 {
		t.Fatalf("keyset page 1: %+v", page.Meta)
	}
	second := e.fetch(t, speedOutlet(5), "/api/v1/orders?outletId=all&paging=keyset&limit=10&cursor="+page.NextCursor)
	var p2 = page
	p2.NextCursor = ""
	if err := json.Unmarshal(second, &p2); err != nil {
		t.Fatal(err)
	}
	if p2.Meta.Total != 30 || len(p2.Data) != 10 {
		t.Fatalf("replayed cursor: %+v", p2.Meta)
	}
	for _, d := range append(page.Data, p2.Data...) {
		if d.Outlet != speedOutlet(5) {
			t.Fatalf("scope escaped to outlet %s", d.Outlet)
		}
	}
}

func (e *speedEnv) emptyAndPastEnd(t *testing.T) {
	none := read.OrderFilter{Scope: read.Scope{OutletID: speedOutlet(1)}, Status: "cancelled"}
	rows, total, err := e.repo.Orders(e.ctx, none, 1, 50)
	if err != nil || len(rows) != 0 || total != 0 || rows == nil {
		t.Fatalf("empty offset: %d rows total %d err %v", len(rows), total, err)
	}
	krows, ktotal, knext, err := e.repo.OrdersKeyset(e.ctx, none, nil, 50)
	if err != nil || len(krows) != 0 || ktotal != 0 || knext != nil {
		t.Fatalf("empty keyset: %d rows total %d next %v err %v", len(krows), ktotal, knext, err)
	}
	// Exactly two full pages of 1000: the last page is full, the page after it is empty with the real total.
	f3 := read.OrderFilter{Scope: read.Scope{OutletID: speedOutlet(3)}}
	ids, total, pages := e.keysetAll(f3, 1000)
	if total != 2000 || len(ids) != 2000 || pages != 3 {
		t.Fatalf("exact multiple: total %d rows %d pages %d (want 2000/2000/3)", total, len(ids), pages)
	}
	_, _, last, err := e.repo.OrdersKeyset(e.ctx, f3, nil, 1000)
	if err != nil || last == nil {
		t.Fatal(err)
	}
	rows, _, next2, _ := e.repo.OrdersKeyset(e.ctx, f3, last, 1000)
	if len(rows) != 1000 || next2 == nil {
		t.Fatalf("second page: %d rows", len(rows))
	}
	rows, total, next3, err := e.repo.OrdersKeyset(e.ctx, f3, next2, 1000)
	if err != nil || len(rows) != 0 || total != 2000 || next3 != nil {
		t.Fatalf("cursor after the last row: %d rows total %d next %v err %v", len(rows), total, next3, err)
	}
	// Offset page past the end reports the real total, not 0.
	rows, total, err = e.repo.Orders(e.ctx, f3, 99, 50)
	if err != nil || len(rows) != 0 || total != 2000 || rows == nil {
		t.Fatalf("offset past end: %d rows total %d err %v", len(rows), total, err)
	}
	if c, tot, err := e.repo.Customers(e.ctx, 999, 50, "SPD Tie ", "", "", ""); err != nil || len(c) != 0 || tot != 450 {
		t.Fatalf("customers past end: %d rows total %d err %v", len(c), tot, err)
	}
}
