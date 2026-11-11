package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
)

func compressRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(compressJSON(jsonCompressLevel))
	jsonBody := []byte(`{"data":[` + strings.Repeat(`{"id":"00000000-0000-4000-8000-000000000001","name":"Mandalika"},`, 200) + `{}]}`)
	// cache HIT shape: Content-Type then a bare Write with a declared Content-Length.
	r.Get("/api/v1/hit", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(jsonBody)))
		_, _ = w.Write(jsonBody)
	})
	// cache MISS shape: explicit WriteHeader(200) first.
	r.Get("/api/v1/miss", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(jsonBody)
	})
	r.Get("/api/v1/sync/pull", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(jsonBody)
	})
	r.Get("/api/v1/ota/check", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(jsonBody)))
		_, _ = w.Write(jsonBody)
	})
	r.Post("/api/v1/auth/login", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(jsonBody)
	})
	r.Get("/api/v1/export.csv", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(len(jsonBody)))
		_, _ = w.Write(jsonBody)
	})
	return r
}

func rawGet(t *testing.T, srv *httptest.Server, method, path, acceptEncoding string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	// No transport-level compression: the client neither adds Accept-Encoding nor decodes for us.
	resp, err := (&http.Client{Transport: &http.Transport{DisableCompression: true}}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, body
}

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("not gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestCompressJSONWhenAccepted(t *testing.T) {
	srv := httptest.NewServer(compressRouter())
	defer srv.Close()
	for _, path := range []string{"/api/v1/hit", "/api/v1/miss", "/api/v1/sync/pull"} {
		plain, plainBody := rawGet(t, srv, "GET", path, "")
		if plain.Header.Get("Content-Encoding") != "" {
			t.Fatalf("%s: identity request got Content-Encoding %q", path, plain.Header.Get("Content-Encoding"))
		}
		resp, body := rawGet(t, srv, "GET", path, "gzip")
		if resp.Header.Get("Content-Encoding") != "gzip" || !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
			t.Fatalf("%s: headers %v", path, resp.Header)
		}
		if resp.Header.Get("Content-Length") != "" && resp.Header.Get("Content-Length") == strconv.Itoa(len(plainBody)) {
			t.Errorf("%s: Content-Length of the identity body kept on a gzip response", path)
		}
		if len(body) >= len(plainBody) {
			t.Errorf("%s: %d compressed bytes for %d plain", path, len(body), len(plainBody))
		}
		if !bytes.Equal(gunzip(t, body), plainBody) {
			t.Errorf("%s: decoded body differs from the identity body", path)
		}
	}
}

func TestNoCompressionWithoutAcceptEncoding(t *testing.T) {
	srv := httptest.NewServer(compressRouter())
	defer srv.Close()
	resp, body := rawGet(t, srv, "GET", "/api/v1/hit", "")
	if resp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("Content-Encoding %q without Accept-Encoding", resp.Header.Get("Content-Encoding"))
	}
	if resp.Header.Get("Content-Length") != strconv.Itoa(len(body)) {
		t.Fatalf("Content-Length %q, body %d", resp.Header.Get("Content-Length"), len(body))
	}
	if resp, _ = rawGet(t, srv, "GET", "/api/v1/hit", "identity"); resp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("identity request compressed: %q", resp.Header.Get("Content-Encoding"))
	}
}

func TestOtaAndAuthPathsNotCompressed(t *testing.T) {
	srv := httptest.NewServer(compressRouter())
	defer srv.Close()
	for _, c := range []struct{ method, path string }{{"GET", "/api/v1/ota/check"}, {"POST", "/api/v1/auth/login"}} {
		resp, body := rawGet(t, srv, c.method, c.path, "gzip, deflate, br")
		if resp.Header.Get("Content-Encoding") != "" || strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
			t.Errorf("%s: compressed (%v)", c.path, resp.Header)
		}
		if !json.Valid(body) {
			t.Errorf("%s: body is not plain JSON", c.path)
		}
		if cl := resp.Header.Get("Content-Length"); cl != "" && cl != strconv.Itoa(len(body)) {
			t.Errorf("%s: Content-Length %s vs body %d", c.path, cl, len(body))
		}
	}
}

