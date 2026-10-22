package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
)

// A29 follow-up: a 500+ item offline queue flushed through the real /sync/batch
// handler (auth + body cap + envelope decode + ProcessBatch) against real PostgreSQL.
//
// NOTE: the router in TestBatchEnvelopePostgres is a bare chi router without the
// server's request-deadline middleware, so each request here carries its own 28 s
// context.WithTimeout (the /sync/batch deadline) and the engine's budget clamp
// (deadline - 7 s, capped at 20 s) is active. Items are sent with a v1 capture envelope
// and device-prefixed keys like the real POS, so attribute() takes the enveloped path.
// Timings are local Docker PostgreSQL latency, not Neon (which is slower).

const (
	queueSize        = 520
	queueClientChunk = 25  // packages/api engine BATCH_MAX_ITEMS
	queueMaxChunk    = 200 // server maxSyncBatchItems
	queueRequestCap  = 28 * time.Second
	queueProduct     = "00000000-0000-4000-8500-000000000001"
	queueVariant     = "Q"
	queueShift       = "00000000-0000-4000-8900-000000000001"
	// queueDeferredMessage is sync.budgetDeferredMessage (unexported): the only text a
	// work-budget deferral carries. Any other "busy" is a real failure.
	queueDeferredMessage = "Ditunda: batas waktu proses batch tercapai, akan dicoba ulang otomatis."
	queueStartStock      = 1000000
)

type queueItem struct {
	Type           string         `json:"type"`
	IdempotencyKey string         `json:"idempotencyKey"`
	Payload        map[string]any `json:"payload"`
	Envelope       map[string]any `json:"envelope"`
}

// buildQueue makes n unique items: mostly sales, with a cash_flow every 20th and a
// customer_create every 50th. tag (0-9) keeps ids and phones disjoint between queues.
// sold is the total quantity the sales move out of stock.
func buildQueue(prefix, device, user, outlet string, tag, n int) (items []queueItem, orders, sold int) {
	for i := 0; i < n; i++ {
		key := fmt.Sprintf("%s:%s-%04d", device, prefix, i)
		env := map[string]any{
			"v": 1, "outletId": outlet, "userId": user, "deviceId": device,
			"capturedAt": time.Now().UTC().Format(time.RFC3339), "shiftId": queueShift,
		}
		switch {
		case i%50 == 7:
			items = append(items, queueItem{"customer_create", key, map[string]any{
				"customerId": fmt.Sprintf("00000000-0000-4000-8600-%010d%02d", i, tag),
				"name":       "Queue customer " + prefix,
				"phone":      fmt.Sprintf("+6280%d%04d", tag, i),
			}, env})
		case i%20 == 3:
			items = append(items, queueItem{"cash_flow", key, map[string]any{
				"type": "in", "amount": 1000, "description": "queue " + prefix, "shiftId": queueShift,
			}, env})
		default:
			qty := 1 + i%3
			orders++
			sold += qty
			items = append(items, queueItem{"order", key, map[string]any{
				"orderUuid":     fmt.Sprintf("00000000-0000-4000-8700-%010d%02d", i, tag),
				"orderNumber":   fmt.Sprintf("QUEUE-%s-%04d", prefix, i),
				"deviceId":      device,
				"shiftId":       queueShift,
				"paymentMethod": "cash",
				"amountPaid":    100000 * qty,
				"items": []map[string]any{{
					"productId": queueProduct, "productName": "Queue Scent", "variantSize": queueVariant,
					"price": 100000, "quantity": qty, "subtotal": 100000 * qty,
				}},
			}, env})
		}
	}
	return items, orders, sold
}

