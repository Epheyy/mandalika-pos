package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

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

// End-to-end: real sale/refund/transfer writers -> erp_outbox -> erp.Relay -> the real
// cmd/erpstub process over HTTP. Uses the 8f72 uuid range. Runs inside TestErpOutboxPostgres.
const (
	obeOutlet    = "00000000-0000-4000-8f72-00000000000a"
	obeWarehouse = "00000000-0000-4000-8f72-0000000000d1"
	obeUser      = "00000000-0000-4000-8f72-000000000e01"
	obeSecret    = "OB-E2E-SYNTHETIC-KEY"
	obeSize      = "e2e-size"
)

type obeStub struct {
	base, key string
}

// obeStartStub builds ./cmd/erpstub, starts it on a free loopback port with the extra
// flags and waits until it answers. Any failure fails the test.
func obeStartStub(t *testing.T, flags ...string) *obeStub {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("backend root not found at %s: %v", root, err)
	}
	bin := filepath.Join(t.TempDir(), "erpstub")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command("go", "build", "-o", bin, "./cmd/erpstub")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build ./cmd/erpstub: %v\n%s", err, out)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	key := fmt.Sprintf("e2e-key-%d", time.Now().UnixNano())

	var logs bytes.Buffer
	cmd := exec.Command(bin, append([]string{"-addr", addr, "-key", key}, flags...)...)
	cmd.Stdout, cmd.Stderr = &logs, &logs
	if err := cmd.Start(); err != nil {
		t.Fatalf("start erpstub: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-exited
	})

	s := &obeStub{base: "http://" + addr, key: key}
	deadline := time.Now().Add(10 * time.Second)
	for {
		select {
		case err := <-exited:
			t.Fatalf("erpstub exited early: %v\n%s", err, logs.String())
		default:
		}
		if _, code, err := s.call(http.MethodGet, "/_stub/documents"); err == nil && code == 200 {
			return s
		}
		if time.Now().After(deadline) {
			t.Fatalf("erpstub did not answer within 10s\n%s", logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (s *obeStub) call(method, path string) ([]byte, int, error) {
	req, err := http.NewRequest(method, s.base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return b, resp.StatusCode, err
}

type obeDoc struct {
	DocumentID string `json:"document_id"`
	Kind       string `json:"kind"`
	Location   struct{ Type, Code, Slug string }
	Ref        struct{ Type, ID string }
	Body       erp.StockDocument `json:"body"`
}

func (s *obeStub) data(t *testing.T, path string, out any) {
	t.Helper()
	b, code, err := s.call(http.MethodGet, path)
	if err != nil || code != 200 {
		t.Fatalf("stub GET %s: %d %v %s", path, code, err, b)
	}
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil || json.Unmarshal(env.Data, out) != nil {
		t.Fatalf("stub GET %s: bad body %s", path, b)
	}
}

func (s *obeStub) docs(t *testing.T) []obeDoc {
	t.Helper()
	var out []obeDoc
	s.data(t, "/_stub/documents", &out)
	return out
}

func (s *obeStub) docByID(t *testing.T, id string) (obeDoc, int) {
	t.Helper()
	var found obeDoc
	n := 0
	for _, d := range s.docs(t) {
		if d.DocumentID == id {
			found, n = d, n+1
		}
	}
	return found, n
}

// balance reads a stub balance; the stub keys outlets by their ERP code, like the ERP.
func (s *obeStub) balance(t *testing.T, locType, locCode, fg string) int64 {
	t.Helper()
	var rows []struct {
		LocationType string `json:"location_type"`
		LocationCode string `json:"location_code"`
		FgCode       string `json:"fg_code"`
		Qty          int64  `json:"qty"`
	}
	s.data(t, "/_stub/balances", &rows)
	for _, r := range rows {
		if r.LocationType == locType && r.LocationCode == locCode && r.FgCode == fg {
			return r.Qty
		}
	}
	return 0
}

// obeEnv bundles the real router, the relay and the stub for the subtests.
type obeEnv struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	stub   *obeStub
	relay  *erp.Relay
	router *chi.Mux
	token  string
	shift  string
	n      int
}

func (e *obeEnv) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, sql, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *obeEnv) str(sql string, args ...any) string {
	e.t.Helper()
	var s string
	if err := e.pool.QueryRow(e.ctx, sql, args...).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *obeEnv) id(group string) string {
	e.n++
	return fmt.Sprintf("00000000-0000-4000-8f72-%s%011d", group, e.n)
}

// park pushes every pending/held row a day out so Run only sees rows seeded afterwards.
func (e *obeEnv) park() {
	e.exec(`UPDATE erp_outbox SET next_attempt_at = now() + interval '1 day' WHERE status IN ('pending','held')`)
}

func (e *obeEnv) run() erp.RunReport {
	e.t.Helper()
	return obrRun(e.t, e.ctx, e.relay)
}

// product seeds a product with one ERP-mapped variant (sku = fg code) and opening stock.
func (e *obeEnv) product(fg string, stock int) string {
	e.t.Helper()
	pid := e.id("1")
	e.exec(`INSERT INTO products(id,name) VALUES($1,$2)`, pid, "OBE product "+pid[len(pid)-4:])
	e.exec(`INSERT INTO product_variants(product_id,size,price,stock,sku,erp_slug) VALUES($1,$2,100000,0,$3,$4)`,
		pid, obeSize, fg, "obe-"+pid[len(pid)-6:])
	e.exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,$4)`, obeOutlet, pid, obeSize, stock)
	return pid
}

func (e *obeEnv) open() {
	e.t.Helper()
	slBackfill(e.t, e.ctx, e.pool, ledger.BackfillOptions{RunID: e.id("9")})
	e.park() // opening documents are not part of any case
}

func (e *obeEnv) do(path string, body any) (int, string) {
	e.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		e.t.Fatal(err)
	}
	r := httptest.NewRequest("POST", path, strings.NewReader(string(raw)))
	r.Header.Set("Authorization", "Bearer "+e.token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	e.router.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

// sale posts a real order with (productID, qty) lines and returns its order id.
func (e *obeEnv) sale(lines ...[2]any) string {
	e.t.Helper()
	items, total := []map[string]any{}, 0
	for _, l := range lines {
		qty := l[1].(int)
		items = append(items, map[string]any{"productId": l[0], "productName": "OBE", "variantSize": obeSize,
			"price": 100000, "quantity": qty, "subtotal": 100000 * qty, "isBundle": false})
		total += 100000 * qty
	}
	key := e.id("3")
	p := map[string]any{"orderUuid": e.id("2"), "paymentMethod": "cash", "amountPaid": total, "shiftId": e.shift, "items": items}
	raw, _ := json.Marshal(p)
	r := httptest.NewRequest("POST", "/orders", strings.NewReader(string(raw)))
	r.Header.Set("Authorization", "Bearer "+e.token)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", key)
	w := httptest.NewRecorder()
	e.router.ServeHTTP(w, r)
	if w.Code != 200 && w.Code != 201 {
		e.t.Fatalf("sale: %d %s", w.Code, w.Body.String())
	}
	return e.str(`SELECT id::text FROM orders WHERE idempotency_key=$1`, key)
}

type obeOutboxRow struct{ id, docID, status string }

func (e *obeEnv) outbox(kind, refID string) obeOutboxRow {
	e.t.Helper()
	var r obeOutboxRow
	rows := 0
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM erp_outbox WHERE kind=$1 AND ref_id=$2`, kind, refID).Scan(&rows); err != nil || rows != 1 {
		e.t.Fatalf("outbox rows for %s %s = %d (err %v), want 1", kind, refID, rows, err)
	}
	if err := e.pool.QueryRow(e.ctx, `SELECT id::text, document_id::text, status FROM erp_outbox WHERE kind=$1 AND ref_id=$2`, kind, refID).
		Scan(&r.id, &r.docID, &r.status); err != nil {
		e.t.Fatal(err)
	}
	return r
}