// CSV (and any non-JSON type) passes through with its Content-Length, and a Flush reaches the
// client before the handler finishes (the exports stream).
func TestCSVStreamNotCompressedAndFlushes(t *testing.T) {
	srv := httptest.NewServer(compressRouter())
	defer srv.Close()
	resp, body := rawGet(t, srv, "GET", "/api/v1/export.csv", "gzip")
	if resp.Header.Get("Content-Encoding") != "" || resp.Header.Get("Content-Length") != strconv.Itoa(len(body)) {
		t.Fatalf("csv: %v", resp.Header)
	}

	release := make(chan struct{})
	r := chi.NewRouter()
	r.Use(compressJSON(jsonCompressLevel))
	r.Get("/stream", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		_, _ = w.Write([]byte("id\n1\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte("2\n"))
	})
	s2 := httptest.NewServer(r)
	defer s2.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	req, _ := http.NewRequest("GET", s2.URL+"/stream", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	got, err := (&http.Client{Transport: &http.Transport{DisableCompression: true}}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer got.Body.Close()
	first := make([]byte, 5)
	if _, err := io.ReadFull(got.Body, first); err != nil || string(first) != "id\n1\n" {
		t.Fatalf("first chunk %q err %v: the flush did not reach the client", first, err)
	}
	close(release)
	rest, _ := io.ReadAll(got.Body)
	if string(rest) != "2\n" {
		t.Fatalf("rest %q", rest)
	}
}

// A compressed JSON stream that flushes also reaches the client in pieces.
func TestJSONStreamFlushesThroughGzip(t *testing.T) {
	release := make(chan struct{})
	r := chi.NewRouter()
	r.Use(compressJSON(jsonCompressLevel))
	r.Get("/stream", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"a":1}` + "\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte(`{"a":2}` + "\n"))
	})
	srv := httptest.NewServer(r)
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/stream", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	resp, err := (&http.Client{Transport: &http.Transport{DisableCompression: true}}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("not gzip: %v", resp.Header)
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	first := make([]byte, 8)
	if _, err := io.ReadFull(zr, first); err != nil || string(first) != `{"a":1}`+"\n" {
		t.Fatalf("first chunk %q err %v", first, err)
	}
	close(release)
	rest, err := io.ReadAll(zr)
	if err != nil || string(rest) != `{"a":2}`+"\n" {
		t.Fatalf("rest %q err %v", rest, err)
	}
}

// benchOrderPage builds a 1000-order list response like GET /orders?limit=1000.
func benchOrderPage() []byte {
	rng := rand.New(rand.NewSource(1))
	uid := func() types.UUID {
		var u types.UUID
		for i := range u {
			u[i] = byte(rng.Intn(256))
		}
		return u
	}
	names := []string{"Mandalika Rose 50ml", "Flamboyan Oud 30ml", "Performance Musk 100ml", "Sabun Cair Citrus", "Refill Amber"}
	now := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	orders := make([]api.Order, 1000)
	for i := range orders {
		items := make([]api.CartItem, 1+rng.Intn(4))
		sub := 0.0
		for j := range items {
			price := float64(50000 * (1 + rng.Intn(8)))
			qty := 1 + rng.Intn(3)
			id := uid()
			items[j] = api.CartItem{Id: &id, ProductId: uid().String(), ProductName: names[rng.Intn(len(names))],
				VariantSize: "50ml", Price: price, Quantity: qty, Subtotal: price * float64(qty)}
			sub += price * float64(qty)
		}
		tenders := []api.OrderTender{{Seq: 1, Method: "cash", Amount: sub, Tendered: sub, Change: 0}}
		orders[i] = api.Order{
			Id: uid(), OrderNumber: fmt.Sprintf("MND-BSD-%06d", i), OutletId: uid(), CashierId: uid().String(),
			CashierName: "Kasir Satu", Subtotal: sub, Total: sub, AmountPaid: sub, PaymentMethod: "cash",
			CreatedAt: now.Add(-time.Duration(i) * time.Minute), Status: "completed", Items: items, Tenders: &tenders,
		}
	}
	b, err := json.Marshal(api.OrderListResponse{Data: orders})
	if err != nil {
		panic(err)
	}
	return b
}

func benchCompress(b *testing.B, level int) {
	page := benchOrderPage()
	h := compressJSON(level)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(page)
	}))
	req := httptest.NewRequest("GET", "/api/v1/orders", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	var out int
	b.SetBytes(int64(len(page)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		out = rec.Body.Len()
	}
	b.ReportMetric(float64(len(page))/float64(out), "ratio")
	b.ReportMetric(float64(out), "gzip-bytes")
}

// BenchmarkCompressOrderPage compares the levels on a 1000-order page. Level 1 is used when
// level 5 costs more than about 15 ms a page.
func BenchmarkCompressOrderPage(b *testing.B) {
	for _, level := range []int{1, 5} {
		b.Run("level"+strconv.Itoa(level), func(b *testing.B) { benchCompress(b, level) })
	}
}

func TestBenchPageIsRealisticallySized(t *testing.T) {
	n := len(benchOrderPage())
	if n < 800_000 || n > 4_000_000 {
		t.Fatalf("bench page is %d bytes; expected 0.8-4 MB", n)
	}
}