func verifyLargeQueue(t *testing.T, ctx context.Context, pool *pgxpool.Pool, router http.Handler, token, user, outlet string) {
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO products(id,name) VALUES($1,'Queue product')`, queueProduct)
	exec(`INSERT INTO product_variants(product_id,size,price,stock,sku) VALUES($1,$2,100000,$3,'QUEUE')`, queueProduct, queueVariant, queueStartStock)
	exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, outlet, queueProduct, queueVariant, queueStartStock)
	// The enveloped path looks the shift up; an open shift for the cashier keeps items valid.
	exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES($1,$2,$3,'Queue cashier','open',now(),0)`, queueShift, outlet, user)

	var maxReq, total time.Duration
	requests, deferred := 0, 0
	post := func(raw []byte) (*httptest.ResponseRecorder, time.Duration) {
		// Same 28 s deadline the server middleware gives /sync/batch, so the engine's
		// deadline clamp is active end to end.
		rctx, cancel := context.WithTimeout(ctx, queueRequestCap)
		defer cancel()
		r := httptest.NewRequest("POST", "/sync/batch", strings.NewReader(string(raw))).WithContext(rctx)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		start := time.Now()
		router.ServeHTTP(w, r)
		return w, time.Since(start)
	}
	// send posts one chunk; every request is checked for 200, result count and the 28 s bound.
	send := func(t *testing.T, chunk []queueItem) []syncpkg.ItemResult {
		t.Helper()
		raw, err := json.Marshal(map[string]any{"items": chunk})
		if err != nil {
			t.Fatal(err)
		}
		w, d := post(raw)
		requests++
		total += d
		if d > maxReq {
			maxReq = d
		}
		t.Logf("request %d: %d items in %s", requests, len(chunk), d)
		if d >= queueRequestCap {
			t.Fatalf("request %d took %s, over the %s batch deadline", requests, d, queueRequestCap)
		}
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Data.Results) != len(chunk) {
			t.Fatalf("request %d: status=%d results=%d want %d body=%.300s", requests, w.Code, len(out.Data.Results), len(chunk), w.Body.String())
		}
		return out.Data.Results
	}
	// checkChunk validates one chunk's results and returns the index where a work-budget
	// deferral starts (len(chunk) if none). A deferral must be a contiguous suffix that
	// never starts at index 0 and carries the fixed deferral text; any other "busy"
	// (deadlock, lock timeout, shift hold) or error fails. first is nil on the first
	// flush; on a replay it holds the first run's results.
	checkChunk := func(t *testing.T, chunk []queueItem, res []syncpkg.ItemResult, first map[string]syncpkg.ItemResult) int {
		t.Helper()
		cut := len(chunk)
		for i, r := range res {
			if r.IdempotencyKey != chunk[i].IdempotencyKey {
				t.Fatalf("result order mismatch: %s vs %s", r.IdempotencyKey, chunk[i].IdempotencyKey)
			}
			if r.Status == "error" && r.Code == "busy" && cut == len(chunk) {
				cut = i
			}
			if i >= cut {
				if r.Status != "error" || r.Code != "busy" || r.Error != queueDeferredMessage || r.Retryable == nil || !*r.Retryable {
					t.Fatalf("item %s after deferral cut %d is not a budget deferral: status=%s code=%s err=%q", r.IdempotencyKey, cut, r.Status, r.Code, r.Error)
				}
				continue
			}
			if r.StockSeq != nil && first != nil {
				t.Fatalf("replayed item %s carries stockSeq", r.IdempotencyKey)
			}
			switch {
			case first == nil && r.Status == "ok" && r.OrderID != "":
			case first != nil && chunk[i].Type == "order" && r.Status == "duplicate" && r.OrderID == first[r.IdempotencyKey].OrderID:
			case first != nil && chunk[i].Type != "order" && r.Status == "ok" && r.OrderID == first[r.IdempotencyKey].OrderID:
			default:
				t.Fatalf("item %s (%s): status=%s code=%s err=%s orderId=%s", r.IdempotencyKey, chunk[i].Type, r.Status, r.Code, r.Error, r.OrderID)
			}
		}
		if cut == 0 {
			t.Fatal("deferral starts at index 0: the first item of a batch always runs")
		}
		deferred += len(chunk) - cut
		return cut
	}
	// flush sends the queue in chunks of size, in order, re-sending deferred items until
	// none remain. Returns the final result per key.
	flush := func(t *testing.T, items []queueItem, size int, first map[string]syncpkg.ItemResult) map[string]syncpkg.ItemResult {
		t.Helper()
		final := map[string]syncpkg.ItemResult{}
		pending := items
		for round := 0; len(pending) > 0; round++ {
			if round > 10 {
				t.Fatalf("%d items still deferred after %d rounds", len(pending), round)
			}
			var next []queueItem
			for lo := 0; lo < len(pending); lo += size {
				chunk := pending[lo:min(lo+size, len(pending))]
				res := send(t, chunk)
				cut := checkChunk(t, chunk, res, first)
				for i := 0; i < cut; i++ {
					final[chunk[i].IdempotencyKey] = res[i]
				}
				next = append(next, chunk[cut:]...)
			}
			pending = next
		}
		return final
	}
	count := func(t *testing.T, sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	state := func(t *testing.T) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
		  'orders',(SELECT count(*) FROM orders WHERE idempotency_key LIKE '%:q520-%'),
		  'items',(SELECT count(*) FROM order_items WHERE product_id=$1),
		  'keys',(SELECT count(*) FROM processed_keys WHERE idempotency_key LIKE '%:q520-%'),
		  'receipts',(SELECT count(*) FROM operation_receipts WHERE idempotency_key LIKE '%:q520-%'),
		  'cash',(SELECT count(*) FROM cash_flows WHERE description LIKE 'queue q520-%'),
		  'custs',(SELECT count(*) FROM customers WHERE name LIKE 'Queue customer q520-%'),
		  'moves',(SELECT count(*) FROM stock_movements WHERE product_id=$1),
		  'stock',(SELECT stock FROM outlet_variant_stock WHERE product_id=$1),
		  'seq',(SELECT seq FROM outlet_stock_seq WHERE outlet_id=$2))::text`, queueProduct, outlet).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}

	const devA, devB, devC = "00000000-0000-4000-8800-000000000001", "00000000-0000-4000-8800-000000000002", "00000000-0000-4000-8800-000000000003"
	qa, ordersA, soldA := buildQueue("q520-a", devA, user, outlet, 1, queueSize)
	qb, ordersB, soldB := buildQueue("q520-b", devB, user, outlet, 2, queueSize)
	if ordersA != ordersB || len(qa) != queueSize || ordersA < 400 {
		t.Fatalf("fixture shape: %d %d", ordersA, ordersB)
	}
	wallStart := time.Now()

	var firstA map[string]syncpkg.ItemResult
	t.Run("flush in chunks of 25", func(t *testing.T) {
		firstA = flush(t, qa, queueClientChunk, nil)
		if len(firstA) != queueSize {
			t.Fatalf("%d results", len(firstA))
		}
	})
	t.Run("flush second copy in chunks of 200", func(t *testing.T) {
		if got := flush(t, qb, queueMaxChunk, nil); len(got) != queueSize {
			t.Fatalf("%d results", len(got))
		}
	})
	t.Run("each item landed exactly once", func(t *testing.T) {
		orders := count(t, `SELECT count(*) FROM orders WHERE idempotency_key LIKE '%:q520-%'`)
		distinct := count(t, `SELECT count(DISTINCT idempotency_key) FROM orders WHERE idempotency_key LIKE '%:q520-%'`)
		if orders != ordersA+ordersB || distinct != orders {
			t.Fatalf("orders=%d distinct=%d want %d", orders, distinct, ordersA+ordersB)
		}
		if n := count(t, `SELECT count(*) FROM processed_keys WHERE idempotency_key LIKE '%:q520-%'`); n != ordersA+ordersB {
			t.Fatalf("processed_keys=%d want %d (orders only)", n, ordersA+ordersB)
		}
		if n := count(t, `SELECT count(*) FROM operation_receipts WHERE idempotency_key LIKE '%:q520-%'`); n != 2*(queueSize-ordersA) {
			t.Fatalf("operation_receipts=%d want %d (cash_flow/customer_create)", n, 2*(queueSize-ordersA))
		}
		cash, custs := 0, 0
		for _, it := range qa {
			switch it.Type {
			case "cash_flow":
				cash++
			case "customer_create":
				custs++
			}
		}
		if n := count(t, `SELECT count(*) FROM cash_flows WHERE description LIKE 'queue q520-%'`); n != 2*cash {
			t.Fatalf("cash_flows=%d want %d", n, 2*cash)
		}
		if n := count(t, `SELECT count(*) FROM customers WHERE name LIKE 'Queue customer q520-%'`); n != 2*custs {
			t.Fatalf("customers=%d want %d", n, 2*custs)
		}
		sold := soldA + soldB
		if n := count(t, `SELECT COALESCE(sum(quantity),0)::int FROM order_items WHERE product_id=$1`, queueProduct); n != sold {
			t.Fatalf("order_items qty=%d want %d", n, sold)
		}
		if n := count(t, `SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, outlet, queueProduct, queueVariant); n != queueStartStock-sold {
			t.Fatalf("stock=%d want %d", n, queueStartStock-sold)
		}
		if n := count(t, `SELECT count(*) FROM stock_movements WHERE kind='sale' AND product_id=$1`, queueProduct); n != ordersA+ordersB {
			t.Fatalf("sale movements=%d want %d", n, ordersA+ordersB)
		}
		if n := count(t, `SELECT COALESCE(-sum(qty),0)::int FROM stock_movements WHERE kind='sale' AND product_id=$1`, queueProduct); n != sold {
			t.Fatalf("ledger qty=%d want %d", n, sold)
		}
	})
	t.Run("replay of first queue is duplicate and changes nothing", func(t *testing.T) {
		before := state(t)
		flush(t, qa, queueClientChunk, firstA)
		if after := state(t); after != before {
			t.Fatalf("replay changed rows:\nbefore %s\nafter  %s", before, after)
		}
	})
	t.Run("201 items rejected as too large", func(t *testing.T) {
		before := state(t)
		over, _, _ := buildQueue("q520-c", devC, user, outlet, 3, queueMaxChunk+1)
		raw, err := json.Marshal(map[string]any{"items": over})
		if err != nil {
			t.Fatal(err)
		}
		w, _ := post(raw)
		if w.Code != 413 || !strings.Contains(w.Body.String(), "batch too large") {
			t.Fatalf("status=%d body=%.300s", w.Code, w.Body.String())
		}
		if state(t) != before || count(t, `SELECT count(*) FROM processed_keys WHERE idempotency_key LIKE '%:q520-c-%'`) != 0 {
			t.Fatal("rejected oversize batch changed rows")
		}
	})
	t.Logf("520-item queue x2 + replay: %d requests, max single request %s, summed request time %s, wall %s, deferred(busy) items re-sent: %d",
		requests, maxReq, total, time.Since(wallStart), deferred)
}
