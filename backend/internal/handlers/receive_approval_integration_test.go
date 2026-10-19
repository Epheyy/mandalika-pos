package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// A08: online step-up approval for transfer receive. Driven through the real HTTP
// handlers and /sync/batch, checked with plain SQL. Opt-in fresh synthetic cluster.
func TestReceiveApprovalPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "RA", 56466)
	const (
		outletA = "00000000-0000-4000-8b00-000000000001" // receiving outlet
		outletB = "00000000-0000-4000-8b00-000000000002" // sending outlet
		outletC = "00000000-0000-4000-8b00-000000000003"
		cashA   = "00000000-0000-4000-8b00-000000000011"
		cashA2  = "00000000-0000-4000-8b00-000000000012"
		cashB   = "00000000-0000-4000-8b00-000000000013"
		adminU  = "00000000-0000-4000-8b00-000000000021"
		mgrA    = "00000000-0000-4000-8b00-000000000022"
		mgrA2   = "00000000-0000-4000-8b00-000000000023"
		noPinU  = "00000000-0000-4000-8b00-000000000024"
		cashPin = "00000000-0000-4000-8b00-000000000025" // cashier role with a PIN: ineligible
		missing = "00000000-0000-4000-8b00-0000000000ff"
		product = "00000000-0000-4000-8b02-000000000001"
		pin     = "4321"
	)
	exec := func(t testing.TB, sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	count := func(t testing.TB, sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}
	hash, err := auth.HashPassword(pin)
	if err != nil {
		t.Fatal(err)
	}
	exec(t, `INSERT INTO outlets(id,name) VALUES($1,'RA A'),($2,'RA B'),($3,'RA C')`, outletA, outletB, outletC)
	for _, u := range []struct{ id, role, outlet string }{
		{cashA, "cashier", outletA}, {cashA2, "cashier", outletA}, {cashB, "cashier", outletB},
		{adminU, "admin", ""}, {mgrA, "manager", outletA}, {mgrA2, "manager", outletA},
		{noPinU, "manager", outletA}, {cashPin, "cashier", outletA},
	} {
		exec(t, `INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,NULLIF($5,'')::uuid)`,
			u.id, u.id+"@example.invalid", "RA "+u.role+" "+u.id[len(u.id)-2:], u.role, u.outlet)
	}
	for _, id := range []string{adminU, mgrA, mgrA2, cashPin} {
		exec(t, `UPDATE users SET receive_pin_hash=$2, receive_pin_set_at=now() WHERE id=$1`, id, hash)
	}
	exec(t, `UPDATE app_settings SET receive_approver_roles='{manager}' WHERE id=1`)
	exec(t, `INSERT INTO products(id,name) VALUES($1,'RA product')`, product)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	store := auth.NewStore(pool)
	eng := syncpkg.New(pool, rd, svc, wr)
	h := New(rd, nil, store, wr, svc, eng, nil)
	secret := []byte("RA-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, []string{})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tokCashA, tokCashA2, tokCashB, tokAdmin := issue(cashA, "cashier", outletA), issue(cashA2, "cashier", outletA), issue(cashB, "cashier", outletB), issue(adminU, "admin", "")
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/sync/batch", h.SyncBatch)
	router.Get("/sync/receive-approvers", h.ListReceiveApprovers)
	router.Post("/sync/transfer-receive-approvals", h.CreateTransferReceiveApproval)
	router.Group(func(r chi.Router) {
		r.Use(mw.RequireRole("admin"))
		r.Put("/users/{id}/receive-pin", h.SetUserReceivePin)
		r.Delete("/users/{id}/receive-pin-lockout", h.ClearUserReceivePinLockout)
	})
	call := func(method, path, token string, body any) (int, http.Header, string) {
		var rdr *strings.Reader
		if body == nil {
			rdr = strings.NewReader("")
		} else {
			b, _ := json.Marshal(body)
			rdr = strings.NewReader(string(b))
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Header(), w.Body.String()
	}

	newTransfer := func(t *testing.T) string {
		t.Helper()
		exec(t, `INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',100)
			ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock=100`, outletB, product)
		id, err := wr.CreateTransfer(ctx, "", write.TransferCreate{
			Source: write.TransferLoc{Kind: "outlet", ID: outletB},
			Dest:   write.TransferLoc{Kind: "outlet", ID: outletA},
			Items:  []write.TransferItemInput{{ProductID: product, VariantSize: "M", Qty: 3}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := wr.SendTransfer(ctx, id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	destStock := func(t *testing.T) int {
		return count(t, `SELECT COALESCE((SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size='M'),0)`, outletA, product)
	}
	status := func(t *testing.T, id string) string {
		var s string
		if err := pool.QueryRow(ctx, `SELECT status FROM transfers WHERE id=$1`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	var keyMu sync.Mutex
	keyN := 0
	nextKey := func() string {
		keyMu.Lock()
		defer keyMu.Unlock()
		keyN++
		return fmt.Sprintf("ra-dev:key-%d", keyN)
	}
	items := func(qty int) []map[string]any {
		return []map[string]any{{"productId": product, "variantSize": "M", "receivedQty": qty}}
	}
	mintBody := func(tid, key, approver, pinText string, qty int, reason string) map[string]any {
		return map[string]any{"transferId": tid, "idempotencyKey": key, "items": items(qty),
			"discrepancyReason": reason, "approverUserId": approver, "pin": pinText, "deviceId": "dev-1"}
	}
	mintOK := func(t *testing.T, token, tid, key, approver string, qty int, reason string) string {
		t.Helper()
		code, _, body := call("POST", "/sync/transfer-receive-approvals", token, mintBody(tid, key, approver, pin, qty, reason))
		if code != 201 {
			t.Fatalf("mint: %d %s", code, body)
		}
		var out struct {
			Data struct {
				ApprovalGrantID string `json:"approvalGrantId"`
				ApproverName    string `json:"approverName"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &out); err != nil || out.Data.ApprovalGrantID == "" || out.Data.ApproverName == "" {
			t.Fatalf("mint body: %s %v", body, err)
		}
		if strings.Contains(body, `"pin"`) {
			t.Fatal("PIN echoed")
		}
		return out.Data.ApprovalGrantID
	}
	redeemPayload := func(tid, approver, grantID string, qty int, reason string) map[string]any {
		return map[string]any{"transferId": tid, "items": items(qty), "discrepancyReason": reason,
			"approverUserId": approver, "approvalGrantId": grantID}
	}
	batch := func(t *testing.T, token, key string, payload any) syncpkg.ItemResult {
		t.Helper()
		pb, _ := json.Marshal(payload)
		body := fmt.Sprintf(`{"items":[{"type":"transfer_receive","idempotencyKey":%q,"payload":%s}]}`, key, pb)
		r := httptest.NewRequest("POST", "/sync/batch", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out struct {
			Data syncpkg.BatchResult `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 || len(out.Data.Results) != 1 {
			t.Fatalf("batch: %d %s %v", w.Code, w.Body.String(), err)
		}
		return out.Data.Results[0]
	}
	wantOK := func(t *testing.T, r syncpkg.ItemResult) {
		t.Helper()
		if r.Status != "ok" || r.OrderID == "" {
			t.Fatalf("want ok, got %+v", r)
		}
	}
	wantRefused := func(t *testing.T, r syncpkg.ItemResult, code string) {
		t.Helper()
		if r.Status != "error" || r.Code != code || r.Retryable == nil || *r.Retryable {
			t.Fatalf("want non-retryable %s, got %+v", code, r)
		}
	}
	consumed := func(t *testing.T, key string) bool {
		var c bool
		if err := pool.QueryRow(ctx, `SELECT consumed_at IS NOT NULL FROM transfer_receive_approvals WHERE outlet_id=$1 AND receipt_key=$2`, outletA, key).Scan(&c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	resetLocks := func(t *testing.T) { exec(t, `DELETE FROM receive_pin_lockouts`) }
	attempts := func(t *testing.T, outcome string) int {
		return count(t, `SELECT count(*) FROM receive_pin_attempts WHERE outcome=$1`, outcome)
	}

	t.Run("mint-then-redeem-completes-once", func(t *testing.T) {
		tid, key := newTransfer(t), nextKey()
		before := destStock(t)
		g := mintOK(t, tokCashA, tid, key, adminU, 3, "")
		wantOK(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, "")))
		if status(t, tid) != "completed" || destStock(t) != before+3 {
			t.Fatalf("not received once: %s %d", status(t, tid), destStock(t))
		}
		if n := count(t, `SELECT count(*) FROM transfers WHERE id=$1 AND received_by=$2 AND received_idempotency_key=$3`, tid, adminU, key); n != 1 {
			t.Fatal("received_by must be the grant's approver")
		}
		if !consumed(t, key) {
			t.Fatal("grant not consumed")
		}
		if attempts(t, "granted") < 1 {
			t.Fatal("no granted attempt")
		}
	})

	t.Run("replay-survives-expiry-and-pin-reset", func(t *testing.T) {
		tid, key := newTransfer(t), nextKey()
		g := mintOK(t, tokCashA, tid, key, adminU, 3, "")
		wantOK(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, "")))
		before := destStock(t)
		exec(t, `UPDATE transfer_receive_approvals SET expires_at=now()-interval '1 hour' WHERE receipt_key=$1`, key)
		exec(t, `UPDATE users SET receive_pin_set_at=now() WHERE id=$1`, adminU)
		again := batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, ""))
		wantOK(t, again)
		if again.Transfer == nil || again.OrderID != tid {
			t.Fatalf("replay lost the transfer snapshot: %+v", again)
		}
		if destStock(t) != before {
			t.Fatal("replay credited twice")
		}
	})

	t.Run("grant-cannot-be-reused-for-another-key", func(t *testing.T) {
		tid, key := newTransfer(t), nextKey()
		g := mintOK(t, tokCashA, tid, key, adminU, 3, "")
		wantRefused(t, batch(t, tokCashA, nextKey(), redeemPayload(tid, adminU, g, 3, "")), "forbidden")
		if status(t, tid) != "in_transit" || consumed(t, key) {
			t.Fatal("refused redemption must not complete or consume")
		}
		wantOK(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, ""))) // the right key still works
	})

	t.Run("expired-grant-goes-to-review", func(t *testing.T) {
		tid, key := newTransfer(t), nextKey()
		g := mintOK(t, tokCashA, tid, key, adminU, 3, "")
		exec(t, `UPDATE transfer_receive_approvals SET expires_at=now()-interval '1 second' WHERE receipt_key=$1`, key)
		wantRefused(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, "")), "forbidden")
		if status(t, tid) != "in_transit" || consumed(t, key) {
			t.Fatal("expired grant changed state")
		}
	})

	t.Run("binding-mismatches-are-refused", func(t *testing.T) {
		tid, key := newTransfer(t), nextKey()
		g := mintOK(t, tokCashA, tid, key, adminU, 2, "rusak")
		wantRefused(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, "rusak")), "forbidden")  // other counts
		wantRefused(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 2, "hilang")), "forbidden") // other reason
		wantRefused(t, batch(t, tokCashA2, key, redeemPayload(tid, adminU, g, 2, "rusak")), "forbidden") // other requester
		other := newTransfer(t)
		wantRefused(t, batch(t, tokCashA, key, redeemPayload(other, adminU, g, 2, "rusak")), "forbidden") // other transfer
		wantRefused(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, "00000000-0000-4000-8b09-000000000001", 2, "rusak")), "forbidden")
		wantRefused(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, "not-a-uuid", 2, "rusak")), "forbidden")
		if status(t, tid) != "in_transit" || consumed(t, key) {
			t.Fatal("a mismatch changed state")
		}
		wantOK(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 2, "rusak"))) // exact match works; device mismatch only warns
	})

	t.Run("mint-refuses-other-outlet-and-wrong-state", func(t *testing.T) {
		tid := newTransfer(t)
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashB, mintBody(tid, nextKey(), adminU, pin, 3, "")); code != 403 {
			t.Fatalf("other outlet: %d", code)
		}
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(missing, nextKey(), adminU, pin, 3, "")); code != 404 {
			t.Fatalf("missing transfer: %d", code)
		}
		key := nextKey()
		g := mintOK(t, tokCashA, tid, key, adminU, 3, "")
		wantOK(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, "")))
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), adminU, pin, 3, "")); code != 409 {
			t.Fatalf("completed transfer: %d", code)
		}
		// A consumed key cannot be re-minted.
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(newTransfer(t), key, adminU, pin, 3, "")); code != 409 {
			t.Fatalf("consumed key re-mint: %d", code)
		}
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, map[string]any{"transferId": "nope"}); code != 400 {
			t.Fatalf("bad body: %d", code)
		}
	})

	t.Run("remint-same-key-refreshes-unconsumed-grant", func(t *testing.T) {
		tid, key := newTransfer(t), nextKey()
		g1 := mintOK(t, tokCashA, tid, key, adminU, 3, "")
		g2 := mintOK(t, tokCashA, tid, key, mgrA, 3, "")
		if g1 != g2 {
			t.Fatal("same key must keep one grant row")
		}
		if n := count(t, `SELECT count(*) FROM transfer_receive_approvals WHERE receipt_key=$1 AND approver_id=$2`, key, mgrA); n != 1 {
			t.Fatal("re-mint did not refresh the approver")
		}
		wantOK(t, batch(t, tokCashA, key, redeemPayload(tid, mgrA, g2, 3, "")))
	})

	t.Run("revocation", func(t *testing.T) {
		exec(t, `UPDATE users SET receive_pin_hash=$2, receive_pin_set_at=now() WHERE id=$1`, noPinU, hash)
		cases := []struct {
			name, approver string
			revoke, undo   func(t *testing.T)
		}{
			{"pin-reset", mgrA, func(t *testing.T) {
				if code, _, b := call("PUT", "/users/"+mgrA+"/receive-pin", tokAdmin, map[string]any{"pin": "9999"}); code != 200 {
					t.Fatalf("set pin: %d %s", code, b)
				}
			}, func(t *testing.T) {
				exec(t, `UPDATE users SET receive_pin_hash=$2, receive_pin_set_at=now() WHERE id=$1`, mgrA, hash)
			}},
			{"role-removed", mgrA2, func(t *testing.T) { exec(t, `UPDATE app_settings SET receive_approver_roles='{}' WHERE id=1`) },
				func(t *testing.T) { exec(t, `UPDATE app_settings SET receive_approver_roles='{manager}' WHERE id=1`) }},
			{"moved-outlet", mgrA2, func(t *testing.T) { exec(t, `UPDATE users SET outlet_id=$2 WHERE id=$1`, mgrA2, outletC) },
				func(t *testing.T) { exec(t, `UPDATE users SET outlet_id=$2 WHERE id=$1`, mgrA2, outletA) }},
			{"deleted", noPinU, func(t *testing.T) { exec(t, `DELETE FROM users WHERE id=$1`, noPinU) }, func(t *testing.T) {}},
		}
		for _, c := range cases {
			c := c
			t.Run(c.name, func(t *testing.T) {
				resetLocks(t)
				tid, key := newTransfer(t), nextKey()
				g := mintOK(t, tokCashA, tid, key, c.approver, 3, "")
				c.revoke(t)
				wantRefused(t, batch(t, tokCashA, key, redeemPayload(tid, c.approver, g, 3, "")), "forbidden")
				if status(t, tid) != "in_transit" {
					t.Fatal("revoked grant completed the transfer")
				}
				c.undo(t)
			})
		}
	})

	t.Run("lockout-approver", func(t *testing.T) {
		resetLocks(t)
		tid := newTransfer(t)
		for i := 0; i < 5; i++ {
			code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), adminU, "0000", 3, ""))
			if code != 403 {
				t.Fatalf("wrong pin %d: %d", i, code)
			}
		}
		code, hdr, body := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), adminU, pin, 3, ""))
		if code != 429 {
			t.Fatalf("correct PIN while locked must be 429, got %d %s", code, body)
		}
		if n, err := strconv.Atoi(hdr.Get("Retry-After")); err != nil || n < 800 || n > 900 {
			t.Fatalf("Retry-After %q", hdr.Get("Retry-After"))
		}
		if attempts(t, "locked") < 1 {
			t.Fatal("locked attempt not recorded")
		}
		// Time unlocks (moved with SQL, no sleeping); the next cycle doubles.
		exec(t, `UPDATE receive_pin_lockouts SET locked_until=now()-interval '1 second' WHERE user_id=$1`, adminU)
		for i := 0; i < 5; i++ {
			call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), adminU, "0000", 3, ""))
		}
		var secs float64
		if err := pool.QueryRow(ctx, `SELECT extract(epoch FROM locked_until-now()) FROM receive_pin_lockouts WHERE subject_kind='approver' AND user_id=$1`, adminU).Scan(&secs); err != nil || secs < 1700 || secs > 1800 {
			t.Fatalf("second lock should be about 30 min: %v %v", secs, err)
		}
		exec(t, `UPDATE receive_pin_lockouts SET locked_until=now()-interval '1 second' WHERE user_id=$1`, adminU)
		for i := 0; i < 5; i++ {
			call("POST", "/sync/transfer-receive-approvals", tokCashA2, mintBody(tid, nextKey(), adminU, "0000", 3, ""))
		}
		exec(t, `UPDATE receive_pin_lockouts SET locked_until=now()-interval '1 day' WHERE user_id=$1`, adminU)
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA2, mintBody(tid, nextKey(), adminU, pin, 3, "")); code != 429 {
			t.Fatalf("hard lock must not expire with time: %d", code)
		}
		// Admin unlock clears it.
		if code, _, _ := call("DELETE", "/users/"+adminU+"/receive-pin-lockout", tokAdmin, nil); code != 204 {
			t.Fatalf("unlock: %d", code)
		}
		mintOK(t, tokCashA2, tid, nextKey(), adminU, 3, "")
	})

	t.Run("lockout-cleared-by-pin-reset-and-success-resets-counter", func(t *testing.T) {
		resetLocks(t)
		tid := newTransfer(t)
		for i := 0; i < 4; i++ {
			call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), mgrA2, "0000", 3, ""))
		}
		mintOK(t, tokCashA, tid, nextKey(), mgrA2, 3, "") // success resets the counter
		for i := 0; i < 4; i++ {
			call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), mgrA2, "0000", 3, ""))
		}
		mintOK(t, tokCashA, tid, nextKey(), mgrA2, 3, "") // still not locked: 4+4 never consecutive 5
		for i := 0; i < 5; i++ {
			call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), mgrA2, "0000", 3, ""))
		}
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), mgrA2, pin, 3, "")); code != 429 {
			t.Fatalf("want locked: %d", code)
		}
		if code, _, b := call("PUT", "/users/"+mgrA2+"/receive-pin", tokAdmin, map[string]any{"pin": pin}); code != 200 {
			t.Fatalf("set pin: %d %s", code, b)
		}
		mintOK(t, tokCashA, tid, nextKey(), mgrA2, 3, "")
	})

	t.Run("lockout-requester-across-approvers", func(t *testing.T) {
		resetLocks(t)
		tid := newTransfer(t)
		for i := 0; i < 10; i++ {
			a := []string{adminU, mgrA, mgrA2}[i%3]
			if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), a, "0000", 3, "")); code != 403 {
				t.Fatalf("wrong pin %d: %d", i, code)
			}
		}
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), adminU, pin, 3, "")); code != 429 {
			t.Fatalf("requester must be locked: %d", code)
		}
		mintOK(t, tokCashA2, tid, nextKey(), adminU, 3, "") // another requester is unaffected
	})

	t.Run("parallel-guesses-yield-exactly-the-threshold", func(t *testing.T) {
		resetLocks(t)
		exec(t, `DELETE FROM receive_pin_attempts`)
		tid := newTransfer(t)
		codes := make([]int, 10)
		var wg sync.WaitGroup
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				codes[i], _, _ = call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), mgrA, "0000", 3, ""))
			}(i)
		}
		wg.Wait()
		// A slow runner may turn a few waiters into 503 (lock wait timeout); the guarantee is that
		// no more than the threshold of wrong PINs is ever evaluated and none ever succeeds.
		n403, n429 := 0, 0
		for _, c := range codes {
			switch c {
			case 403:
				n403++
			case 429:
				n429++
			case 503:
			default:
				t.Fatalf("unexpected %v", codes)
			}
		}
		if n403 > 5 || n403 != attempts(t, "wrong_pin") || n429 != attempts(t, "locked") || attempts(t, "granted") != 0 {
			t.Fatalf("403=%d 429=%d wrong=%d locked=%d granted=%d", n403, n429, attempts(t, "wrong_pin"), attempts(t, "locked"), attempts(t, "granted"))
		}
	})

	t.Run("refusals-are-uniform-and-pin-is-never-stored", func(t *testing.T) {
		resetLocks(t)
		tid := newTransfer(t)
		first := ""
		for _, c := range []struct{ name, approver, pin string }{
			{"unknown", missing, pin}, {"ineligible", cashPin, pin}, {"no-pin", noPinU, pin}, {"wrong", adminU, "0000"},
		} {
			if c.name == "no-pin" {
				exec(t, `INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,'nopin2@example.invalid','x','RA nopin','manager',$2)
					ON CONFLICT DO NOTHING`, "00000000-0000-4000-8b00-000000000026", outletA)
				c.approver = "00000000-0000-4000-8b00-000000000026"
			}
			code, _, body := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), c.approver, c.pin, 3, ""))
			got := fmt.Sprintf("%d %s", code, body)
			if first == "" {
				first = got
			}
			if got != first || code != 403 || !strings.Contains(body, "PIN salah atau penyetuju tidak berwenang") {
				t.Fatalf("%s: %q differs from %q", c.name, got, first)
			}
		}
		if n := count(t, `SELECT count(*) FROM receive_pin_attempts WHERE outcome='ineligible'`); n < 3 {
			t.Fatalf("ineligible attempts %d", n)
		}
		// There is no column that could hold a PIN or a hash in any A08 table.
		if n := count(t, `SELECT count(*) FROM information_schema.columns
			WHERE table_name IN ('receive_pin_attempts','receive_pin_lockouts','transfer_receive_approvals')
			  AND (column_name ILIKE '%hash%' OR column_name = 'pin')`); n != 0 {
			t.Fatal("an A08 table has a PIN or hash column")
		}
	})

	t.Run("competing-receipts-one-wins", func(t *testing.T) {
		resetLocks(t)
		tid, k1, k2 := newTransfer(t), nextKey(), nextKey()
		g1 := mintOK(t, tokCashA, tid, k1, adminU, 3, "")
		g2 := mintOK(t, tokCashA2, tid, k2, adminU, 3, "")
		wantOK(t, batch(t, tokCashA, k1, redeemPayload(tid, adminU, g1, 3, "")))
		wantRefused(t, batch(t, tokCashA2, k2, redeemPayload(tid, adminU, g2, 3, "")), "competing_receipt")
		if consumed(t, k2) {
			t.Fatal("the losing grant must stay unconsumed")
		}
	})

	t.Run("legacy-pin-item-is-forbidden-and-pin-never-verified", func(t *testing.T) {
		resetLocks(t)
		exec(t, `DELETE FROM receive_pin_attempts`)
		tid := newTransfer(t)
		r := batch(t, tokCashA, nextKey(), map[string]any{"transferId": tid, "items": items(3), "approverUserId": adminU, "pin": pin})
		wantRefused(t, r, "forbidden")
		if status(t, tid) != "in_transit" || count(t, `SELECT count(*) FROM receive_pin_attempts`) != 0 || count(t, `SELECT count(*) FROM receive_pin_lockouts`) != 0 {
			t.Fatal("legacy item verified a PIN or changed state")
		}
	})

	t.Run("refused-receive-rolls-the-grant-back", func(t *testing.T) {
		resetLocks(t)
		tid, key := newTransfer(t), nextKey()
		g := mintOK(t, tokCashA, tid, key, adminU, 1, "") // differs from sent=3 but no reason
		wantRefused(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 1, "")), "rejected")
		if consumed(t, key) || status(t, tid) != "in_transit" {
			t.Fatal("a rejected receive must not burn the grant")
		}
	})

	t.Run("backoffice-receive-without-approval-still-works", func(t *testing.T) {
		tid := newTransfer(t)
		if err := wr.ReceiveTransfer(ctx, tid, write.TransferReceive{}, write.ReceiveMeta{ReceivedBy: adminU, ReceivedVia: "backoffice"}); err != nil {
			t.Fatal(err)
		}
		if status(t, tid) != "completed" {
			t.Fatal("not completed")
		}
	})

	t.Run("approver-list-has-no-hash-and-pull-ships-none", func(t *testing.T) {
		resetLocks(t)
		code, _, body := call("GET", "/sync/receive-approvers", tokCashA, nil)
		if code != 200 || strings.Contains(body, "argon2id") || strings.Contains(body, "receivePinHash") || !strings.Contains(body, adminU) {
			t.Fatalf("approvers: %d %s", code, body)
		}
		bundle, err := eng.Pull(ctx, read.Scope{OutletID: outletA}, outletA)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(bundle)
		if strings.Contains(string(b), "argon2id") || strings.Contains(string(b), "receivePinHash") || !strings.Contains(string(b), `"receiveApprovers":[]`) {
			t.Fatal("pull must ship receiveApprovers [] and no hash")
		}
	})

	t.Run("outsider-guesses-do-not-lock-another-outlets-approver", func(t *testing.T) {
		resetLocks(t)
		// A transfer to outlet B: cashier B asks, naming the outlet A manager (ineligible for B).
		exec(t, `INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,'M',100)
			ON CONFLICT (outlet_id,product_id,variant_size) DO UPDATE SET stock=100`, outletA, product)
		tidB, err := wr.CreateTransfer(ctx, "", write.TransferCreate{
			Source: write.TransferLoc{Kind: "outlet", ID: outletA},
			Dest:   write.TransferLoc{Kind: "outlet", ID: outletB},
			Items:  []write.TransferItemInput{{ProductID: product, VariantSize: "M", Qty: 3}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := wr.SendTransfer(ctx, tidB); err != nil {
			t.Fatal(err)
		}
		var first string
		for i := 0; i < 7; i++ {
			code, _, body := call("POST", "/sync/transfer-receive-approvals", tokCashB, mintBody(tidB, nextKey(), mgrA, "0000", 3, ""))
			got := fmt.Sprintf("%d %s", code, body)
			if i == 0 {
				first = got
			}
			if code != 403 || got != first {
				t.Fatalf("attempt %d must stay the uniform 403 (the approver lock state must not leak): %q", i, got)
			}
		}
		if n := count(t, `SELECT count(*) FROM receive_pin_lockouts WHERE subject_kind='approver' AND user_id=$1 AND (failures>0 OR locked_until IS NOT NULL OR hard_locked)`, mgrA); n != 0 {
			t.Fatal("an outsider advanced another outlet's approver counter")
		}
		if n := count(t, `SELECT failures FROM receive_pin_lockouts WHERE subject_kind='requester' AND user_id=$1`, cashB); n != 7 {
			t.Fatalf("requester failure counter %d, want 7", n)
		}
		// The requester IS throttled (10 failures lock), and the real approver is untouched.
		tidA := newTransfer(t)
		mintOK(t, tokCashA2, tidA, nextKey(), mgrA, 3, "")
	})

	t.Run("remint-never-rebinds-another-users-grant", func(t *testing.T) {
		resetLocks(t)
		tid, key := newTransfer(t), nextKey()
		g := mintOK(t, tokCashA, tid, key, adminU, 3, "")
		if code, _, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA2, mintBody(tid, key, adminU, pin, 3, "")); code != 409 {
			t.Fatalf("another user re-minting the key must be refused, got %d", code)
		}
		if n := count(t, `SELECT count(*) FROM transfer_receive_approvals WHERE receipt_key=$1 AND requested_by=$2`, key, cashA); n != 1 {
			t.Fatal("the grant was rebound to another user")
		}
		wantRefused(t, batch(t, tokCashA2, key, redeemPayload(tid, adminU, g, 3, "")), "forbidden")
		wantOK(t, batch(t, tokCashA, key, redeemPayload(tid, adminU, g, 3, "")))
	})

	t.Run("burst-from-one-requester-does-not-exhaust-a-small-pool", func(t *testing.T) {
		resetLocks(t)
		cfg, err := pgxpool.ParseConfig(os.Getenv("MANDALIKA_RA_TEST_DSN"))
		if err != nil {
			t.Fatal(err)
		}
		cfg.MaxConns = 4
		small, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer small.Close()
		rd4, wr4, svc4 := read.New(small), write.New(small), service.NewOrderService(small)
		h4 := New(rd4, nil, auth.NewStore(small), wr4, svc4, syncpkg.New(small, rd4, svc4, wr4), nil)
		r4 := chi.NewRouter()
		r4.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
		r4.Post("/sync/transfer-receive-approvals", h4.CreateTransferReceiveApproval)
		tid := newTransfer(t)
		start := time.Now()
		codes := make([]int, 16)
		var wg sync.WaitGroup
		for i := range codes {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				b, _ := json.Marshal(mintBody(tid, nextKey(), mgrA, "0000", 3, ""))
				req := httptest.NewRequest("POST", "/sync/transfer-receive-approvals", strings.NewReader(string(b)))
				req.Header.Set("Authorization", "Bearer "+tokCashA)
				w := httptest.NewRecorder()
				r4.ServeHTTP(w, req)
				codes[i] = w.Code
			}(i)
		}
		// Other work through the same small pool must keep finishing while the burst runs.
		done := make(chan error, 1)
		go func() {
			var one int
			done <- small.QueryRow(ctx, `SELECT 1`).Scan(&one)
		}()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(8 * time.Second):
			t.Fatal("an unrelated query starved behind the burst")
		}
		wg.Wait()
		for _, c := range codes {
			if c != 403 && c != 429 && c != 503 {
				t.Fatalf("unexpected status %v", codes)
			}
		}
		if time.Since(start) > 30*time.Second {
			t.Fatal("burst took too long")
		}
		if n := small.Stat().AcquiredConns(); n != 0 {
			t.Fatalf("%d connections still held after the burst", n)
		}
	})

	t.Run("held-lockout-row-fails-fast-as-503", func(t *testing.T) {
		resetLocks(t)
		tid := newTransfer(t)
		call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), adminU, "0000", 3, "")) // creates the rows
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `SELECT 1 FROM receive_pin_lockouts WHERE subject_kind='requester' AND user_id=$1 FOR UPDATE`, cashA); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		code, hdr, _ := call("POST", "/sync/transfer-receive-approvals", tokCashA, mintBody(tid, nextKey(), adminU, pin, 3, ""))
		if code != 503 || hdr.Get("Retry-After") == "" || time.Since(start) > 6*time.Second {
			t.Fatalf("want a quick 503 with Retry-After, got %d after %v", code, time.Since(start))
		}
	})

	// Keep this LAST: it clears every receive PIN of the fixture. The gate migrates a fresh
	// database, so the file is executed here against rows that do carry a PIN.
	t.Run("migration-0063-wipes-every-receive-pin", func(t *testing.T) {
		if n := count(t, `SELECT count(*) FROM users WHERE receive_pin_hash IS NOT NULL`); n == 0 {
			t.Fatal("fixture should still hold PINs")
		}
		sqlBytes, err := os.ReadFile(filepath.Join("..", "db", "migrations", "0063_receive_pin_wipe.sql"))
		if err != nil {
			t.Fatal(err)
		}
		snapshot := func() string {
			var out string
			if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(u) - 'receive_pin_hash' - 'receive_pin_set_at' ORDER BY id)::text FROM users u`).Scan(&out); err != nil {
				t.Fatal(err)
			}
			return out
		}
		before := snapshot()
		exec(t, string(sqlBytes))
		if n := count(t, `SELECT count(*) FROM users WHERE receive_pin_hash IS NOT NULL OR receive_pin_set_at IS NOT NULL`); n != 0 {
			t.Fatalf("%d users still carry a receive PIN", n)
		}
		if after := snapshot(); after != before {
			t.Fatal("the wipe changed a column other than the two PIN columns")
		}
		exec(t, string(sqlBytes)) // idempotent
		if code, _, body := call("GET", "/sync/receive-approvers", tokCashA, nil); code != 200 || strings.Contains(body, adminU) {
			t.Fatalf("no approver may be listed without a PIN: %d %s", code, body)
		}
	})
	_ = tokCashB
}
