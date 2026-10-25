package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/rules"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Inventory controls S3: approval of manual adjustments and stock counts. Driven through the real
// handlers, checked with plain SQL. Opt-in fresh synthetic cluster (port 56472).
func TestInventoryApprovalPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "AP", 56472)
	const (
		outA    = "00000000-0000-4000-8c00-000000000001"
		outB    = "00000000-0000-4000-8c00-000000000002"
		whW     = "00000000-0000-4000-8c00-000000000003"
		adminU  = "00000000-0000-4000-8c00-000000000011"
		admin2  = "00000000-0000-4000-8c00-000000000012"
		mgrA    = "00000000-0000-4000-8c00-000000000013"
		mgrA2   = "00000000-0000-4000-8c00-000000000014"
		mgrB    = "00000000-0000-4000-8c00-000000000015"
		clerkA  = "00000000-0000-4000-8c00-000000000016" // not an approver role, has a PIN
		product = "00000000-0000-4000-8c02-000000000001"
		pin     = "4321"
		pin2    = "8765"
	)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("exec %q: %v", sql, err)
		}
	}
	num := func(sql string, args ...any) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("query %q: %v", sql, err)
		}
		return n
	}
	str := func(sql string, args ...any) string {
		t.Helper()
		var s string
		if err := pool.QueryRow(ctx, sql, args...).Scan(&s); err != nil {
			t.Fatalf("query %q: %v", sql, err)
		}
		return s
	}
	hash, err := rules.HashPassword(pin)
	if err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO outlets(id,name) VALUES($1,'AP A'),($2,'AP B')`, outA, outB)
	exec(`INSERT INTO warehouses(id,name) VALUES($1,'AP W')`, whW)
	for _, u := range []struct{ id, role, outlet string }{
		{adminU, "admin", ""}, {admin2, "admin", ""}, {mgrA, "manager", outA}, {mgrA2, "manager", outA},
		{mgrB, "manager", outB}, {clerkA, "cashier", outA},
	} {
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x',$3,$4,NULLIF($5,'')::uuid)`,
			u.id, u.id+"@example.invalid", "AP "+u.role+" "+u.id[len(u.id)-2:], u.role, u.outlet)
		exec(`UPDATE users SET receive_pin_hash=$2, receive_pin_set_at=now() WHERE id=$1`, u.id, hash)
	}
	exec(`UPDATE app_settings SET receive_approver_roles='{manager}' WHERE id=1`)
	exec(`INSERT INTO products(id,name) VALUES($1,'AP product')`, product)
	for _, sz := range []string{"M", "L", "S"} {
		exec(`INSERT INTO product_variants(product_id,size,price,sku) VALUES($1,$2,1000,$3)`, product, sz, "AP-"+sz)
		exec(`INSERT INTO outlet_variant_stock(outlet_id,product_id,variant_size,stock) VALUES($1,$2,$3,10)`, outA, product, sz)
		exec(`INSERT INTO warehouse_variant_stock(warehouse_id,product_id,variant_size,stock) VALUES($1,$2,$3,10)`, whW, product, sz)
	}
	stockA := func(sz string) int {
		return num(`SELECT stock FROM outlet_variant_stock WHERE outlet_id=$1 AND product_id=$2 AND variant_size=$3`, outA, product, sz)
	}
	stockW := func(sz string) int {
		return num(`SELECT stock FROM warehouse_variant_stock WHERE warehouse_id=$1 AND product_id=$2 AND variant_size=$3`, whW, product, sz)
	}
	setFlag := func(on bool) { exec(`UPDATE app_settings SET inventory_approval_required=$1 WHERE id=1`, on) }
	clearLocks := func() {
		exec(`UPDATE receive_pin_lockouts SET failures=0, lock_cycles=0, locked_until=NULL, hard_locked=false`)
	}

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	secret := []byte("AP-SYNTHETIC-TEST-KEY")
	issue := func(user, role, outlet string, perms ...string) string {
		tok, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	both := []string{"manage_inventory", "manage_stock_count"}
	tokAdmin, tokAdmin2 := issue(adminU, "admin", ""), issue(admin2, "admin", "")
	tokMgrA, tokMgrA2 := issue(mgrA, "manager", outA, both...), issue(mgrA2, "manager", outA, both...)
	tokMgrB, tokClerk := issue(mgrB, "manager", outB, both...), issue(clerkA, "cashier", outA, both...)
	tokInvOnly, tokCountOnly := issue(mgrA2, "manager", outA, "manage_inventory"), issue(mgrA2, "manager", outA, "manage_stock_count")
	tokNone := issue(mgrA2, "manager", outA)

	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: secret}))
	router.Post("/inventory/adjust", h.AdjustLocationStock)
	router.Get("/inventory/adjustment-requests", h.ListAdjustmentRequests)
	router.Post("/inventory/adjustment-requests", h.CreateAdjustmentRequest)
	router.Get("/inventory/adjustment-requests/{id}", h.GetAdjustmentRequest)
	router.Post("/inventory/adjustment-requests/{id}/approve", h.ApproveAdjustmentRequest)
	router.Post("/inventory/adjustment-requests/{id}/reject", h.RejectAdjustmentRequest)
	router.Post("/inventory/adjustment-requests/{id}/cancel", h.CancelAdjustmentRequest)
	router.Get("/inventory/approvals", h.ListInventoryApprovals)
	router.Post("/stock-counts", h.CreateStockCount)
	router.Put("/stock-counts/{id}", h.UpdateStockCount)
	router.Post("/stock-counts/{id}/complete", h.CompleteStockCount)
	router.Post("/stock-counts/{id}/submit", h.SubmitStockCount)
	router.Post("/stock-counts/{id}/approve", h.ApproveStockCount)
	router.Post("/stock-counts/{id}/reject", h.RejectStockCount)

	call := func(method, path, token, key string, body any) (int, http.Header, string) {
		t.Helper()
		var rdr *strings.Reader
		if body == nil {
			rdr = strings.NewReader("")
		} else {
			b, _ := json.Marshal(body)
			rdr = strings.NewReader(string(b))
		}
		r := httptest.NewRequest(method, path, rdr)
		r.Header.Set("Authorization", "Bearer "+token)
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w.Code, w.Header(), w.Body.String()
	}
	keyN := 0
	nextKey := func() string { keyN++; return fmt.Sprintf("ap-key-%d", keyN) }
	dataID := func(body string) string {
		t.Helper()
		var o struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(body), &o); err != nil || o.Data.ID == "" {
			t.Fatalf("no data.id in %s (%v)", body, err)
		}
		return o.Data.ID
	}
	mustCode := func(label string, want int, code int, body string) {
		t.Helper()
		if code != want {
			t.Fatalf("%s: status %d want %d: %s", label, code, want, body)
		}
	}
	reqBody := func(loc, id, size string, newQty int, reason, text string) map[string]any {
		return map[string]any{"locationType": loc, "locationId": id, "productId": product, "variantSize": size,
			"newQty": newQty, "reasonCode": reason, "reasonText": text}
	}
	newReq := func(token, loc, id, size string, newQty int) string {
		t.Helper()
		code, _, body := call("POST", "/inventory/adjustment-requests", token, nextKey(), reqBody(loc, id, size, newQty, "damaged", ""))
		mustCode("create request", 201, code, body)
		return dataID(body)
	}
	approve := func(token, id, key, pinText string) (int, http.Header, string) {
		return call("POST", "/inventory/adjustment-requests/"+id+"/approve", token, key, map[string]any{"pin": pinText, "note": "ok"})
	}
	status := func(table, id string) string { return str(`SELECT status FROM `+table+` WHERE id=$1`, id) }
	events := func(docType, id string) string {
		return str(`SELECT COALESCE(string_agg(action, ',' ORDER BY id), '') FROM inventory_doc_events WHERE doc_type=$1 AND doc_id=$2`, docType, id)
	}
	ledgerOK := func() {
		t.Helper()
		if n := num(`SELECT count(*) FROM stock_movements WHERE qty_after <> qty_before + qty`); n != 0 {
			t.Fatalf("ledger invariant broken on %d rows", n)
		}
	}

	t.Run("flag off: direct adjust and complete are unchanged", func(t *testing.T) {
		code, _, body := call("POST", "/inventory/adjust?kind=outlet&id="+outA, tokAdmin, nextKey(),
			map[string]any{"productId": product, "variantSize": "S", "newQty": 11, "reason": "baseline"})
		mustCode("direct adjust", 200, code, body)
		if stockA("S") != 11 {
			t.Fatalf("stock S=%d", stockA("S"))
		}
		exec(`UPDATE outlet_variant_stock SET stock=10 WHERE outlet_id=$1 AND variant_size='S'`, outA)
	})

	setFlag(true)
	t.Run("flag on: the direct adjust is refused with the approval_required code", func(t *testing.T) {
		for _, key := range []string{nextKey(), ""} {
			code, _, body := call("POST", "/inventory/adjust?kind=outlet&id="+outA, tokAdmin, key,
				map[string]any{"productId": product, "variantSize": "M", "newQty": 3, "reason": "x"})
			mustCode("direct adjust under flag", 409, code, body)
			var o struct {
				Error string `json:"error"`
				Data  struct {
					Code string `json:"code"`
				} `json:"data"`
			}
			if json.Unmarshal([]byte(body), &o) != nil || o.Data.Code != "approval_required" || o.Error == "" {
				t.Fatalf("body %s", body)
			}
		}
		if stockA("M") != 10 {
			t.Fatalf("stock moved: %d", stockA("M"))
		}
	})

	t.Run("every approval write needs an Idempotency-Key", func(t *testing.T) {
		id := newReq(tokMgrA, "outlet", outA, "S", 8)
		defer call("POST", "/inventory/adjustment-requests/"+id+"/cancel", tokMgrA, nextKey(), nil)
		for _, c := range []struct {
			path, tok string
			body      any
		}{
			{"/inventory/adjustment-requests", tokMgrA, reqBody("outlet", outA, "L", 5, "damaged", "")},
			{"/inventory/adjustment-requests/" + id + "/approve", tokAdmin, map[string]any{"pin": pin}},
			{"/inventory/adjustment-requests/" + id + "/reject", tokAdmin, map[string]any{"note": "no"}},
			{"/inventory/adjustment-requests/" + id + "/cancel", tokMgrA, map[string]any{}},
			{"/stock-counts/" + id + "/submit", tokMgrA, map[string]any{"reasonCode": "damaged"}},
			{"/stock-counts/" + id + "/approve", tokAdmin, map[string]any{"pin": pin}},
			{"/stock-counts/" + id + "/reject", tokAdmin, map[string]any{"note": "no"}},
		} {
			for _, blank := range []string{"", "   "} {
				code, _, body := call("POST", c.path, c.tok, blank, c.body)
				mustCode("blank key "+c.path, 400, code, body)
			}
		}
		if n := num(`SELECT count(*) FROM receive_pin_attempts WHERE doc_id=$1`, id); n != 0 {
			t.Fatalf("a keyless approve burned %d PIN attempts", n)
		}
	})

	t.Run("create: validation, scope and one pending request per SKU", func(t *testing.T) {
		code, _, body := call("POST", "/inventory/adjustment-requests", tokMgrA, nextKey(), reqBody("outlet", outA, "L", 5, "other", "  "))
		mustCode("other without text", 400, code, body)
		code, _, body = call("POST", "/inventory/adjustment-requests", tokMgrA, nextKey(), reqBody("outlet", outA, "L", 5, "bogus", ""))
		mustCode("bad reason", 400, code, body)
		code, _, body = call("POST", "/inventory/adjustment-requests", tokMgrA, nextKey(), reqBody("outlet", outA, "L", 10, "damaged", ""))
		mustCode("same qty", 400, code, body)
		code, _, body = call("POST", "/inventory/adjustment-requests", tokMgrB, nextKey(), reqBody("outlet", outA, "L", 5, "damaged", ""))
		mustCode("other outlet's location", 403, code, body)

		id := newReq(tokMgrA, "outlet", outA, "L", 5)
		if n := num(`SELECT qty_at_request FROM stock_adjustment_requests WHERE id=$1`, id); n != 10 {
			t.Fatalf("qty_at_request=%d", n)
		}
		if !strings.HasPrefix(str(`SELECT number FROM stock_adjustment_requests WHERE id=$1`, id), fmt.Sprintf("ADJ-%d-", time.Now().Year())) {
			t.Fatal("number is not an ADJ document number")
		}
		code, _, body = call("POST", "/inventory/adjustment-requests", tokMgrA2, nextKey(), reqBody("outlet", outA, "L", 6, "lost", ""))
		mustCode("second pending for the same SKU", 409, code, body)
		if strings.Contains(body, "approval_required") || strings.Contains(body, `"code"`) {
			t.Fatalf("a plain conflict must send {error} only: %s", body)
		}
		// the same key replays the first answer instead of conflicting
		// the same key and body replay the first answer byte for byte and create exactly one row
		rkey := nextKey()
		code, _, first := call("POST", "/inventory/adjustment-requests", tokMgrA, rkey, reqBody("outlet", outA, "S", 8, "lost", ""))
		mustCode("keyed create", 201, code, first)
		code, _, again := call("POST", "/inventory/adjustment-requests", tokMgrA, rkey, reqBody("outlet", outA, "S", 8, "lost", ""))
		if code != 201 || again != first {
			t.Fatalf("replay differs: %d %s vs %s", code, again, first)
		}
		if n := num(`SELECT count(*) FROM stock_adjustment_requests WHERE variant_size='S' AND status='pending_approval'`); n != 1 {
			t.Fatalf("replayed create made %d rows", n)
		}
		call("POST", "/inventory/adjustment-requests/"+dataID(first)+"/cancel", tokMgrA, nextKey(), nil)
		call("POST", "/inventory/adjustment-requests/"+id+"/cancel", tokMgrA, nextKey(), nil)
		if status("stock_adjustment_requests", id) != "cancelled" {
			t.Fatal("requester could not cancel")
		}
	})

	t.Run("approve: self refused, PIN lockout persists, replay, drift, delta", func(t *testing.T) {
		id := newReq(tokMgrA, "outlet", outA, "M", 7) // 10 -> 7, delta -3
		code, _, body := approve(tokMgrA, id, nextKey(), pin)
		mustCode("self approval", 409, code, body)
		if n := num(`SELECT count(*) FROM receive_pin_attempts WHERE doc_id=$1`, id); n != 0 {
			t.Fatalf("self approval checked a PIN (%d attempts)", n)
		}

		// a wrong PIN is refused AND its attempt and counters survive the refusal
		code, _, wrongBody := approve(tokAdmin, id, nextKey(), "0000")
		mustCode("wrong pin", 403, code, wrongBody)
		if n := num(`SELECT count(*) FROM receive_pin_attempts WHERE doc_id=$1 AND outcome='wrong_pin' AND doc_type='adjustment_request'`, id); n != 1 {
			t.Fatalf("wrong-PIN attempts persisted=%d want 1", n)
		}
		if n := num(`SELECT failures FROM receive_pin_lockouts WHERE subject_kind='approver' AND user_id=$1`, adminU); n != 1 {
			t.Fatalf("approver failures=%d want 1", n)
		}
		// unknown to the role list, wrong PIN and the other outlet's manager all answer the same 403
		code, _, clerkBody := approve(tokClerk, id, nextKey(), pin)
		mustCode("non-approver role", 403, code, clerkBody)
		if clerkBody != wrongBody {
			t.Fatalf("enumeration: %q vs %q", clerkBody, wrongBody)
		}
		code, _, body = approve(tokMgrB, id, nextKey(), pin)
		mustCode("other outlet's approver cannot see the document", 404, code, body)
		if status("stock_adjustment_requests", id) != "pending_approval" || stockA("M") != 10 {
			t.Fatal("a refused approval changed state")
		}

		// stock moves before the approval: the DELTA applies to the live figure
		exec(`UPDATE outlet_variant_stock SET stock=12 WHERE outlet_id=$1 AND variant_size='M'`, outA)
		before := num(`SELECT seq FROM outlet_stock_seq WHERE outlet_id=$1`, outA)
		key := nextKey()
		code, _, first := approve(tokAdmin, id, key, pin)
		mustCode("approve", 200, code, first)
		var res struct {
			Data struct {
				LiveQtyBefore int `json:"liveQtyBefore"`
				Delta         int `json:"delta"`
				Request       struct {
					Status  string `json:"status"`
					LiveQty int    `json:"liveQty"`
				} `json:"request"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(first), &res); err != nil || res.Data.LiveQtyBefore != 12 || res.Data.Delta != -3 || res.Data.Request.Status != "approved" {
			t.Fatalf("approve body %s (%v)", first, err)
		}
		if stockA("M") != 9 {
			t.Fatalf("stock=%d want 9 (12-3)", stockA("M"))
		}
		if after := num(`SELECT seq FROM outlet_stock_seq WHERE outlet_id=$1`, outA); after != before+1 {
			t.Fatalf("outlet stock seq %d -> %d (want one bump)", before, after)
		}
		if got := num(`SELECT count(*) FROM stock_movements WHERE ref_type='stock_adjustment' AND kind='adjust' AND qty=-3 AND qty_before=12 AND qty_after=9`); got != 1 {
			t.Fatalf("ledger rows=%d", got)
		}
		if str(`SELECT approved_by::text FROM stock_adjustment_requests WHERE id=$1`, id) != adminU {
			t.Fatal("approver not recorded")
		}
		if num(`SELECT count(*) FROM warehouse_stock_adjustments w JOIN stock_adjustment_requests r ON r.applied_adjustment_id=w.id
		        WHERE r.id=$1 AND w.request_id=r.id AND w.reason_code='damaged' AND w.created_by=r.requested_by`, id) != 1 {
			t.Fatal("adjustment row not linked to the request")
		}
		if ev := events("adjustment_request", id); ev != "submitted,approved,applied" {
			t.Fatalf("events=%s", ev)
		}

		// replay: same key, same answer, nothing applied twice, no new events
		code, _, again := approve(tokAdmin, id, key, pin)
		mustCode("replay", 200, code, again)
		if again != first || stockA("M") != 9 || events("adjustment_request", id) != "submitted,approved,applied" {
			t.Fatalf("replay differs or re-applied: %s", again)
		}
		// pin is not in the fingerprint: the approver re-sets their PIN and the same key still
		// replays (the new PIN is verified first, the stored answer is returned)
		newHash, _ := rules.HashPassword(pin2)
		exec(`UPDATE users SET receive_pin_hash=$2, receive_pin_set_at=now() WHERE id=$1`, adminU, newHash)
		code, _, again = approve(tokAdmin, id, key, pin2)
		mustCode("replay with another PIN", 200, code, again)
		if again != first {
			t.Fatalf("replay with another PIN changed the answer: %s", again)
		}
		code, _, body = approve(tokAdmin, id, key, pin) // the old PIN is now wrong, replay or not
		mustCode("replay with a stale PIN", 403, code, body)
		exec(`UPDATE users SET receive_pin_hash=$2, receive_pin_set_at=now() WHERE id=$1`, adminU, hash)
		clearLocks()
		// a decided request cannot be approved again under a new key
		code, _, body = approve(tokAdmin, id, nextKey(), pin)
		mustCode("approve a decided request", 409, code, body)
		ledgerOK()
	})

	t.Run("approve would drive stock negative: refused, request stays pending", func(t *testing.T) {
		id := newReq(tokMgrA, "outlet", outA, "L", 0) // 10 -> 0, delta -10
		exec(`UPDATE outlet_variant_stock SET stock=4 WHERE outlet_id=$1 AND variant_size='L'`, outA)
		code, _, body := approve(tokAdmin, id, nextKey(), pin)
		mustCode("negative", 409, code, body)
		if status("stock_adjustment_requests", id) != "pending_approval" || stockA("L") != 4 {
			t.Fatal("state changed on a refused apply")
		}
		code, _, body = call("POST", "/inventory/adjustment-requests/"+id+"/reject", tokMgrA, nextKey(), map[string]any{"note": "  "})
		mustCode("reject needs a note", 400, code, body)
		code, _, body = call("POST", "/inventory/adjustment-requests/"+id+"/reject", tokMgrA2, nextKey(), map[string]any{"note": "stok berubah"})
		mustCode("reject", 200, code, body)
		if status("stock_adjustment_requests", id) != "rejected" || events("adjustment_request", id) != "submitted,rejected" {
			t.Fatal("reject not recorded")
		}
		exec(`UPDATE outlet_variant_stock SET stock=10 WHERE outlet_id=$1 AND variant_size='L'`, outA)
		// the SKU is free again
		cancel := newReq(tokMgrA, "outlet", outA, "L", 9)
		code, _, body = call("POST", "/inventory/adjustment-requests/"+cancel+"/cancel", tokMgrA2, nextKey(), nil)
		mustCode("cancel by a non-requester", 403, code, body)
		call("POST", "/inventory/adjustment-requests/"+cancel+"/cancel", tokMgrA, nextKey(), nil)
	})

	t.Run("lockout: wrong PINs trip it and a correct PIN is then refused", func(t *testing.T) {
		id := newReq(tokMgrA, "outlet", outA, "S", 6)
		for i := 0; i < 5; i++ {
			code, _, body := approve(tokAdmin2, id, nextKey(), "0000")
			mustCode("wrong pin", 403, code, body)
		}
		code, hdr, body := approve(tokAdmin2, id, nextKey(), pin)
		mustCode("correct pin while locked", 429, code, body)
		if hdr.Get("Retry-After") == "" {
			t.Fatal("429 without Retry-After")
		}
		if num(`SELECT count(*) FROM receive_pin_attempts WHERE doc_id=$1 AND outcome='locked'`, id) != 1 ||
			num(`SELECT count(*) FROM receive_pin_attempts WHERE doc_id=$1 AND outcome='wrong_pin'`, id) != 5 {
			t.Fatal("attempts not recorded")
		}
		if status("stock_adjustment_requests", id) != "pending_approval" {
			t.Fatal("locked approver applied it")
		}
		clearLocks()
		code, _, body = approve(tokAdmin2, id, nextKey(), pin)
		mustCode("approve after unlock", 200, code, body)
		if stockA("S") != 6 {
			t.Fatalf("S=%d", stockA("S"))
		}
		clearLocks()
	})

	t.Run("warehouse request is approvable by a non-admin approver-role user", func(t *testing.T) {
		id := newReq(tokAdmin, "warehouse", whW, "M", 4) // 10 -> 4
		code, _, body := approve(tokAdmin, id, nextKey(), pin)
		mustCode("requester admin cannot self-approve", 409, code, body)
		code, _, body = approve(tokClerk, id, nextKey(), pin)
		mustCode("non-approver role", 403, code, body)
		code, _, body = approve(tokMgrB, id, nextKey(), pin)
		mustCode("approver of another outlet covers a warehouse document", 200, code, body)
		if stockW("M") != 4 {
			t.Fatalf("W stock=%d", stockW("M"))
		}
		if num(`SELECT count(*) FROM stock_movements WHERE location_type='warehouse' AND kind='adjust' AND qty=-6`) != 1 {
			t.Fatal("warehouse ledger row missing")
		}
		ledgerOK()
	})

	// counts -------------------------------------------------------------------
	newCount := func(name string, qty map[string]int) string {
		t.Helper()
		var items []map[string]any
		for _, sz := range []string{"M", "L", "S"} {
			items = append(items, map[string]any{"productId": product, "productName": "AP product", "variantSize": sz, "sku": "AP-" + sz})
		}
		code, _, body := call("POST", "/stock-counts", tokMgrA, nextKey(), map[string]any{"name": name, "items": items})
		mustCode("create count", 201, code, body)
		id := dataID(body)
		code, _, body = call("PUT", "/stock-counts/"+id, tokMgrA, "", map[string]any{"status": "in_progress"})
		mustCode("start count", 200, code, body)
		var lines []map[string]any
		for sz, q := range qty {
			lines = append(lines, map[string]any{"productId": product, "variantSize": sz, "actualQty": q})
		}
		code, _, body = call("PUT", "/stock-counts/"+id, tokMgrA, "", map[string]any{"items": lines})
		mustCode("count lines", 200, code, body)
		return id
	}
	exec(`UPDATE outlet_variant_stock SET stock=10 WHERE outlet_id=$1`, outA)

	t.Run("count: complete under the flag needs approval only when there is a difference", func(t *testing.T) {
		zero := newCount("zero", map[string]int{"M": stockA("M"), "L": 10, "S": 10})
		code, _, body := call("POST", "/stock-counts/"+zero+"/complete", tokMgrA, nextKey(), nil)
		mustCode("all-zero count completes directly", 200, code, body)
		if status("stock_counts", zero) != "completed" {
			t.Fatal("not completed")
		}
		diff := newCount("diff", map[string]int{"M": stockA("M") + 4})
		code, _, body = call("POST", "/stock-counts/"+diff+"/complete", tokMgrA, nextKey(), nil)
		mustCode("count with a difference", 409, code, body)
		if !strings.Contains(body, `"code":"approval_required"`) {
			t.Fatalf("body %s", body)
		}
		if status("stock_counts", diff) != "in_progress" {
			t.Fatal("refused complete changed the count")
		}
		code, _, body = call("POST", "/stock-counts/"+diff+"/submit", tokMgrA, nextKey(), map[string]any{"reasonCode": "other", "reasonText": ""})
		mustCode("submit: other needs text", 400, code, body)
		code, _, body = call("POST", "/stock-counts/"+diff+"/submit", tokMgrA, nextKey(), map[string]any{
			"reasonCode": "count_variance", "reasonText": "opname bulanan",
			"lines": []map[string]any{{"productId": product, "variantSize": "M", "reasonCode": "found", "reasonText": "di gudang belakang"}}})
		mustCode("submit", 200, code, body)
		if status("stock_counts", diff) != "pending_approval" || stockA("M") != 10 {
			t.Fatal("submit must not touch stock")
		}
		if str(`SELECT reason_code FROM stock_count_items WHERE stock_count_id=$1 AND variant_size='M'`, diff) != "found" {
			t.Fatal("line reason not stored")
		}

		// a pending count blocks a second open count at the location
		other := func() int {
			code, _, body := call("POST", "/stock-counts", tokMgrA, nextKey(), map[string]any{"name": "second", "items": []map[string]any{
				{"productId": product, "productName": "AP product", "variantSize": "M", "sku": "AP-M"}}})
			mustCode("create second", 201, code, body)
			code, _, _ = call("PUT", "/stock-counts/"+dataID(body), tokMgrA, "", map[string]any{"status": "in_progress"})
			return code
		}()
		if other != 409 {
			t.Fatalf("second open count started: %d", other)
		}

		// four-eyes and PIN
		code, _, body = call("POST", "/stock-counts/"+diff+"/approve", tokMgrA, nextKey(), map[string]any{"pin": pin})
		mustCode("submitter cannot approve", 409, code, body)
		code, _, body = call("POST", "/stock-counts/"+diff+"/approve", tokAdmin, nextKey(), map[string]any{"pin": "1111"})
		mustCode("wrong pin", 403, code, body)
		if num(`SELECT count(*) FROM receive_pin_attempts WHERE doc_id=$1 AND doc_type='stock_count' AND outcome='wrong_pin'`, diff) != 1 {
			t.Fatal("wrong-PIN attempt did not persist")
		}
		key := nextKey()
		code, _, first := call("POST", "/stock-counts/"+diff+"/approve", tokAdmin, key, map[string]any{"pin": pin, "note": "ok"})
		mustCode("approve", 200, code, first)
		if status("stock_counts", diff) != "completed" || stockA("M") != 14 {
			t.Fatalf("count not applied: %s M=%d", status("stock_counts", diff), stockA("M"))
		}
		if str(`SELECT approved_by::text FROM stock_counts WHERE id=$1`, diff) != adminU {
			t.Fatal("approver missing")
		}
		if num(`SELECT count(*) FROM stock_movements WHERE kind='count' AND ref_id=$1 AND qty=4`, diff) != 1 {
			t.Fatal("count ledger row missing")
		}
		if ev := events("stock_count", diff); ev != "submitted,approved,applied" {
			t.Fatalf("events=%s", ev)
		}
		code, _, again := call("POST", "/stock-counts/"+diff+"/approve", tokAdmin, key, map[string]any{"pin": pin, "note": "ok"})
		if code != 200 || again != first || stockA("M") != 14 {
			t.Fatalf("replay %d %s", code, again)
		}
		clearLocks()
		ledgerOK()
	})

	t.Run("count: reject returns it to in_progress; then it can be resubmitted", func(t *testing.T) {
		id := newCount("rej", map[string]int{"L": 13})
		code, _, body := call("POST", "/stock-counts/"+id+"/submit", tokMgrA, nextKey(), map[string]any{"reasonCode": "count_variance"})
		mustCode("submit", 200, code, body)
		code, _, body = call("POST", "/stock-counts/"+id+"/reject", tokClerk, nextKey(), map[string]any{"note": "hitung ulang"})
		mustCode("non-approver cannot reject", 403, code, body)
		code, _, body = call("POST", "/stock-counts/"+id+"/reject", tokAdmin, nextKey(), map[string]any{"note": "hitung ulang"})
		mustCode("reject", 200, code, body)
		if status("stock_counts", id) != "in_progress" || str(`SELECT rejected_note FROM stock_counts WHERE id=$1`, id) != "hitung ulang" {
			t.Fatal("reject not recorded")
		}
		code, _, body = call("POST", "/stock-counts/"+id+"/reject", tokAdmin, nextKey(), map[string]any{"note": "again"})
		mustCode("reject a count that is not pending", 409, code, body)
		code, _, body = call("POST", "/stock-counts/"+id+"/submit", tokMgrA, nextKey(), map[string]any{"reasonCode": "count_variance"})
		mustCode("resubmit", 200, code, body)
		code, _, body = call("POST", "/stock-counts/"+id+"/approve", tokMgrA2, nextKey(), map[string]any{"pin": pin})
		mustCode("a second approver-role user may approve", 200, code, body)
		if stockA("L") != 13 {
			t.Fatalf("L=%d", stockA("L"))
		}
		clearLocks()
	})

	t.Run("queue: filtered by permission, paged, with the pending count", func(t *testing.T) {
		a1 := newReq(tokMgrA, "outlet", outA, "M", 20)
		cnt := newCount("queue", map[string]int{"S": 30})
		code, _, body := call("POST", "/stock-counts/"+cnt+"/submit", tokMgrA, nextKey(), map[string]any{"reasonCode": "count_variance"})
		mustCode("submit", 200, code, body)
		type queue struct {
			Data []struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"data"`
			PendingCount int `json:"pendingCount"`
		}
		get := func(tok, q string) (int, queue) {
			code, _, body := call("GET", "/inventory/approvals"+q, tok, "", nil)
			var o queue
			if code == 200 {
				if err := json.Unmarshal([]byte(body), &o); err != nil {
					t.Fatalf("queue body %s", body)
				}
			}
			return code, o
		}
		kinds := func(q queue) string {
			var s []string
			for _, d := range q.Data {
				s = append(s, d.Type)
			}
			return strings.Join(s, ",")
		}
		code, q := get(tokAdmin, "")
		if code != 200 || q.PendingCount != 2 || kinds(q) != "adjustment,count" {
			t.Fatalf("admin queue %d %+v", code, q)
		}
		code, q = get(tokCountOnly, "")
		if code != 200 || q.PendingCount != 1 || kinds(q) != "count" {
			t.Fatalf("count-only user must see no adjustment: %d %+v", code, q)
		}
		code, q = get(tokInvOnly, "")
		if code != 200 || q.PendingCount != 1 || kinds(q) != "adjustment" || q.Data[0].ID != a1 {
			t.Fatalf("inventory-only queue %d %+v", code, q)
		}
		if code, _ = get(tokNone, ""); code != 403 {
			t.Fatalf("no permission: %d", code)
		}
		code, q = get(tokAdmin, "?limit=1&page=2")
		if code != 200 || len(q.Data) != 1 || q.PendingCount != 2 || q.Data[0].ID != cnt {
			t.Fatalf("page 2 %d %+v", code, q)
		}
		if code, _ = get(tokAdmin, "?status=done"); code != 400 {
			t.Fatalf("bad status: %d", code)
		}
		// another outlet's manager sees neither of outlet A's documents
		code, q = get(tokMgrB, "")
		if code != 200 || q.PendingCount != 0 {
			t.Fatalf("outlet scope leak: %d %+v", code, q)
		}
		call("POST", "/inventory/adjustment-requests/"+a1+"/cancel", tokMgrA, nextKey(), nil)
		call("POST", "/stock-counts/"+cnt+"/reject", tokAdmin, nextKey(), map[string]any{"note": "bersih-bersih"})
		code, _, body = call("PUT", "/stock-counts/"+cnt, tokMgrA, "", map[string]any{"status": "cancelled"})
		mustCode("cancel count", 200, code, body)
	})

	t.Run("setting: absent field keeps the flag, explicit false turns it off", func(t *testing.T) {
		on, err := rd.AppSettings(ctx)
		if err != nil || on.InventoryApprovalRequired == nil || !*on.InventoryApprovalRequired {
			t.Fatalf("read flag: %+v %v", on.InventoryApprovalRequired, err)
		}
		raw := func(extra string) []byte {
			return []byte(`{"taxEnabled":false,"taxRate":0,"roundingEnabled":false,"roundingType":"none","autoOpenShift":false,"allowNegativeStock":true,"paymentMethods":[],"receipt":{}` + extra + `}`)
		}
		if err := wr.UpdateAppSettings(ctx, raw("")); err != nil {
			t.Fatal(err)
		}
		if num(`SELECT inventory_approval_required::int FROM app_settings WHERE id=1`) != 1 {
			t.Fatal("an update without the field switched approval off")
		}
		if err := wr.UpdateAppSettings(ctx, raw(`,"inventoryApprovalRequired":false`)); err != nil {
			t.Fatal(err)
		}
		if num(`SELECT inventory_approval_required::int FROM app_settings WHERE id=1`) != 0 {
			t.Fatal("explicit false ignored")
		}
		code, _, body := call("POST", "/inventory/adjust?kind=outlet&id="+outA, tokAdmin, nextKey(),
			map[string]any{"productId": product, "variantSize": "S", "newQty": 6, "reason": "again direct"})
		mustCode("direct adjust after the flag is off", 200, code, body)
		ledgerOK()
	})
}

var _ = (*pgxpool.Pool)(nil)
