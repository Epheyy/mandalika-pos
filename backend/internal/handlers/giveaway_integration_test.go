package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/ledger"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// gwFakeRunner makes h.erpPull non-nil, which is how the handler knows the ERP
// integration is on.
type gwFakeRunner struct{}

func (gwFakeRunner) Run(context.Context, erp.Mode) (erp.CatalogReport, error) {
	return erp.CatalogReport{}, nil
}

type gwMove struct {
	Key, Product, Size   string
	Qty, Before, After   int
	Flags                []string
	Kind, RefLine, RefNo string
}

// TestGiveawayPostgres is the S2 gate (isolated cluster, MANDALIKA_GW_TEST_DSN, port 56471):
// the per-outlet, per-sale giveaway item (the canvas bag) rides the sale's ledger document
// as one extra `sale` movement keyed giveaway:<order id>, with no flag the ERP could see.
func TestGiveawayPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "GW", 56471)
	const (
		outA   = "00000000-0000-4000-8f71-00000000000a" // giveaway configured (bag)
		outB   = "00000000-0000-4000-8f71-00000000000b" // no setting
		outC   = "00000000-0000-4000-8f71-00000000000c" // bag has no stock row yet (lazy, zero stock)
		outD   = "00000000-0000-4000-8f71-00000000000d" // setting points at a vanished variant
		user   = "00000000-0000-4000-8f71-0000000000a1"
		admin  = "00000000-0000-4000-8f71-0000000000a2"
		secret = "GW-SYNTHETIC-KEY"
		size   = "std"
	)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
	}
	one := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
		return n
	}
	exec(`INSERT INTO outlets(id,name,erp_slug) VALUES($1,'GW A','gw-a'),($2,'GW B','gw-b'),($3,'GW C','gw-c'),($4,'GW D','gw-d')`, outA, outB, outC, outD)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'gw@example.invalid','x','GW cashier','cashier',$2)`, user, outA)

	var pn atomic.Int64
	newID := func(group string) string { return fmt.Sprintf("00000000-0000-4000-8f71-%s%011d", group, pn.Add(1)) }
	// product creates a product with one variant (ERP-mapped unless unmapped) and, when
	// stock >= 0, a stock row at outlet.
	product := func(outlet string, stock int, unmapped bool) string {
		pid := newID("1")
		exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, "GW "+pid[len(pid)-4:])
		slug := any("gw-fg-" + pid[len(pid)-6:])
		if unmapped {
			slug = nil
		}
		exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,erp_slug) VALUES($1,$2,100000,0,$3,$4)`,
			pid, size, "GW"+pid[len(pid)-6:], slug)
		if stock >= 0 && outlet != "" {
			exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, outlet, pid, size, stock)
		}
		return pid
	}
	var anchors atomic.Int64
	reanchor := func() {
		slBackfill(t, ctx, pool, ledger.BackfillOptions{RunID: fmt.Sprintf("gw-open-%d", anchors.Add(1))})
	}
	stockOf := func(outlet, pid string) int {
		return one(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, outlet, pid, size)
	}

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	token, err := auth.IssueAccess([]byte(secret), time.Hour, admin, "admin", "", []string{"manage_outlets"})
	if err != nil {
		t.Fatal(err)
	}
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: []byte(secret)})
	router := chi.NewRouter()
	router.With(authWrap, mw.RequirePermission("manage_outlets")).Get("/outlets/{id}/giveaway", h.GetOutletGiveaway)
	router.With(authWrap, mw.RequirePermission("manage_outlets")).Put("/outlets/{id}/giveaway", h.SetOutletGiveaway)
	put := func(outlet string, body any, key string) (int, string) {
		t.Helper()
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(http.MethodPut, "/outlets/"+outlet+"/giveaway", strings.NewReader(string(raw)))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	get := func(outlet string) (int, string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/outlets/"+outlet+"/giveaway", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	setting := func(pid string, enabled bool) map[string]any {
		return map[string]any{"productId": pid, "variantSize": size, "enabled": enabled}
	}

	item := func(pid string, qty int, price float64) service.OrderItem {
		return service.OrderItem{ProductID: pid, ProductName: "GW", VariantSize: size, Price: price, Quantity: qty, Subtotal: price * float64(qty)}
	}
	var keys atomic.Int64
	saleKey := func(outlet, key string, items ...service.OrderItem) (string, bool, error) {
		total := 0.0
		for _, it := range items {
			total += it.Subtotal
		}
		n := keys.Add(1)
		id, dup, _, err := svc.CreateOrder(ctx, service.CreateOrderInput{
			IdempotencyKey: key, OrderUUID: fmt.Sprintf("00000000-0000-4000-8f72-%012d", n),
			OutletID: outlet, CashierID: user, CashierName: "c", Items: items, PaymentMethod: "cash", AmountPaid: total,
		})
		return id, dup, err
	}
	sale := func(outlet string, items ...service.OrderItem) string {
		t.Helper()
		id, dup, err := saleKey(outlet, fmt.Sprintf("gw-key-%d", keys.Add(1)), items...)
		if err != nil || dup {
			t.Fatalf("sale: dup=%v err=%v", dup, err)
		}
		return id
	}
	moves := func(orderID string) []gwMove {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT dedupe_key, product_id::text, variant_size, qty, qty_before, qty_after, flags, kind,
		    coalesce(ref_line::text,''), coalesce(ref_number,'')
		  FROM stock_movements WHERE ref_id=$1 AND kind='sale' ORDER BY seq`, orderID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []gwMove
		for rows.Next() {
			var m gwMove
			if err := rows.Scan(&m.Key, &m.Product, &m.Size, &m.Qty, &m.Before, &m.After, &m.Flags, &m.Kind, &m.RefLine, &m.RefNo); err != nil {
				t.Fatal(err)
			}
			out = append(out, m)
		}
		return out
	}
	forProduct := func(ms []gwMove, pid string) []gwMove {
		var out []gwMove
		for _, m := range ms {
			if m.Product == pid {
				out = append(out, m)
			}
		}
		return out
	}
	giveaways := func(ms []gwMove) int {
		n := 0
		for _, m := range ms {
			if strings.HasPrefix(m.Key, "giveaway:") {
				n++
			}
		}
		return n
	}
	orderNo := func(oid string) string {
		var s string
		if err := pool.QueryRow(ctx, `SELECT order_number FROM orders WHERE id=$1`, oid).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	// document builds the ERP wire document of a ledger document key exactly as the relay does.
	document := func(docKey string) erp.StockDocument {
		t.Helper()
		var hd erp.OutboxHeader
		err := pool.QueryRow(ctx, `SELECT id::text, document_id::text, kind, location_type, location_id::text, ref_type, ref_id::text,
		    coalesce(ref_number,''), part, part_count, created_at FROM erp_outbox WHERE doc_key=$1`, docKey).
			Scan(&hd.ID, &hd.DocumentID, &hd.Kind, &hd.LocationType, &hd.LocationID, &hd.RefType, &hd.RefID, &hd.RefNumber, &hd.Part, &hd.PartCount, &hd.CreatedAt)
		if err != nil {
			t.Fatalf("outbox row for %s: %v", docKey, err)
		}
		in, err := erp.LoadBuildInput(ctx, pool, hd, "mandalika")
		if err != nil {
			t.Fatal(err)
		}
		doc, hold, err := erp.BuildDocument(in)
		if err != nil || hold != "" {
			t.Fatalf("BuildDocument %s: hold=%q err=%v", docKey, hold, err)
		}
		return doc
	}

	bag := product(outA, 10, false)
	other := product(outA, 100, false)
	otherB := product(outB, 100, false)
	unmapped := product(outA, 5, true)
	reanchor()

	t.Run("setting-endpoints", func(t *testing.T) {
		if code, body := get(outA); code != 200 || !strings.Contains(body, `"configured":false`) {
			t.Fatalf("unset GET = %d %s, want 200 configured:false", code, body)
		}
		if code, _ := get("00000000-0000-4000-8f71-0000000000ff"); code != 404 {
			t.Fatalf("unknown outlet GET = %d, want 404", code)
		}
		if code, _ := put(outA, setting(bag, true), ""); code != 400 {
			t.Fatalf("PUT without Idempotency-Key = %d, want 400", code)
		}
		if code, _ := put(outA, map[string]any{"productId": "nope", "variantSize": size, "enabled": true}, "gw-k-bad"); code != 400 {
			t.Fatalf("PUT bad body = %d, want 400", code)
		}
		if code, _ := put(outA, setting(newID("9"), true), "gw-k-novariant"); code != 409 {
			t.Fatalf("PUT unknown variant = %d, want 409", code)
		}
		if code, _ := put("00000000-0000-4000-8f71-0000000000ff", setting(bag, true), "gw-k-nooutlet"); code != 404 {
			t.Fatalf("PUT unknown outlet = %d, want 404", code)
		}
		// an unmapped variant is refused only while the ERP integration is on
		h.SetErpCatalogRunner(gwFakeRunner{})
		if code, _ := put(outA, setting(unmapped, true), "gw-k-unmapped"); code != 409 {
			t.Fatalf("PUT unmapped with ERP on = %d, want 409", code)
		}
		h.SetErpCatalogRunner(nil)
		if code, body := put(outA, setting(unmapped, true), "gw-k-unmapped-off"); code != 200 {
			t.Fatalf("PUT unmapped with ERP off = %d %s, want 200", code, body)
		}
		h.SetErpCatalogRunner(gwFakeRunner{})
		if code, body := put(outA, setting(bag, true), "gw-k-set"); code != 200 || !strings.Contains(body, `"erpMapped":true`) {
			t.Fatalf("PUT mapped = %d %s", code, body)
		}
		h.SetErpCatalogRunner(nil)
		code, body := put(outA, setting(bag, true), "gw-k-set") // replay: same key, same body
		if code != 200 {
			t.Fatalf("replayed PUT = %d %s", code, body)
		}
		var resp struct {
			Data struct {
				Configured, Enabled, Valid bool
				ProductName, Sku           string
			}
		}
		if code, body := get(outA); code != 200 || json.Unmarshal([]byte(body), &resp) != nil || !resp.Data.Configured || !resp.Data.Enabled || !resp.Data.Valid || resp.Data.Sku == "" {
			t.Fatalf("GET = %d %s", code, body)
		}
		// one event per applied change (the replay and the refused PUTs added none): created, then updated
		if n := one(`SELECT count(*) FROM inventory_doc_events WHERE doc_type='outlet_giveaway' AND doc_id=$1`, outA); n != 2 {
			t.Fatalf("%d giveaway events for outlet A, want 2", n)
		}
		if n := one(`SELECT count(*) FROM inventory_doc_events WHERE doc_type='outlet_giveaway' AND doc_id=$1 AND action='created'`, outA); n != 1 {
			t.Fatalf("%d created events, want 1", n)
		}
	})

	t.Run("one-bag-per-sale-and-erp-line", func(t *testing.T) {
		before := stockOf(outA, bag)
		oid := sale(outA, item(other, 2, 100000))
		ms := moves(oid)
		want := gwMove{Key: "giveaway:" + oid, Product: bag, Size: size, Qty: -1, Before: before, After: before - 1,
			Flags: []string{}, Kind: "sale", RefNo: orderNo(oid)}
		if g := forProduct(ms, bag); !reflect.DeepEqual(g, []gwMove{want}) {
			t.Fatalf("bag rows %+v, want %+v", g, want)
		}
		if stockOf(outA, bag) != before-1 {
			t.Fatalf("bag stock %d, want %d", stockOf(outA, bag), before-1)
		}
		assertLedgerInvariant(t, ctx, pool)

		doc := document("sale:" + oid)
		var line *erp.StockLine
		for i, l := range doc.Lines {
			if l.FgCode == "GW"+bag[len(bag)-6:] {
				line = &doc.Lines[i]
			}
		}
		if line == nil {
			t.Fatalf("ERP sale document has no bag line: %+v", doc.Lines)
		}
		if line.Qty != -1 || line.UnitPrice == nil || *line.UnitPrice != 0 || line.Reason != "sale" || len(line.Flags) != 0 {
			t.Fatalf("ERP bag line %+v (unit_price %v), want Rp0 sale line without flags", *line, line.UnitPrice)
		}
		raw, _ := json.Marshal(doc)
		if strings.Contains(string(raw), "giveaway") {
			t.Fatalf("the word giveaway reached the ERP payload: %s", raw)
		}
	})

	t.Run("replay-and-race-leave-bag-untouched", func(t *testing.T) {
		before := stockOf(outA, bag)
		oid, dup, err := saleKey(outA, "gw-replay", item(other, 1, 100000))
		if err != nil || dup {
			t.Fatalf("first: dup=%v err=%v", dup, err)
		}
		if _, dup, err := saleKey(outA, "gw-replay", item(other, 1, 100000)); err != nil || !dup {
			t.Fatalf("replay: dup=%v err=%v", dup, err)
		}
		if stockOf(outA, bag) != before-1 || giveaways(moves(oid)) != 1 {
			t.Fatalf("replay changed the bag: stock %d (want %d), %d giveaway rows", stockOf(outA, bag), before-1, giveaways(moves(oid)))
		}
		// same key, concurrently: exactly one order, one bag
		before = stockOf(outA, bag)
		var wg sync.WaitGroup
		start := make(chan struct{})
		var okCount atomic.Int64
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				if _, _, err := saleKey(outA, "gw-race", item(other, 1, 100000)); err == nil {
					okCount.Add(1)
				}
			}()
		}
		close(start)
		wg.Wait()
		if okCount.Load() == 0 {
			t.Fatal("no racer succeeded")
		}
		if n := one(`SELECT count(*) FROM orders WHERE idempotency_key='gw-race'`); n != 1 {
			t.Fatalf("%d orders for the raced key, want 1", n)
		}
		if got := stockOf(outA, bag); got != before-1 {
			t.Fatalf("bag after the race = %d, want %d (exactly one bag)", got, before-1)
		}
		if n := one(`SELECT count(*) FROM stock_movements m JOIN orders o ON o.id::text=m.ref_id::text WHERE o.idempotency_key='gw-race' AND m.dedupe_key LIKE 'giveaway:%'`); n != 1 {
			t.Fatalf("%d giveaway rows for the raced key, want 1", n)
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("refund-does-not-restock-the-bag", func(t *testing.T) {
		oid := sale(outA, item(other, 1, 100000))
		before := stockOf(outA, bag)
		if err := svc.Refund(ctx, service.RefundInput{OutletID: outA, OrderID: oid, Reason: "gw", UserID: user, UserName: "c"}); err != nil {
			t.Fatal(err)
		}
		if got := stockOf(outA, bag); got != before {
			t.Fatalf("bag after refund = %d, want %d (not restored)", got, before)
		}
		if n := one(`SELECT count(*) FROM stock_movements WHERE kind='refund' AND ref_id=$1 AND product_id=$2`, oid, bag); n != 0 {
			t.Fatalf("%d refund movements for the bag, want 0", n)
		}
		doc := document("refund:" + oid)
		fg := "GW" + bag[len(bag)-6:]
		for _, l := range doc.Lines {
			if l.FgCode == fg {
				t.Fatalf("ERP refund document carries the bag: %+v", l)
			}
		}
		if len(doc.Lines) != 1 {
			t.Fatalf("ERP refund lines = %d, want 1", len(doc.Lines))
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("sold-reward-and-giveaway-chain-on-one-key", func(t *testing.T) {
		before := stockOf(outA, bag)
		oid := sale(outA, item(bag, 1, 100000), item(bag, 1, 0), item(other, 1, 100000))
		g := forProduct(moves(oid), bag)
		if len(g) != 3 {
			t.Fatalf("bag rows %+v, want sold + Rp0 + giveaway", g)
		}
		for i, w := range []struct{ b, a int }{{before, before - 1}, {before - 1, before - 2}, {before - 2, before - 3}} {
			if g[i].Before != w.b || g[i].After != w.a || g[i].Qty != -1 {
				t.Fatalf("chain row %d = %+v, want %d -> %d", i, g[i], w.b, w.a)
			}
		}
		if !strings.HasPrefix(g[0].Key, "sale:") || !strings.HasPrefix(g[1].Key, "sale:") || g[2].Key != "giveaway:"+oid {
			t.Fatalf("chain keys %q %q %q: the giveaway must come last", g[0].Key, g[1].Key, g[2].Key)
		}
		if stockOf(outA, bag) != before-3 {
			t.Fatalf("bag stock %d, want %d", stockOf(outA, bag), before-3)
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("zero-stock-goes-negative-with-shortage", func(t *testing.T) {
		bagC := product("", -1, false) // variant exists, no stock row at outlet C
		other := product(outC, 50, false)
		reanchor()
		if code, body := put(outC, setting(bagC, true), "gw-k-c"); code != 200 {
			t.Fatalf("PUT: %d %s", code, body)
		}
		oid := sale(outC, item(other, 1, 100000))
		g := forProduct(moves(oid), bagC)
		want := gwMove{Key: "giveaway:" + oid, Product: bagC, Size: size, Qty: -1, Before: 0, After: -1,
			Flags: []string{"shortage"}, Kind: "sale", RefNo: orderNo(oid)}
		if !reflect.DeepEqual(g, []gwMove{want}) {
			t.Fatalf("bag rows %+v, want %+v", g, want)
		}
		oid2 := sale(outC, item(other, 1, 100000))
		if g := forProduct(moves(oid2), bagC); len(g) != 1 || g[0].Before != -1 || g[0].After != -2 || !reflect.DeepEqual(g[0].Flags, []string{"shortage"}) {
			t.Fatalf("second sale bag rows %+v, want -1 -> -2 shortage", g)
		}
		doc := document("sale:" + oid)
		found := false
		for _, l := range doc.Lines {
			if l.FgCode == "GW"+bagC[len(bagC)-6:] {
				found = true
				if fmt.Sprint(l.Flags) != "[shortage]" || l.UnitPrice == nil || *l.UnitPrice != 0 {
					t.Fatalf("ERP bag line %+v, want Rp0 with only the shortage flag", l)
				}
			}
		}
		if !found {
			t.Fatal("ERP document has no bag line")
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("no-setting-disabled-or-vanished-variant-gives-nothing", func(t *testing.T) {
		oid := sale(outB, item(otherB, 1, 100000)) // outlet B: no setting at all
		if giveaways(moves(oid)) != 0 {
			t.Fatal("a giveaway moved with no setting")
		}
		bagB := product(outB, 10, false)
		reanchor()
		if code, body := put(outB, setting(bagB, false), "gw-k-b-off"); code != 200 {
			t.Fatalf("PUT disabled: %d %s", code, body)
		}
		oid = sale(outB, item(otherB, 1, 100000))
		if giveaways(moves(oid)) != 0 || stockOf(outB, bagB) != 10 {
			t.Fatalf("a disabled setting gave a bag (stock %d)", stockOf(outB, bagB))
		}
		// vanished variant: the setting names a product that does not exist; the sale must still succeed
		exec(`INSERT INTO outlet_giveaways(outlet_id,product_id,variant_size) VALUES($1,$2,$3)`, outD, newID("9"), size)
		otherD := product(outD, 20, false)
		reanchor()
		oid = sale(outD, item(otherD, 1, 100000))
		if giveaways(moves(oid)) != 0 || len(moves(oid)) != 1 {
			t.Fatalf("a vanished giveaway variant changed the sale rows: %+v", moves(oid))
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("reversed-carts-with-a-sold-bag-do-not-deadlock", func(t *testing.T) {
		x, y := product(outA, 100000, false), product(outA, 100000, false)
		reanchor()
		before := stockOf(outA, bag)
		const iters, racers = 25, 4
		for i := 0; i < iters; i++ {
			var wg sync.WaitGroup
			start := make(chan struct{})
			errs := make(chan error, racers)
			for r := 0; r < racers; r++ {
				items := []service.OrderItem{item(bag, 1, 100000), item(x, 1, 100000), item(y, 1, 100000)}
				if r%2 == 1 { // reversed cart order
					items = []service.OrderItem{item(y, 1, 100000), item(x, 1, 100000), item(bag, 1, 100000)}
				}
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					if _, _, err := saleKey(outA, fmt.Sprintf("gw-rev-%d-%d", i, keys.Add(1)), items...); err != nil {
						errs <- err
					}
				}()
			}
			close(start)
			wg.Wait()
			close(errs)
			for err := range errs {
				t.Fatalf("iteration %d: %v", i, err)
			}
		}
		if got, want := stockOf(outA, bag), before-2*iters*racers; got != want { // one sold + one given per sale
			t.Fatalf("bag = %d, want %d", got, want)
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("sale-without-stock-lines-queues-a-giveaway-only-document", func(t *testing.T) {
		bundle := product("", -1, true)
		exec(`DELETE FROM product_variants WHERE product_id=$1`, bundle) // a bundle line has no variant: it moves no stock
		it := service.OrderItem{ProductID: bundle, ProductName: "GW bundle", VariantSize: "bundle", Price: 0, Quantity: 1, Subtotal: 0, IsBundle: true}
		oid := sale(outA, it) // a Rp0 order: the bag is given all the same
		ms := moves(oid)
		if len(ms) != 1 || ms[0].Key != "giveaway:"+oid || ms[0].Product != bag {
			t.Fatalf("rows %+v, want exactly the giveaway", ms)
		}
		doc := document("sale:" + oid)
		if len(doc.Lines) != 1 || doc.Lines[0].UnitPrice == nil || *doc.Lines[0].UnitPrice != 0 || doc.Kind != "sale" {
			t.Fatalf("ERP document %+v, want one Rp0 bag line", doc)
		}
		assertLedgerInvariant(t, ctx, pool)
	})

	t.Run("ledger-invariant-holds", func(t *testing.T) {
		bad, err := ledger.InvariantViolations(ctx, pool)
		if err != nil || len(bad) != 0 {
			t.Fatalf("invariant violations %d (err %v)", len(bad), err)
		}
	})
}
