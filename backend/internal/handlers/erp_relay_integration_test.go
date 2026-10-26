package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/ledger"
)

// ERP relay against the real outbox table (plan §5). Everything uses the 8f71 uuid
// range and doc keys prefixed "obr:", and every subtest first pushes all other due
// rows a day into the future so its Run only touches the rows it just seeded.
const (
	obrOutlet = "00000000-0000-4000-8f71-00000000000a"
	obrSlug   = "obr-outlet"
	obrCode   = "OBR-1" // outlets.erp_code: the ERP's key for the outlet
)

var obrN int // sequence for every seeded fixture (subtests run sequentially)

func obrID(kind, n int) string { return fmt.Sprintf("00000000-0000-4000-8f71-%04x%08x", kind, n) }

// obrPoster is an in-memory erp.Poster: it records every call and answers per script.
type obrPoster struct {
	mu    sync.Mutex
	calls []obrCall
	reply func(documentID string, n int) (erp.Response, error) // n = 1-based call number for that document
}

type obrCall struct {
	documentID string
	body       []byte
}

func (p *obrPoster) PostStockDocument(_ context.Context, documentID string, body []byte) (erp.Response, error) {
	p.mu.Lock()
	n := 1
	for _, c := range p.calls {
		if c.documentID == documentID {
			n++
		}
	}
	p.calls = append(p.calls, obrCall{documentID, append([]byte(nil), body...)})
	reply := p.reply
	p.mu.Unlock()
	return reply(documentID, n)
}

func (p *obrPoster) callsFor(documentID string) []obrCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []obrCall
	for _, c := range p.calls {
		if c.documentID == documentID {
			out = append(out, c)
		}
	}
	return out
}

func (p *obrPoster) total() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.calls)
}

func obrAnswer(status int, body string) func(string, int) (erp.Response, error) {
	return func(string, int) (erp.Response, error) { return erp.Response{Status: status, Body: []byte(body)}, nil }
}

// obrOK echoes the real document id: the relay only accepts the ERP's answer for that document.
func obrOK(status string) func(string, int) (erp.Response, error) {
	return func(documentID string, _ int) (erp.Response, error) {
		body := fmt.Sprintf(`{"success":true,"data":{"document_id":%q,"status":%q,"movement_ids":[]}}`, documentID, status)
		return erp.Response{Status: 200, Body: []byte(body)}, nil
	}
}

