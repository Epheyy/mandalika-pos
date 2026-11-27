package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// TestCustomerRatingPostgres is gate CR (isolated cluster, MANDALIKA_CR_TEST_DSN, port 26488): the
// WhatsApp receipt link, the public rating page and the Performa Sales reports. Money in the report
// must equal ReportSummary for the same filter (incl. a refund on another day).
func TestCustomerRatingPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "CR", 26488)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
	}
	count := func(sql string, args ...any) (n int) {
		t.Helper()
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("%v: %s", err, sql)
		}
		return
	}
	const (
		outX  = "00000000-0000-4000-8f88-0000000000a1"
		outY  = "00000000-0000-4000-8f88-0000000000a2"
		kX    = "00000000-0000-4000-8f88-0000000000b1"
		kY    = "00000000-0000-4000-8f88-0000000000b2"
		mgrX  = "00000000-0000-4000-8f88-0000000000b3"
		admin = "00000000-0000-4000-8f88-0000000000b4"
		sRina = "00000000-0000-4000-8f88-0000000000c1"
		sDewi = "00000000-0000-4000-8f88-0000000000c2"
		cust  = "00000000-0000-4000-8f88-0000000000d1"
		prod  = "00000000-0000-4000-8f88-0000000000f1"
	)
	exec(`INSERT INTO outlets(id,name,erp_slug,erp_code) VALUES($1,'CR outlet X','cr-x','CRX'),($2,'CR outlet Y','cr-y','CRY')`, outX, outY)
	for _, u := range []struct{ id, role, out, email string }{
		{kX, "cashier", outX, "crx"}, {kY, "cashier", outY, "cry"}, {mgrX, "manager", outX, "crm"},
	} {
		exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id) VALUES($1,$2,'x','CR user',$3,$4)`,
			u.id, u.email+"@example.invalid", u.role, u.out)
	}
	exec(`INSERT INTO users(id,email,password_hash,display_name,role) VALUES($1,'cradmin@example.invalid','x','CR admin','admin')`, admin)
	exec(`INSERT INTO customers(id,name,phone) VALUES($1,'Budi Santoso','0812-3456-7890')`, cust)

	type ord struct {
		id, num, outlet, salesman, salesName, status, created, customer string
		total                                                           int
	}
	orders := []ord{
		{"00000000-0000-4000-8f88-0000000001a1", "CR-1", outX, sRina, "Rina", "completed", "2026-11-10T03:00:00Z", cust, 100000},
		{"00000000-0000-4000-8f88-0000000001a2", "CR-2", outX, sRina, "Rina", "completed", "2026-11-11T03:00:00Z", "", 200000},
		{"00000000-0000-4000-8f88-0000000001a3", "CR-3", outX, sDewi, "Dewi", "partially_refunded", "2026-11-10T04:00:00Z", "", 150000},
		{"00000000-0000-4000-8f88-0000000001a4", "CR-4", outX, "", "", "completed", "2026-11-11T04:00:00Z", "", 80000},
		{"00000000-0000-4000-8f88-0000000001a5", "CR-5", outY, sRina, "Rina", "completed", "2026-11-11T05:00:00Z", "", 300000},
		{"00000000-0000-4000-8f88-0000000001a6", "CR-6", outX, sRina, "Rina", "cancelled", "2026-11-11T06:00:00Z", "", 999000},
	}
	for _, o := range orders {
		exec(`INSERT INTO orders(id,order_uuid,order_number,idempotency_key,outlet_id,cashier_id,cashier_name,salesman_id,salesman_name,
		        customer_id,customer_name,subtotal,discount_amount,total,payment_method,status,created_at)
		      VALUES($1,$1,$2,$2,$3,$4,'CR cashier',NULLIF($5,'')::uuid,NULLIF($6,''),NULLIF($7,'')::uuid,
		        CASE WHEN $7 <> '' THEN 'Budi Santoso' END,$8::numeric+10000,10000,$8::numeric,'cash',$9,$10)`,
			o.id, o.num, o.outlet, kX, o.salesman, o.salesName, o.customer, o.total, o.status, o.created)
		exec(`INSERT INTO order_items(order_id,product_id,product_name,variant_size,price,quantity,subtotal) VALUES($1,$2,'Oud <Royal>','30 ml',$3::numeric,1,$3::numeric)`,
			o.id, prod, o.total+10000)
	}
	// A partial refund of the Dewi sale on a DIFFERENT business day than the sale.
	exec(`INSERT INTO order_refunds(order_id,outlet_id,seq,scope,amount,computed_amount,payment_method,reason,ledger_document_key,refunded_at,refund_business_date)
	      VALUES($1,$2,1,'partial',50000,50000,'cash','CR','cr-rf-1','2026-11-12T03:00:00Z','2026-11-12')`, orders[2].id, outX)

	rd, wr, svc := read.New(pool), write.New(pool), service.NewOrderService(pool)
	cc, err := cache.Connect(context.Background(), "", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("CR-INTEGRATION-SYNTHETIC-KEY-0123456789")
	h := New(rd, cc, auth.NewStore(pool), wr, svc, syncpkg.New(pool, rd, svc, wr), nil)
	h.SetReceiptLinkBase("https://pos.example.test")
	authWrap := mw.RequireAuth(&config.Config{AccessSecret: secret})
	router := chi.NewRouter()
	router.Get("/r/{token}", h.ReceiptPage)
	router.Post("/r/{token}", h.SubmitReceiptRating)
	router.With(authWrap).Post("/receipt-links", h.CreateReceiptLink)
	router.With(authWrap, mw.RequirePermission("manage_settings")).Get("/settings/wa-receipt-template", h.GetWaReceiptTemplate)
	router.With(authWrap, mw.RequirePermission("manage_settings")).Put("/settings/wa-receipt-template", h.UpdateWaReceiptTemplate)
	router.With(authWrap, mw.RequirePermission("view_reports")).Get("/reports/sales-performance", h.SalesPerformance)
	router.With(authWrap, mw.RequirePermission("view_reports")).Get("/reports/sales-ratings", h.SalesRatings)

	tok := func(user, role, outlet string, perms ...string) string {
		s, err := auth.IssueAccess(secret, time.Hour, user, role, outlet, perms)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	kasirX, kasirY := tok(kX, "cashier", outX, "create_order"), tok(kY, "cashier", outY, "create_order")
	mgr := tok(mgrX, "manager", outX, "view_reports")
	adm := tok(admin, "admin", "")

	do := func(method, path, token, body, ip string, hdr map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if method == http.MethodPost && !strings.HasPrefix(body, "{") {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		if ip != "" {
			r.RemoteAddr = ip + ":5000"
		}
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	create := func(token, body string) (*httptest.ResponseRecorder, api.ReceiptLink) {
		t.Helper()
		w := do(http.MethodPost, "/receipt-links", token, body, "192.0.2.10", nil)
		var resp api.ReceiptLinkResponse
		if w.Code == http.StatusCreated {
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatal(err)
			}
		}
		return w, resp.Data
	}
	tokenOf := func(l api.ReceiptLink) string { return l.Url[strings.LastIndex(l.Url, "/")+1:] }

	// 1. Creation guards.
	if w, _ := create(kasirX, `{"orderUuid":"00000000-0000-4000-8f88-0000000009ff"}`); w.Code != 409 || !strings.Contains(w.Body.String(), "belum tersinkron") {
		t.Fatalf("unsynced uuid = %d %s", w.Code, w.Body)
	}
	if w, _ := create(kasirY, `{"orderUuid":"`+orders[0].id+`"}`); w.Code != 409 {
		t.Fatalf("other outlet by uuid = %d", w.Code)
	}
	if w, _ := create(kasirY, `{"orderId":"`+orders[0].id+`"}`); w.Code != 404 {
		t.Fatalf("other outlet by id = %d", w.Code)
	}
	if w, _ := create(kasirX, `{"orderUuid":"`+orders[5].id+`","phone":"0812 3456 7890"}`); w.Code != 409 {
		t.Fatalf("cancelled order = %d", w.Code)
	}
	if w, _ := create(kasirX, `{"orderUuid":"`+orders[0].id+`","orderId":"`+orders[0].id+`"}`); w.Code != 400 {
		t.Fatalf("both ids = %d", w.Code)
	}
	if w, _ := create(kasirX, `{}`); w.Code != 400 {
		t.Fatalf("no id = %d", w.Code)
	}
	if w, _ := create(kasirX, `{"orderUuid":"`+orders[0].id+`","phone":"123"}`); w.Code != 400 {
		t.Fatalf("bad typed phone = %d", w.Code)
	}
	if w, _ := create(kasirX, `{"orderUuid":"`+orders[3].id+`"}`); w.Code != 400 || !strings.Contains(w.Body.String(), "wajib diisi") {
		t.Fatalf("no phone at all = %d %s", w.Code, w.Body)
	}
	if w := do(http.MethodPost, "/receipt-links", "", `{}`, "", nil); w.Code != 401 {
		t.Fatalf("no auth = %d", w.Code)
	}
	if n := count(`SELECT count(*) FROM receipt_links`); n != 0 {
		t.Fatalf("rejected requests left %d links", n)
	}

	// 2. A link for the Rina sale, phone taken from the customer.
	w, link1 := create(kasirX, `{"orderUuid":"`+orders[0].id+`","deviceId":"tab-1"}`)
	if w.Code != 201 {
		t.Fatalf("create = %d %s", w.Code, w.Body)
	}
	tok1 := tokenOf(link1)
	if !strings.HasPrefix(link1.Url, "https://pos.example.test/r/") || len(tok1) != 22 || link1.PhoneMasked != "****7890" {
		t.Fatalf("link = %+v", link1)
	}
	if !strings.Contains(link1.Message, "Halo Budi,") || !strings.Contains(link1.Message, "Rina") || !strings.Contains(link1.Message, "Rp 100.000") ||
		!strings.Contains(link1.Message, link1.Url) || !strings.HasPrefix(link1.WaUrl, "https://wa.me/6281234567890?text=") {
		t.Fatalf("message = %q wa = %q", link1.Message, link1.WaUrl)
	}
	sum := sha256.Sum256([]byte(tok1))
	if n := count(`SELECT count(*) FROM receipt_links WHERE token_hash = $1 AND recipient_masked = '****7890' AND recipient_source = 'customer'
	      AND device_id = 'tab-1' AND expires_at > now() + interval '6 days'`, sum[:]); n != 1 {
		t.Fatalf("stored link rows = %d", n)
	}
	if n := count(`SELECT count(*) FROM receipt_links WHERE recipient_masked LIKE '%1234%' OR recipient_masked LIKE '%081%' OR recipient_masked LIKE '%62%'`); n != 0 {
		t.Fatal("a full phone number reached the link row")
	}
	// A re-send makes another link; the first one keeps working.
	if w, l2 := create(kasirX, `{"orderUuid":"`+orders[0].id+`","phone":"+62 812-3456-7890"}`); w.Code != 201 || tokenOf(l2) == tok1 {
		t.Fatalf("re-send = %d", w.Code)
	}
	if n := count(`SELECT count(*) FROM receipt_links WHERE order_id = $1`, orders[0].id); n != 2 {
		t.Fatalf("links for the order = %d, want 2", n)
	}

	// 3. The public page: lines and total, no phone, no full name, escaped, no script.
	w = do(http.MethodGet, "/r/"+tok1, "", "", "", nil)
	page := w.Body.String()
	if w.Code != 200 {
		t.Fatalf("page = %d", w.Code)
	}
	for _, want := range []string{"CR outlet X", "Oud &lt;Royal&gt;", "30 ml", "Rp 100.000", "Rp 110.000", "-Rp 10.000", "CR-1", "Halo, Budi", "Bagaimana pelayanan Rina?", "5 bintang"} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	for _, bad := range []string{"Santoso", "7890", "081", "<script", "Oud <Royal>"} {
		if strings.Contains(page, bad) {
			t.Errorf("page leaks %q", bad)
		}
	}
	if w.Header().Get("Content-Security-Policy") == "" || w.Header().Get("Cache-Control") != "no-store" {
		t.Error("public headers missing")
	}

	// 4. The rating: 303, one row with the order's business date; same IP and fast, so both flagged.
	form := url.Values{"stars": {"5"}, "tags": {"ramah", "bogus", "ramah", "cepat"}, "comment": {"  Bagus <b>sekali</b>\x00\x07 "}}.Encode()
	w = do(http.MethodPost, "/r/"+tok1, "", form, "192.0.2.10", nil)
	if w.Code != 303 || w.Header().Get("Location") != tok1 {
		t.Fatalf("rating = %d loc %q %s", w.Code, w.Header().Get("Location"), w.Body)
	}
	var stars int
	var tags []string
	var comment, bdate string
	var fast, sameNet bool
	if err := pool.QueryRow(ctx, `SELECT r.stars, r.tags, r.comment, r.flag_fast, r.flag_same_network, r.business_date::text
	      FROM order_ratings r WHERE r.order_id = $1`, orders[0].id).Scan(&stars, &tags, &comment, &fast, &sameNet, &bdate); err != nil {
		t.Fatal(err)
	}
	var orderDate string
	if err := pool.QueryRow(ctx, `SELECT business_date::text FROM orders WHERE id = $1`, orders[0].id).Scan(&orderDate); err != nil {
		t.Fatal(err)
	}
	if stars != 5 || strings.Join(tags, ",") != "ramah,cepat" || comment != "Bagus <b>sekali</b>" || !fast || !sameNet || bdate != orderDate {
		t.Fatalf("rating row = %d %v %q fast=%v net=%v date=%s/%s", stars, tags, comment, fast, sameNet, bdate, orderDate)
	}
	// The second submit (even through the other link) changes nothing and the page says thanks.
	if w = do(http.MethodPost, "/r/"+tok1, "", url.Values{"stars": {"1"}}.Encode(), "192.0.2.10", nil); w.Code != 303 {
		t.Fatalf("second rating = %d", w.Code)
	}
	if n := count(`SELECT count(*) FROM order_ratings WHERE order_id = $1 AND stars = 5`, orders[0].id); n != 1 {
		t.Fatal("first rating must win")
	}
	if n := count(`SELECT count(*) FROM order_ratings`); n != 1 {
		t.Fatalf("ratings = %d", n)
	}
	w = do(http.MethodGet, "/r/"+tok1, "", "", "", nil)
	page = w.Body.String()
	if !strings.Contains(page, "Terima kasih, penilaian sudah diterima") || strings.Contains(page, "Kirim penilaian") ||
		!strings.Contains(page, "5 dari 5 bintang") || !strings.Contains(page, "Bagus &lt;b&gt;sekali&lt;/b&gt;") || !strings.Contains(page, "Rp 100.000") {
		t.Fatalf("rated page wrong: %s", page)
	}

	// 5. Validation error re-renders (400) and keeps the inputs; nothing is stored.
	_, link2 := create(kasirX, `{"orderUuid":"`+orders[1].id+`","phone":"0812 9999 0001"}`)
	tok2 := tokenOf(link2)
	w = do(http.MethodPost, "/r/"+tok2, "", url.Values{"tags": {"membantu"}, "comment": {"Mohon jangan hilang"}}.Encode(), "192.0.2.10", nil)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "Pilih jumlah bintang") || !strings.Contains(w.Body.String(), "Mohon jangan hilang") ||
		!strings.Contains(w.Body.String(), `value="membantu" checked`) {
		t.Fatalf("invalid rating = %d %s", w.Code, w.Body)
	}
	if n := count(`SELECT count(*) FROM order_ratings WHERE order_id = $1`, orders[1].id); n != 0 {
		t.Fatal("an invalid rating was stored")
	}

	// 6. Unknown, bad-shape and expired links share one 404 body.
	unknown := do(http.MethodGet, "/r/AAAAAAAAAAAAAAAAAAAAAA", "", "", "", nil)
	exec(`UPDATE receipt_links SET expires_at = now() - interval '1 second' WHERE order_id = $1`, orders[1].id)
	expired := do(http.MethodGet, "/r/"+tok2, "", "", "", nil)
	shape := do(http.MethodGet, "/r/short", "", "", "", nil)
	expiredPost := do(http.MethodPost, "/r/"+tok2, "", url.Values{"stars": {"4"}}.Encode(), "", nil)
	for name, g := range map[string]*httptest.ResponseRecorder{"unknown": unknown, "expired": expired, "shape": shape, "expired POST": expiredPost} {
		if g.Code != 404 || g.Body.String() != unknown.Body.String() || !strings.Contains(g.Body.String(), "Tautan tidak berlaku atau sudah kedaluwarsa") {
			t.Errorf("%s gone page differs: %d", name, g.Code)
		}
	}

	// 7. No salesperson, and neither flag when the link is old and the network differs.
	_, link4 := create(kasirX, `{"orderUuid":"`+orders[3].id+`","phone":"0812 8888 7777"}`)
	tok4 := tokenOf(link4)
	if !strings.Contains(link4.Message, "tim kami") {
		t.Fatalf("no-salesperson message = %q", link4.Message)
	}
	exec(`UPDATE receipt_links SET created_at = now() - interval '5 minutes' WHERE order_id = $1`, orders[3].id)
	if w = do(http.MethodGet, "/r/"+tok4, "", "", "", nil); !strings.Contains(w.Body.String(), "Bagaimana pelayanan kami?") {
		t.Fatal("no-salesperson prompt missing")
	}
	if w = do(http.MethodPost, "/r/"+tok4, "", url.Values{"stars": {"3"}}.Encode(), "198.51.100.7", nil); w.Code != 303 {
		t.Fatalf("rating 4 = %d", w.Code)
	}
	if n := count(`SELECT count(*) FROM order_ratings WHERE order_id = $1 AND salesman_id IS NULL AND NOT flag_fast AND NOT flag_same_network AND comment IS NULL`, orders[3].id); n != 1 {
		t.Fatal("expected an unflagged rating without salesperson")
	}

	// 8. Revenue and transactions equal ReportSummary for the same filter, window by window.
	parity := func(label, token string, f read.OrderFilter, q string) api.SalesPerformanceReport {
		t.Helper()
		w := do(http.MethodGet, "/reports/sales-performance?"+q, token, "", "", nil)
		if w.Code != 200 {
			t.Fatalf("%s: report %d %s", label, w.Code, w.Body)
		}
		var rep api.SalesPerformanceReport
		if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
			t.Fatal(err)
		}
		sm, err := rd.ReportSummary(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		var rows float64
		var rowTx int
		for _, r := range rep.Data {
			rows += r.Revenue
			rowTx += r.Transactions
		}
		if math.Abs(rep.Totals.Revenue-sm.NetSales) > 0.005 || math.Abs(rows-sm.NetSales) > 0.005 || rep.Totals.Transactions != sm.TotalOrders || rowTx != sm.TotalOrders {
			t.Fatalf("%s: revenue rows %.2f totals %.2f vs summary net %.2f; tx rows %d totals %d vs summary %d",
				label, rows, rep.Totals.Revenue, sm.NetSales, rowTx, rep.Totals.Transactions, sm.TotalOrders)
		}
		return rep
	}
	all := read.Scope{CrossAll: true}
	full := parity("all", adm, read.OrderFilter{Scope: all, DateFrom: "2026-11-10", DateTo: "2026-11-12"}, "dateFrom=2026-11-10&dateTo=2026-11-12")
	if full.Totals.Revenue != 780000 || full.Totals.Transactions != 5 {
		t.Fatalf("totals = %+v", full.Totals)
	}
	parity("sale days only", adm, read.OrderFilter{Scope: all, DateFrom: "2026-11-10", DateTo: "2026-11-11"}, "dateFrom=2026-11-10&dateTo=2026-11-11")
	refundDay := parity("refund day only", adm, read.OrderFilter{Scope: all, DateFrom: "2026-11-12", DateTo: "2026-11-12"}, "dateFrom=2026-11-12&dateTo=2026-11-12")
	if refundDay.Totals.Revenue != -50000 || refundDay.Totals.Transactions != 0 || len(refundDay.Data) != 1 || refundDay.Data[0].SalesmanName != "Dewi" {
		t.Fatalf("refund-day report = %+v", refundDay)
	}
	mine := parity("manager own outlet", mgr, read.OrderFilter{Scope: read.Scope{OutletID: outX}, DateFrom: "2026-11-10", DateTo: "2026-11-12"}, "dateFrom=2026-11-10&dateTo=2026-11-12")
	if mine.Totals.Revenue != 480000 || mine.Totals.Transactions != 4 {
		t.Fatalf("manager must see outlet X only: %+v", mine.Totals)
	}
	if w := do(http.MethodGet, "/reports/sales-performance?dateFrom=2026-11-10&dateTo=2026-11-12&outletId="+outY, mgr, "", "", nil); w.Code == 200 {
		t.Fatalf("a manager must not widen the scope with outletId: %s", w.Body)
	}
	if w := do(http.MethodGet, "/reports/sales-performance?dateFrom=2026-11-10", adm, "", "", nil); w.Code != 400 {
		t.Fatalf("missing dateTo = %d", w.Code)
	}
	if w := do(http.MethodGet, "/reports/sales-performance?dateFrom=2026-11-10&dateTo=2026-11-12", kasirX, "", "", nil); w.Code != 403 {
		t.Fatalf("cashier without view_reports = %d", w.Code)
	}

	// Per-salesperson rows: Rina rated 5 (flagged), Tanpa sales rated 3, receipts sent counted.
	byName := map[string]api.SalesPerformanceRow{}
	for _, r := range full.Data {
		byName[r.SalesmanName] = r
	}
	rina, none := byName["Rina"], byName["Tanpa sales"]
	if rina.Revenue != 600000 || rina.Transactions != 3 || rina.ReceiptsSent != 2 || rina.RatingsReceived != 1 || rina.FlaggedCount != 1 ||
		rina.AvgStars == nil || *rina.AvgStars != 5 || rina.StarCounts[4] != 1 || rina.ResponseRate != 0.5 || rina.SalesmanId == nil {
		t.Fatalf("Rina row = %+v", rina)
	}
	if len(rina.LatestComments) != 1 || rina.LatestComments[0].Comment != "Bagus <b>sekali</b>" {
		t.Fatalf("Rina comments = %+v", rina.LatestComments)
	}
	if none.SalesmanId != nil || none.RatingsReceived != 1 || none.StarCounts[2] != 1 || none.FlaggedCount != 0 || none.ReceiptsSent != 1 {
		t.Fatalf("Tanpa sales row = %+v", none)
	}

	// 9. The rating list: flagged filter and the salesman filter.
	listIDs := func(q string) (n int, first api.SalesRating) {
		t.Helper()
		w := do(http.MethodGet, "/reports/sales-ratings?dateFrom=2026-11-10&dateTo=2026-11-12&"+q, adm, "", "", nil)
		var l api.SalesRatingList
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &l) != nil {
			t.Fatalf("ratings %q = %d %s", q, w.Code, w.Body)
		}
		if len(l.Data) > 0 {
			first = l.Data[0]
		}
		return l.Meta.Total, first
	}
	if n, _ := listIDs(""); n != 2 {
		t.Fatalf("ratings total = %d", n)
	}
	if n, r := listIDs("flaggedOnly=true"); n != 1 || r.OrderNumber != "CR-1" || !r.FlagFast || r.SalesmanName != "Rina" {
		t.Fatalf("flagged = %d %+v", n, r)
	}
	if n, r := listIDs("salesmanId=none"); n != 1 || r.OrderNumber != "CR-4" || r.SalesmanName != "Tanpa sales" || r.Stars != 3 {
		t.Fatalf("none = %d %+v", n, r)
	}
	if n, _ := listIDs("salesmanId=" + sDewi); n != 0 {
		t.Fatalf("Dewi ratings = %d", n)
	}
	if w := do(http.MethodGet, "/reports/sales-ratings?dateFrom=2026-11-10&dateTo=2026-11-12&salesmanId=nope", adm, "", "", nil); w.Code != 400 {
		t.Fatalf("bad salesmanId = %d", w.Code)
	}

	// 10. The template: validation, custom text used by the next link, reset.
	put := func(tpl string) *httptest.ResponseRecorder {
		b, _ := json.Marshal(map[string]string{"template": tpl})
		return do(http.MethodPut, "/settings/wa-receipt-template", adm, string(b), "", nil)
	}
	for _, bad := range []string{"Tanpa tautan", "{tautan} {foo}", "{tautan}" + strings.Repeat("a", 1000)} {
		if w := put(bad); w.Code != 400 {
			t.Fatalf("template %.20q = %d", bad, w.Code)
		}
	}
	if w := do(http.MethodPut, "/settings/wa-receipt-template", kasirX, `{"template":"{tautan}"}`, "", nil); w.Code != 403 {
		t.Fatalf("cashier template write = %d", w.Code)
	}
	if w := put("Struk {tautan} untuk {pelanggan} dari {sales}"); w.Code != 200 {
		t.Fatalf("valid template = %d %s", w.Code, w.Body)
	}
	var tv api.WaReceiptTemplateResponse
	if w := do(http.MethodGet, "/settings/wa-receipt-template", adm, "", "", nil); w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &tv) != nil ||
		tv.Data.IsDefault || tv.Data.Template != "Struk {tautan} untuk {pelanggan} dari {sales}" || len(tv.Data.Placeholders) != 6 {
		t.Fatalf("get template = %d %s", w.Code, w.Body)
	}
	if _, l := create(kasirX, `{"orderUuid":"`+orders[2].id+`","phone":"0812 1111 2222"}`); l.Message != "Struk "+l.Url+" untuk Kak dari Dewi" {
		t.Fatalf("custom template message = %q", l.Message)
	}
	if w := put(""); w.Code != 200 {
		t.Fatalf("reset = %d", w.Code)
	}
	if w := do(http.MethodGet, "/settings/wa-receipt-template", adm, "", "", nil); json.Unmarshal(w.Body.Bytes(), &tv) != nil || !tv.Data.IsDefault {
		t.Fatalf("after reset = %s", w.Body)
	}
	if n := count(`SELECT count(*) FROM app_settings WHERE id = 1 AND wa_receipt_template IS NULL`); n != 1 {
		t.Fatal("reset must store NULL")
	}
}