func (e *obeEnv) status(docID string) string {
	return e.str(`SELECT status FROM erp_outbox WHERE document_id=$1`, docID)
}

func (e *obeEnv) movementIDs(docID string) []string {
	e.t.Helper()
	rows, err := e.pool.Query(e.ctx, `SELECT id::text FROM stock_movements WHERE document_id=$1 ORDER BY id`, docID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func obeLineIDs(d obeDoc) []string {
	var out []string
	for _, l := range d.Body.Lines {
		out = append(out, l.MovementID)
	}
	slices.Sort(out)
	return out
}

func (e *obeEnv) want(cond bool, format string, args ...any) {
	e.t.Helper()
	if !cond {
		e.t.Fatalf(format, args...)
	}
}

func obeSetupEnv(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *obeEnv {
	t.Helper()
	obrPrepare(t, ctx, pool)
	stub := obeStartStub(t)
	client := erp.NewStockDocClient(stub.base+"/api/integration/v1", stub.key, 5*time.Second)
	relay := erp.NewRelay(pool, client, erp.Config{Enabled: true, Brand: "mandalika", BatchSize: 50}, slog.Default())
	e := &obeEnv{t: t, ctx: ctx, pool: pool, stub: stub, relay: relay}
	e.exec(`INSERT INTO outlets(id,name) VALUES($1,'OBE outlet') ON CONFLICT DO NOTHING`, obeOutlet)
	e.exec(`UPDATE outlets SET erp_slug='kemang', erp_code='KMG' WHERE id=$1`, obeOutlet)
	e.exec(`INSERT INTO warehouses(id,name) VALUES($1,'OBE warehouse') ON CONFLICT DO NOTHING`, obeWarehouse)
	e.exec(`UPDATE warehouses SET erp_slug='gudang-pusat' WHERE id=$1`, obeWarehouse)
	e.exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'obe@example.invalid','x','OBE cashier','cashier',$2) ON CONFLICT DO NOTHING`, obeUser, obeOutlet)
	e.exec(`INSERT INTO shifts(id,outlet_id,cashier_id,cashier_name,status,opened_at,starting_cash) VALUES(gen_random_uuid(),$1,$2,'OBE cashier','open',now(),0)`, obeOutlet, obeUser)
	e.shift = e.str(`SELECT id::text FROM shifts WHERE outlet_id=$1 AND status='open'`, obeOutlet)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte(obeSecret)
	token, err := auth.IssueAccess(secret, time.Hour, obeUser, "cashier", obeOutlet, []string{"create_order", "process_refund"})
	if err != nil {
		t.Fatal(err)
	}
	e.token = token
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	e.router = chi.NewRouter()
	e.router.With(authWrap, mw.RequirePermission("create_order")).Post("/orders", h.CreateOrder)
	e.router.With(authWrap, mw.RequirePermission("process_refund")).Post("/orders/{id}/refund", h.RefundOrder)
	return e
}

func obrE2ECases(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	e := obeSetupEnv(t, ctx, pool)
	var saleOrder, saleDoc, saleOutbox string // case 1 -> 2, 5

	t.Run("e2e-sale-delivered", func(t *testing.T) {
		e.t = t
		pA, pS := e.product("FG-001", 10), e.product("FG-002", 1) // pS is oversold by 2
		e.open()
		b1, b2 := e.stub.balance(t, "outlet", "KMG", "FG-001"), e.stub.balance(t, "outlet", "KMG", "FG-002")
		saleOrder = e.sale([2]any{pA, 2}, [2]any{pS, 3})
		row := e.outbox("sale", saleOrder)
		e.want(row.status == "pending", "outbox status %s before relay, want pending", row.status)
		saleDoc, saleOutbox = row.docID, row.id
		rep := e.run()
		e.want(rep.Delivered == 1 && e.status(saleDoc) == "delivered", "run %+v, status %s", rep, e.status(saleDoc))
		d, n := e.stub.docByID(t, saleDoc)
		e.want(n == 1 && d.Kind == "sale" && d.Location.Type == "outlet" && d.Location.Code == "KMG" && d.Location.Slug == "kemang", "stub doc %+v n=%d", d, n)
		e.want(slices.Equal(obeLineIDs(d), e.movementIDs(saleDoc)), "stub movement ids %v != ledger %v", obeLineIDs(d), e.movementIDs(saleDoc))
		e.want(e.stub.balance(t, "outlet", "KMG", "FG-001") == b1-2, "FG-001 balance %d, want %d", e.stub.balance(t, "outlet", "KMG", "FG-001"), b1-2)
		e.want(e.stub.balance(t, "outlet", "KMG", "FG-002") == b2-3, "FG-002 balance %d, want %d", e.stub.balance(t, "outlet", "KMG", "FG-002"), b2-3)
		short := 0
		for _, l := range d.Body.Lines {
			if l.FgCode == "FG-002" && slices.Contains(l.Flags, "shortage") {
				short++
			}
			if l.FgCode == "FG-001" && slices.Contains(l.Flags, "shortage") {
				t.Fatalf("unexpected shortage flag on FG-001: %+v", l)
			}
		}
		e.want(short == 1, "shortage flag on the oversold FG-002 line: %d, want 1", short)
	})

	t.Run("e2e-refund", func(t *testing.T) {
		e.t = t
		if saleOrder == "" {
			t.Fatal("depends on e2e-sale-delivered, which left no document")
		}
		b1 := e.stub.balance(t, "outlet", "KMG", "FG-001")
		if code, body := e.do("/orders/"+saleOrder+"/refund", map[string]any{"reason": "obe"}); code != 200 && code != 201 {
			t.Fatalf("refund: %d %s", code, body)
		}
		row := e.outbox("refund", saleOrder)
		rep := e.run()
		e.want(rep.Delivered == 1 && e.status(row.docID) == "delivered", "run %+v, status %s", rep, e.status(row.docID))
		d, n := e.stub.docByID(t, row.docID)
		e.want(n == 1 && d.Kind == "refund", "stub doc %+v n=%d", d, n)
		sold := e.movementIDs(saleDoc)
		for _, l := range d.Body.Lines {
			e.want(slices.Contains(sold, l.RefundOfMovementID), "refund line %s refund_of %q not a sale movement %v", l.MovementID, l.RefundOfMovementID, sold)
		}
		e.want(e.stub.balance(t, "outlet", "KMG", "FG-001") == b1+2, "FG-001 not restored: %d, want %d", e.stub.balance(t, "outlet", "KMG", "FG-001"), b1+2)
	})

	t.Run("e2e-fault-503-then-recover", func(t *testing.T) {
		e.t = t
		p := e.product("FG-001", 10)
		e.open()
		b1 := e.stub.balance(t, "outlet", "KMG", "FG-001")
		order := e.sale([2]any{p, 1})
		row := e.outbox("sale", order)
		if _, code, err := e.stub.call(http.MethodPost, "/_stub/fault?status=503&count=1"); err != nil || code != 200 {
			t.Fatalf("arm fault: %d %v", code, err)
		}
		rep := e.run()
		var attempts int
		var httpStatus *int
		if err := pool.QueryRow(ctx, `SELECT attempts, last_http_status FROM erp_outbox WHERE document_id=$1`, row.docID).Scan(&attempts, &httpStatus); err != nil {
			t.Fatal(err)
		}
		e.want(e.status(row.docID) == "pending" && attempts == 1 && httpStatus != nil && *httpStatus == 503,
			"after fault: run %+v status %s attempts %d http %v", rep, e.status(row.docID), attempts, httpStatus)
		e.want(e.stub.balance(t, "outlet", "KMG", "FG-001") == b1, "a failed delivery must not move the stub balance")
		e.exec(`UPDATE erp_outbox SET next_attempt_at=now() WHERE document_id=$1`, row.docID)
		rep = e.run()
		e.want(rep.Delivered == 1 && e.status(row.docID) == "delivered", "recover: run %+v status %s", rep, e.status(row.docID))
		e.want(e.stub.balance(t, "outlet", "KMG", "FG-001") == b1-1, "balance %d, want %d", e.stub.balance(t, "outlet", "KMG", "FG-001"), b1-1)
	})

	t.Run("e2e-422-dead-then-fixed", func(t *testing.T) {
		e.t = t
		p := e.product("FG-999", 5) // unknown to the stub
		e.open()
		order := e.sale([2]any{p, 1})
		row := e.outbox("sale", order)
		rep := e.run()
		var httpStatus *int
		var resp *string
		if err := pool.QueryRow(ctx, `SELECT last_http_status, erp_response::text FROM erp_outbox WHERE document_id=$1`, row.docID).Scan(&httpStatus, &resp); err != nil {
			t.Fatal(err)
		}
		e.want(e.status(row.docID) == "dead" && httpStatus != nil && *httpStatus == 422 && resp != nil && strings.Contains(*resp, "VALIDATION_ERROR"),
			"run %+v status %s http %v response %v", rep, e.status(row.docID), httpStatus, resp)
		e.exec(`UPDATE product_variants SET sku='FG-003' WHERE product_id=$1`, p)
		b3 := e.stub.balance(t, "outlet", "KMG", "FG-003")
		if _, err := erp.Retry(ctx, pool, row.id); err != nil {
			t.Fatal(err)
		}
		rep = e.run()
		e.want(rep.Delivered == 1 && e.status(row.docID) == "delivered", "after fix: run %+v status %s", rep, e.status(row.docID))
		d, n := e.stub.docByID(t, row.docID)
		e.want(n == 1 && len(d.Body.Lines) == 1 && d.Body.Lines[0].FgCode == "FG-003", "stub body %+v n=%d", d.Body.Lines, n)
		e.want(e.stub.balance(t, "outlet", "KMG", "FG-003") == b3-1, "FG-003 balance %d, want %d", e.stub.balance(t, "outlet", "KMG", "FG-003"), b3-1)
	})

	t.Run("e2e-replay", func(t *testing.T) {
		e.t = t
		if saleDoc == "" {
			t.Fatal("depends on e2e-sale-delivered, which left no document")
		}
		b1, b2 := e.stub.balance(t, "outlet", "KMG", "FG-001"), e.stub.balance(t, "outlet", "KMG", "FG-002")
		e.park()
		if _, err := erp.Retry(ctx, pool, saleOutbox); err != nil {
			t.Fatal(err)
		}
		rep := e.run()
		e.want(rep.Replayed == 1 && e.status(saleDoc) == "replayed", "run %+v status %s", rep, e.status(saleDoc))
		_, n := e.stub.docByID(t, saleDoc)
		e.want(n == 1, "stub holds %d copies of the document, want 1", n)
		e.want(e.stub.balance(t, "outlet", "KMG", "FG-001") == b1 && e.stub.balance(t, "outlet", "KMG", "FG-002") == b2, "a replay changed the stub balances")
	})

	t.Run("e2e-transfer-pair", func(t *testing.T) {
		e.t = t
		p := e.product("FG-003", 0)
		e.exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,$3,20)
			ON CONFLICT (warehouse_id,product_id,variant_size) DO UPDATE SET stock = EXCLUDED.stock`, obeWarehouse, p, obeSize)
		e.open()
		repo := write.New(pool)
		h := &Handlers{Write: repo}
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), auth.CtxUserID, "u-obe")))
			})
		})
		router.Post("/transfers/{id}/send", h.SendTransfer)
		tid, err := repo.CreateTransfer(ctx, "", write.TransferCreate{
			Source: write.TransferLoc{Kind: "warehouse", ID: obeWarehouse}, Dest: write.TransferLoc{Kind: "outlet", ID: obeOutlet},
			Items: []write.TransferItemInput{{ProductID: p, VariantSize: obeSize, Qty: 10}}})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/transfers/"+tid+"/send", nil)
		req.Header.Set("Idempotency-Key", e.id("4"))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("send: %d %s", w.Code, w.Body.String())
		}
		rcv := write.TransferReceive{DiscrepancyReason: "rusak", Items: []write.TransferReceiveItem{{ProductID: p, VariantSize: obeSize, ReceivedQty: 9}}}
		if err := repo.ReceiveTransfer(ctx, tid, rcv, write.ReceiveMeta{ReceivedVia: "backoffice", IdempotencyKey: e.id("5")}); err != nil {
			t.Fatal(err)
		}
		out, in := e.outbox("transfer_out", tid), e.outbox("transfer_in", tid)
		rep := e.run()
		// The ERP takes outlets only: the warehouse leg stays held (even though the warehouse
		// has an erp_slug) and the outlet leg posts on its own.
		e.want(rep.Delivered == 1 && rep.Held == 1 && e.status(out.docID) == "held" && e.status(in.docID) == "delivered",
			"run %+v out=%s in=%s", rep, e.status(out.docID), e.status(in.docID))
		reason := e.str(`SELECT hold_reason FROM erp_outbox WHERE document_id=$1`, out.docID)
		e.want(strings.Contains(reason, "dokumen gudang"), "transfer_out hold_reason %q", reason)
		_, n := e.stub.docByID(t, out.docID)
		e.want(n == 0, "the stub got %d copies of the warehouse document, want 0", n)
		di, _ := e.stub.docByID(t, in.docID)
		e.want(di.Kind == "transfer_in" && di.Location.Type == "outlet" && di.Location.Code == "KMG", "transfer_in doc %+v", di)
		e.want(di.Ref.ID == tid, "ref id %s, want %s", di.Ref.ID, tid)
		e.want(len(di.Body.Lines) == 1, "transfer_in lines %+v", di.Body.Lines)
		l := di.Body.Lines[0]
		e.want(l.ExpectedQty != nil && *l.ExpectedQty == 10 && l.Qty == 9 && slices.Contains(l.Flags, "variance"),
			"transfer_in line %+v (expected_qty/variance)", l)
	})

	t.Run("e2e-admin-http", func(t *testing.T) {
		e.t = t
		h := NewErpOutbox(pool, config.ERPRelay{Enabled: true, BaseURL: e.stub.base + "/api/integration/v1",
			APIKey: e.stub.key, Brand: "mandalika", MaxAttempts: 10}, false)
		call := func(fn http.HandlerFunc, method, target, id string) (int, map[string]any) {
			t.Helper()
			r := httptest.NewRequest(method, target, nil)
			rc := chi.NewRouteContext()
			rc.URLParams.Add("id", id)
			r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rc))
			w := httptest.NewRecorder()
			fn(w, r)
			var body map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &body)
			return w.Code, body
		}
		p := e.product("FG-001", 10)
		e.open()
		order := e.sale([2]any{p, 1})
		row := e.outbox("sale", order)
		e.want(e.run().Delivered == 1, "setup delivery failed")

		code, body := call(h.ListOutbox, "GET", "/admin/erp/outbox?status=delivered&limit=200", "")
		e.want(code == 200, "list delivered: %d %v", code, body)
		found := false
		for _, it := range body["data"].([]any) {
			if it.(map[string]any)["documentId"] == row.docID {
				found = true
			}
		}
		counts, _ := body["counts"].(map[string]any)
		e.want(found && len(counts) == 6, "list: document present=%v counts=%v", found, counts)
		if code, _ = call(h.ListOutbox, "GET", "/admin/erp/outbox?status=bogus", ""); code != 400 {
			t.Fatalf("list status=bogus: %d, want 400", code)
		}

		code, body = call(h.GetOutbox, "GET", "/x", row.id)
		d, _ := body["data"].(map[string]any)
		_, isObj := d["payload"].(map[string]any)
		e.want(code == 200 && isObj, "get: %d payload object=%v", code, isObj)
		if code, _ = call(h.GetOutbox, "GET", "/x", "00000000-0000-4000-8f72-ffffffffffff"); code != 404 {
			t.Fatalf("get unknown: %d, want 404", code)
		}
		if code, _ = call(h.GetOutbox, "GET", "/x", "not-a-uuid"); code != 400 {
			t.Fatalf("get bad id: %d, want 400", code)
		}

		if code, body = call(h.RetryOutbox, "POST", "/x", row.id); code != 200 {
			t.Fatalf("retry delivered: %d %v", code, body)
		}
		code, body = call(h.RunRelay, "POST", "/x", "")
		rep, _ := body["data"].(map[string]any)
		e.want(code == 200 && rep["disabled"] != true && e.status(row.docID) == "replayed", "run relay: %d %v status %s", code, body, e.status(row.docID))

		e.exec(`UPDATE erp_outbox SET status='pending' WHERE id=$1`, row.id)
		if code, _ = call(h.RetryOutbox, "POST", "/x", row.id); code != 409 {
			t.Fatalf("retry pending: %d, want 409", code)
		}
		e.exec(`UPDATE erp_outbox SET status='replayed' WHERE id=$1`, row.id)
	})

	// The real ERP answers {"status":"success",...}, not the stub's {"success":true,...}:
	// a second stub process serves that envelope to a relay of its own.
	t.Run("e2e-erp-envelope", func(t *testing.T) {
		e.t = t
		stub := obeStartStub(t, "-envelope", "erp")
		relay := erp.NewRelay(pool, erp.NewStockDocClient(stub.base+"/api/integration/v1", stub.key, 5*time.Second),
			erp.Config{Enabled: true, Brand: "mandalika", BatchSize: 50}, slog.Default())
		p := e.product("FG-001", 5)
		e.open()
		row := e.outbox("sale", e.sale([2]any{p, 1}))
		rep := obrRun(t, ctx, relay)
		e.want(rep.Delivered == 1 && e.status(row.docID) == "delivered", "run %+v, status %s", rep, e.status(row.docID))
		stored := e.str(`SELECT erp_response::text FROM erp_outbox WHERE id=$1`, row.id)
		e.want(strings.Contains(stored, `"status": "success"`) && !strings.Contains(stored, `"success": true`),
			"stored response %s is not the ERP envelope", stored)
		_, n := stub.docByID(t, row.docID)
		e.want(n == 1, "ERP-envelope stub holds %d copies, want 1", n)

		e.park()
		if _, err := erp.Retry(ctx, pool, row.id); err != nil {
			t.Fatal(err)
		}
		rep = obrRun(t, ctx, relay)
		e.want(rep.Replayed == 1 && e.status(row.docID) == "replayed", "replay run %+v, status %s", rep, e.status(row.docID))
	})

	t.Run("e2e-invariant", func(t *testing.T) {
		bad, err := ledger.InvariantViolations(ctx, pool)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range bad {
			if v.LocationID == obeOutlet || v.LocationID == obeWarehouse {
				t.Fatalf("ledger invariant broken for an e2e location: %+v", v)
			}
		}
	})
}