func obrRelay(pool *pgxpool.Pool, p *obrPoster, cfg erp.Config) *erp.Relay {
	cfg.Enabled = true
	cfg.Brand = "mandalika"
	return erp.NewRelay(pool, p, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func obrRun(t *testing.T, ctx context.Context, r *erp.Relay) erp.RunReport {
	t.Helper()
	rep, err := r.Run(ctx)
	if err != nil {
		t.Fatalf("relay run: %v", err)
	}
	return rep
}

// obrPrepare adds the migration-0066 columns, seeds the mapped outlet and parks every
// other non-final row far in the future.
func obrPrepare(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, q := range []string{
		`ALTER TABLE outlets ADD COLUMN IF NOT EXISTS erp_slug text`,
		`ALTER TABLE outlets ADD COLUMN IF NOT EXISTS erp_code text`,
		`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS erp_slug text`,
		`ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS erp_slug text`,
		fmt.Sprintf(`INSERT INTO outlets(id,name) VALUES('%s','OBR outlet') ON CONFLICT DO NOTHING`, obrOutlet),
		fmt.Sprintf(`UPDATE outlets SET erp_slug='%s', erp_code='%s' WHERE id='%s'`, obrSlug, obrCode, obrOutlet),
		`UPDATE erp_outbox SET next_attempt_at = now() + interval '1 day' WHERE status IN ('pending','held')`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
}

type obrDoc struct {
	n                                   int
	docID, outboxID, product, size, sku string
	orderID                             string
}

// obrSeed records a one-line sale document (with a real order when withOrder) for a
// fresh product whose variant is FG-<n>, mapped to the ERP only when mapped is set.
func obrSeed(t *testing.T, ctx context.Context, pool *pgxpool.Pool, mapped, withOrder bool) obrDoc {
	t.Helper()
	obrN++
	d := obrDoc{n: obrN, product: obrID(1, obrN), size: "50ml", sku: fmt.Sprintf("FG-%03d", obrN), orderID: obrID(2, obrN)}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO products(id,name) VALUES($1,$2)`, d.product, fmt.Sprintf("OBR product %d", d.n))
	slug := (*string)(nil)
	if mapped {
		s := fmt.Sprintf("obr-fg-%d", d.n)
		slug = &s
	}
	exec(`INSERT INTO product_variants(product_id,size,price,sku,erp_slug) VALUES($1,$2,150000,$3,$4)`,
		d.product, d.size, d.sku, slug)
	line := ledger.Line{ProductID: d.product, VariantSize: d.size, Qty: -1, QtyBefore: 5, QtyAfter: 4,
		DedupeKey: fmt.Sprintf("obr:sale:%d:1", d.n)}
	if withOrder {
		item := obrID(3, d.n)
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,subtotal,total,payment_method,status)
			VALUES($1,$1,$2,$2,$3,$4,'OBR',150000,150000,'cash','completed')`, d.orderID, fmt.Sprintf("OBR-%d", d.n), obrOutlet, obrID(4, d.n))
		exec(`INSERT INTO order_items(id,order_id,product_id,product_name,variant_size,price,quantity,subtotal)
			VALUES($1,$2,$3,'OBR',$4,150000,1,150000)`, item, d.orderID, d.product, d.size)
		line.RefLine = item
	}
	doc := ledger.Document{
		Key: fmt.Sprintf("obr:sale:%d", d.n), Kind: ledger.KindSale, LocationType: ledger.LocOutlet, LocationID: obrOutlet,
		RefType: "order", RefID: d.orderID, RefNumber: fmt.Sprintf("OBR-%d", d.n), OccurredAt: time.Now().UTC(),
		Lines: []ledger.Line{line},
	}
	res, err := obRecord(ctx, pool, doc, false)
	if err != nil {
		t.Fatal(err)
	}
	d.docID = res.Parts[0].DocumentID
	if err := pool.QueryRow(ctx, `SELECT id::text FROM erp_outbox WHERE document_id=$1`, d.docID).Scan(&d.outboxID); err != nil {
		t.Fatal(err)
	}
	return d
}

type obrRow struct {
	status      string
	attempts    int
	payload     *string
	sha         *string
	hold        *string
	lastErr     *string
	httpStatus  *int
	deliveredAt *time.Time
	leaseClear  bool
	response    *string
	createdAt   time.Time
	nextInSecs  float64 // next_attempt_at - now()
}

func obrGet(t *testing.T, ctx context.Context, pool *pgxpool.Pool, documentID string) obrRow {
	t.Helper()
	var r obrRow
	err := pool.QueryRow(ctx, `SELECT status, attempts, payload::text, payload_sha256, hold_reason, last_error, last_http_status,
		delivered_at, lease_token IS NULL AND lease_until IS NULL, erp_response::text, created_at,
		extract(epoch FROM next_attempt_at - now())::float8
		FROM erp_outbox WHERE document_id=$1`, documentID).
		Scan(&r.status, &r.attempts, &r.payload, &r.sha, &r.hold, &r.lastErr, &r.httpStatus,
			&r.deliveredAt, &r.leaseClear, &r.response, &r.createdAt, &r.nextInSecs)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func obrDue(t *testing.T, ctx context.Context, pool *pgxpool.Pool, documentID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `UPDATE erp_outbox SET next_attempt_at=now() WHERE document_id=$1`, documentID); err != nil {
		t.Fatal(err)
	}
}

func obrWant(t *testing.T, r obrRow, status string, attempts int) {
	t.Helper()
	if r.status != status || r.attempts != attempts {
		t.Fatalf("row = %s attempts %d, want %s attempts %d (last_error=%v hold=%v)", r.status, r.attempts, status, attempts, r.lastErr, r.hold)
	}
}

func obrParse(t *testing.T, body []byte) erp.StockDocument {
	t.Helper()
	var doc erp.StockDocument
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("body is not a StockDocument: %v: %s", err, body)
	}
	return doc
}

const obr422 = `{"success":false,"error":"validation","message":"fg_code unknown","code":"VALIDATION_ERROR"}`

func obrRelayCases(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Run("relay-sale-delivered", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, true)
		p := &obrPoster{reply: obrOK("applied")}
		rep := obrRun(t, ctx, obrRelay(pool, p, erp.Config{}))
		if rep.Delivered != 1 || rep.Claimed != 1 {
			t.Fatalf("report = %+v", rep)
		}
		calls := p.callsFor(d.docID)
		if len(calls) != 1 || p.total() != 1 {
			t.Fatalf("calls = %d (total %d), want 1", len(calls), p.total())
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "delivered", 1)
		if row.payload == nil || row.sha == nil || row.deliveredAt == nil || !row.leaseClear || row.httpStatus == nil || *row.httpStatus != 200 {
			t.Fatalf("row = %+v", row)
		}
		sum := sha256.Sum256([]byte(*row.payload))
		if hex.EncodeToString(sum[:]) != *row.sha {
			t.Fatalf("payload_sha256 %s != sha256(payload::text)", *row.sha)
		}
		if !bytes.Equal(calls[0].body, []byte(*row.payload)) {
			t.Fatal("sent body differs from the stored payload")
		}
		doc := obrParse(t, calls[0].body)
		var movementID string
		if err := pool.QueryRow(ctx, `SELECT id::text FROM stock_movements WHERE document_id=$1`, d.docID).Scan(&movementID); err != nil {
			t.Fatal(err)
		}
		if doc.DocumentID != d.docID || doc.Kind != "sale" || doc.Location.Code != obrCode || doc.Location.Slug != obrSlug || doc.Location.Type != "outlet" ||
			doc.RecordedAt != row.createdAt.UTC().Format(time.RFC3339) || doc.Source.Brand != "mandalika" ||
			len(doc.Lines) != 1 || doc.Lines[0].FgCode != d.sku || doc.Lines[0].MovementID != movementID ||
			doc.Lines[0].Qty != -1 || doc.Lines[0].UnitPrice == nil || *doc.Lines[0].UnitPrice != 150000 ||
			len(doc.Tenders) != 1 || doc.Tenders[0].Method != "cash" || doc.Tenders[0].Amount != 150000 ||
			doc.Ref.Type != "order" || doc.Ref.ID != d.orderID {
			t.Fatalf("document = %+v", doc)
		}
	})

	t.Run("relay-replayed", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, false)
		p := &obrPoster{reply: obrOK("replayed")}
		rep := obrRun(t, ctx, obrRelay(pool, p, erp.Config{}))
		if rep.Replayed != 1 || rep.Delivered != 0 {
			t.Fatalf("report = %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "replayed", 1)
		if row.deliveredAt == nil {
			t.Fatal("delivered_at not set on replayed")
		}
	})

	t.Run("relay-retry-byte-identical", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, true)
		p := &obrPoster{reply: func(_ string, n int) (erp.Response, error) {
			if n <= 2 {
				return erp.Response{Status: 503, Body: []byte(`{"message":"busy"}`)}, nil
			}
			return obrOK("applied")(d.docID, n)
		}}
		r := obrRelay(pool, p, erp.Config{})

		if rep := obrRun(t, ctx, r); rep.Retried != 1 {
			t.Fatalf("run 1 report = %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "pending", 1)
		if row.nextInSecs < 100 || row.nextInSecs > 130 || row.httpStatus == nil || *row.httpStatus != 503 {
			t.Fatalf("after 1st 503: next in %.0fs status %v, want ~120s", row.nextInSecs, row.httpStatus)
		}

		obrDue(t, ctx, pool, d.docID)
		obrRun(t, ctx, r)
		row = obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "pending", 2)
		if row.nextInSecs < 220 || row.nextInSecs > 250 {
			t.Fatalf("after 2nd 503: next in %.0fs, want ~240s", row.nextInSecs)
		}

		obrDue(t, ctx, pool, d.docID)
		obrRun(t, ctx, r)
		obrWant(t, obrGet(t, ctx, pool, d.docID), "delivered", 3)

		calls := p.callsFor(d.docID)
		if len(calls) != 3 || !bytes.Equal(calls[0].body, calls[1].body) || !bytes.Equal(calls[1].body, calls[2].body) {
			t.Fatalf("calls = %d, bodies identical = false", len(calls))
		}
	})

	t.Run("relay-held-then-mapped", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, false, false)
		p := &obrPoster{reply: obrOK("applied")}
		r := obrRelay(pool, p, erp.Config{})
		if rep := obrRun(t, ctx, r); rep.Held != 1 {
			t.Fatalf("report = %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "held", 0)
		if row.hold == nil || !strings.Contains(*row.hold, d.product) || !strings.Contains(*row.hold, d.size) ||
			row.payload != nil || row.nextInSecs < 240 || !row.leaseClear || p.total() != 0 {
			t.Fatalf("held row = %+v hold=%v calls=%d", row, row.hold, p.total())
		}
		if _, err := pool.Exec(ctx, `UPDATE product_variants SET erp_slug=$2 WHERE product_id=$1`, d.product, fmt.Sprintf("obr-fg-%d", d.n)); err != nil {
			t.Fatal(err)
		}
		obrDue(t, ctx, pool, d.docID)
		if rep := obrRun(t, ctx, r); rep.Delivered != 1 {
			t.Fatalf("report after mapping = %+v", rep)
		}
		row = obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "delivered", 1)
		if row.hold != nil {
			t.Fatalf("hold_reason kept after delivery: %v", *row.hold)
		}
	})

	t.Run("relay-dead-422-retry-rebuilds", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, false)
		p := &obrPoster{reply: obrAnswer(422, obr422)}
		r := obrRelay(pool, p, erp.Config{})
		if rep := obrRun(t, ctx, r); rep.Dead != 1 {
			t.Fatalf("report = %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "dead", 1)
		var code string
		if err := pool.QueryRow(ctx, `SELECT erp_response->>'code' FROM erp_outbox WHERE document_id=$1`, d.docID).Scan(&code); err != nil {
			t.Fatal(err)
		}
		if row.httpStatus == nil || *row.httpStatus != 422 || code != "VALIDATION_ERROR" || row.lastErr == nil ||
			!strings.Contains(*row.lastErr, "VALIDATION_ERROR") {
			t.Fatalf("dead row = %+v code=%q", row, code)
		}

		it, err := erp.Retry(ctx, pool, d.outboxID)
		if err != nil {
			t.Fatal(err)
		}
		row = obrGet(t, ctx, pool, d.docID)
		if it.Status != "pending" || row.payload != nil || row.sha != nil {
			t.Fatalf("after retry: status %s payload kept=%v", it.Status, row.payload != nil)
		}
		obrWant(t, row, "pending", 0)

		newSKU := fmt.Sprintf("FG-%03d-B", d.n)
		if _, err := pool.Exec(ctx, `UPDATE product_variants SET sku=$2 WHERE product_id=$1`, d.product, newSKU); err != nil {
			t.Fatal(err)
		}
		p.mu.Lock()
		p.reply = obrOK("applied")
		p.mu.Unlock()
		if rep := obrRun(t, ctx, r); rep.Delivered != 1 {
			t.Fatalf("report after retry = %+v", rep)
		}
		obrWant(t, obrGet(t, ctx, pool, d.docID), "delivered", 1)
		calls := p.callsFor(d.docID)
		if len(calls) != 2 {
			t.Fatalf("calls = %d, want 2", len(calls))
		}
		if first, second := obrParse(t, calls[0].body), obrParse(t, calls[1].body); first.Lines[0].FgCode != d.sku || second.Lines[0].FgCode != newSKU {
			t.Fatalf("fg_codes = %s then %s, want %s then %s", first.Lines[0].FgCode, second.Lines[0].FgCode, d.sku, newSKU)
		}
	})

	t.Run("relay-dead-409-retry-keeps-payload", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, false)
		p := &obrPoster{reply: obrAnswer(409, `{"success":false,"error":"conflict","message":"different body","code":"IDEMPOTENCY_CONFLICT"}`)}
		r := obrRelay(pool, p, erp.Config{})
		if rep := obrRun(t, ctx, r); rep.Dead != 1 {
			t.Fatalf("report = %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "dead", 1)
		if row.sha == nil || row.lastErr == nil || !strings.Contains(*row.lastErr, *row.sha) {
			t.Fatalf("409 last_error should name payload_sha256: %v", row.lastErr)
		}
		frozen := *row.payload

		if _, err := erp.Retry(ctx, pool, d.outboxID); err != nil {
			t.Fatal(err)
		}
		row = obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "pending", 0)
		if row.payload == nil || *row.payload != frozen {
			t.Fatal("409 retry must keep the frozen payload")
		}
		p.mu.Lock()
		p.reply = obrOK("applied")
		p.mu.Unlock()
		obrRun(t, ctx, r)
		obrWant(t, obrGet(t, ctx, pool, d.docID), "delivered", 1)
		calls := p.callsFor(d.docID)
		if len(calls) != 2 || !bytes.Equal(calls[0].body, calls[1].body) {
			t.Fatalf("calls = %d, second body identical = false", len(calls))
		}
	})

	t.Run("relay-unauthorized-stops-run", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		a := obrSeed(t, ctx, pool, true, false)
		b := obrSeed(t, ctx, pool, true, false)
		p := &obrPoster{reply: obrAnswer(401, `{"success":false,"error":"unauthorized","message":"bad key","code":"UNAUTHORIZED"}`)}
		rep := obrRun(t, ctx, obrRelay(pool, p, erp.Config{}))
		if p.total() != 1 || rep.Stopped != "unauthorized" || rep.Claimed != 2 || rep.Released != 2 {
			t.Fatalf("calls %d report %+v, want 1 call, stopped unauthorized, claimed 2, released 2", p.total(), rep)
		}
		sent := 0
		for _, d := range []obrDoc{a, b} {
			row := obrGet(t, ctx, pool, d.docID)
			obrWant(t, row, "pending", 0)
			if !row.leaseClear {
				t.Fatalf("lease kept on %s", d.docID)
			}
			if len(p.callsFor(d.docID)) == 1 {
				sent++
				if row.httpStatus == nil || *row.httpStatus != 401 || row.nextInSecs < 240 {
					t.Fatalf("sent row = http %v next in %.0fs, want 401 and ~300s", row.httpStatus, row.nextInSecs)
				}
			}
		}
		if sent != 1 {
			t.Fatalf("rows sent = %d, want 1", sent)
		}
	})

	t.Run("relay-max-attempts", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, false)
		p := &obrPoster{reply: obrAnswer(503, `{"message":"down"}`)}
		r := obrRelay(pool, p, erp.Config{MaxAttempts: 2})
		obrRun(t, ctx, r)
		obrWant(t, obrGet(t, ctx, pool, d.docID), "pending", 1)
		obrDue(t, ctx, pool, d.docID)
		if rep := obrRun(t, ctx, r); rep.Dead != 1 {
			t.Fatalf("report = %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "dead", 2)
		if row.lastErr == nil || !strings.HasPrefix(*row.lastErr, "max attempts reached") {
			t.Fatalf("last_error = %v", row.lastErr)
		}
	})

	t.Run("relay-concurrent-runs", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		const docs = 20
		ids := make([]string, docs)
		for i := range ids {
			ids[i] = obrSeed(t, ctx, pool, true, false).docID
		}
		p := &obrPoster{reply: obrOK("applied")}
		var wg sync.WaitGroup
		errs := make(chan error, 2)
		for w := 0; w < 2; w++ {
			r := obrRelay(pool, p, erp.Config{BatchSize: 4})
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 20; i++ {
					rep, err := r.Run(ctx)
					if err != nil {
						errs <- err
						return
					}
					if rep.Claimed == 0 {
						return
					}
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatalf("concurrent run: %v", err)
		}
		if p.total() != docs {
			t.Fatalf("total posts = %d, want %d", p.total(), docs)
		}
		for _, id := range ids {
			if n := len(p.callsFor(id)); n != 1 {
				t.Fatalf("document %s posted %d times, want 1", id, n)
			}
			obrWant(t, obrGet(t, ctx, pool, id), "delivered", 1)
		}
	})

	t.Run("relay-expired-lease-reclaimed", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, false)
		if _, err := pool.Exec(ctx, `UPDATE erp_outbox SET status='sending', lease_token=gen_random_uuid(),
			lease_until=now() - interval '1 minute' WHERE document_id=$1`, d.docID); err != nil {
			t.Fatal(err)
		}
		p := &obrPoster{reply: obrOK("applied")}
		if rep := obrRun(t, ctx, obrRelay(pool, p, erp.Config{})); rep.Delivered != 1 || rep.Claimed != 1 {
			t.Fatalf("report = %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "delivered", 1)
		if !row.leaseClear {
			t.Fatal("lease not cleared")
		}
	})

	t.Run("relay-admin", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		dead := obrSeed(t, ctx, pool, true, false)
		pending := obrSeed(t, ctx, pool, true, false)
		if _, err := pool.Exec(ctx, `UPDATE erp_outbox SET status='dead', last_http_status=422 WHERE document_id=$1`, dead.docID); err != nil {
			t.Fatal(err)
		}
		counts, err := erp.Counts(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range []string{"pending", "held", "sending", "delivered", "replayed", "dead"} {
			if _, ok := counts[s]; !ok {
				t.Fatalf("Counts missing status %q: %v", s, counts)
			}
		}
		for s, n := range counts {
			if want := obCount(t, ctx, pool, "erp_outbox", "status=$1", s); n != want {
				t.Fatalf("Counts[%s] = %d, SQL says %d", s, n, want)
			}
		}
		items, total, err := erp.List(ctx, pool, "dead", "", 1000, 0)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, it := range items {
			if it.Status != "dead" {
				t.Fatalf("List(dead) returned a %s row", it.Status)
			}
			found = found || it.DocumentID == dead.docID
		}
		if !found || total != counts["dead"] || len(items) != total {
			t.Fatalf("List(dead): found=%v total=%d items=%d counts=%d", found, total, len(items), counts["dead"])
		}
		if _, _, err := erp.List(ctx, pool, "bogus", "", 10, 0); !errors.Is(err, erp.ErrInvalidFilter) {
			t.Fatalf("invalid status err = %v", err)
		}
		if _, _, err := erp.List(ctx, pool, "", "bogus", 10, 0); !errors.Is(err, erp.ErrInvalidFilter) {
			t.Fatalf("invalid kind err = %v", err)
		}
		if _, err := erp.Get(ctx, pool, "00000000-0000-4000-8f71-ffffffffffff"); !errors.Is(err, erp.ErrNotFound) {
			t.Fatalf("Get unknown err = %v", err)
		}
		if _, err := erp.Retry(ctx, pool, "00000000-0000-4000-8f71-ffffffffffff"); !errors.Is(err, erp.ErrNotFound) {
			t.Fatalf("Retry unknown err = %v", err)
		}
		detail, err := erp.Get(ctx, pool, pending.outboxID)
		if err != nil || detail.DocumentID != pending.docID || detail.Status != "pending" {
			t.Fatalf("Get = %+v err %v", detail, err)
		}
		if _, err := erp.Retry(ctx, pool, pending.outboxID); !errors.Is(err, erp.ErrNotRetryable) {
			t.Fatalf("Retry pending err = %v", err)
		}
	})

	t.Run("relay-disabled", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, false)
		p := &obrPoster{reply: obrOK("applied")}
		r := erp.NewRelay(pool, p, erp.Config{Enabled: false, Brand: "mandalika"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		var before time.Time
		if err := pool.QueryRow(ctx, `SELECT updated_at FROM erp_outbox WHERE document_id=$1`, d.docID).Scan(&before); err != nil {
			t.Fatal(err)
		}
		rep := obrRun(t, ctx, r)
		if !rep.Disabled || rep.Claimed != 0 || p.total() != 0 {
			t.Fatalf("report %+v calls %d", rep, p.total())
		}
		row := obrGet(t, ctx, pool, d.docID)
		obrWant(t, row, "pending", 0)
		var after time.Time
		if err := pool.QueryRow(ctx, `SELECT updated_at FROM erp_outbox WHERE document_id=$1`, d.docID).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if !after.Equal(before) || row.payload != nil {
			t.Fatal("disabled relay touched the row")
		}
	})
	t.Run("relay-held-rows-do-not-crowd-out-new-documents", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		var heldDocs []string
		for i := 0; i < 3; i++ {
			d := obrSeed(t, ctx, pool, true, false)
			heldDocs = append(heldDocs, d.docID)
			if _, err := pool.Exec(ctx, `UPDATE erp_outbox SET status='held', hold_reason='unmapped',
				next_attempt_at=now() - interval '2 hours', created_at=now() - interval '3 hours' WHERE document_id=$1`, d.docID); err != nil {
				t.Fatal(err)
			}
		}
		fresh := obrSeed(t, ctx, pool, true, false)
		p := &obrPoster{reply: obrOK("applied")}
		rep := obrRun(t, ctx, obrRelay(pool, p, erp.Config{BatchSize: 1}))
		if rep.Claimed != 1 || rep.Delivered != 1 || len(p.callsFor(fresh.docID)) != 1 || p.total() != 1 {
			t.Fatalf("report %+v, calls %d: the pending row must be sent first", rep, p.total())
		}
		obrWant(t, obrGet(t, ctx, pool, fresh.docID), "delivered", 1)
		for _, id := range heldDocs {
			obrWant(t, obrGet(t, ctx, pool, id), "held", 0)
		}
	})

	t.Run("relay-stale-lease-result-not-written", func(t *testing.T) {
		obrPrepare(t, ctx, pool)
		d := obrSeed(t, ctx, pool, true, false)
		var stolen string
		p := &obrPoster{}
		p.reply = func(documentID string, n int) (erp.Response, error) {
			// Another run takes over the row while this one is talking to the ERP.
			if err := pool.QueryRow(ctx, `UPDATE erp_outbox SET lease_token=gen_random_uuid(), lease_until=now() + interval '10 minutes'
				WHERE document_id=$1 RETURNING lease_token::text`, documentID).Scan(&stolen); err != nil {
				t.Errorf("steal lease: %v", err)
			}
			return obrOK("applied")(documentID, n)
		}
		rep := obrRun(t, ctx, obrRelay(pool, p, erp.Config{}))
		if rep.Delivered != 0 || rep.Retried != 0 || rep.Dead != 0 || rep.Replayed != 0 {
			t.Fatalf("late result counted: %+v", rep)
		}
		row := obrGet(t, ctx, pool, d.docID)
		var token string
		if err := pool.QueryRow(ctx, `SELECT lease_token::text FROM erp_outbox WHERE document_id=$1`, d.docID).Scan(&token); err != nil {
			t.Fatal(err)
		}
		if row.status != "sending" || row.attempts != 0 || row.deliveredAt != nil || token != stolen {
			t.Fatalf("row = %s attempts %d token kept=%v, want sending/0/other run's token", row.status, row.attempts, token == stolen)
		}
		// Park it so later subtests never reclaim it when the lease expires.
		if _, err := pool.Exec(ctx, `UPDATE erp_outbox SET status='dead', lease_token=NULL, lease_until=NULL WHERE document_id=$1`, d.docID); err != nil {
			t.Fatal(err)
		}
	})
}
