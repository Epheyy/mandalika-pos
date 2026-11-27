package receiptlink

import (
	"bytes"
	"context"
	"encoding/base64"
	"html/template"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func tinyPNG(t testing.TB) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 4, 2))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (f *fakeClock) now() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.t }
func (f *fakeClock) add(d time.Duration) {
	f.mu.Lock()
	f.t = f.t.Add(d)
	f.mu.Unlock()
}

type logoFixture struct {
	cache *LogoCache
	hits  *atomic.Int32
	paths chan string
	clock *fakeClock
	src   string
}

func newLogoFixture(t *testing.T, h http.HandlerFunc) *logoFixture {
	t.Helper()
	f := &logoFixture{hits: &atomic.Int32{}, paths: make(chan string, 32), clock: &fakeClock{t: time.Unix(1_800_000_000, 0)}}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		f.paths <- r.URL.Path
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	f.cache = NewLogoCache("demo")
	f.cache.prefix = srv.URL + "/demo/image/upload/"
	f.cache.client = srv.Client()
	f.cache.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	f.cache.now = f.clock.now
	f.src = f.cache.prefix + "v1/brand.png"
	return f
}

func servePNG(t *testing.T) http.HandlerFunc {
	body := tinyPNG(t)
	return func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }
}

func TestAllowedLogoSource(t *testing.T) {
	const p = "https://res.cloudinary.com/demo/image/upload/"
	cases := map[string]bool{
		p + "v1/logo.png":             true,
		p + "c_fit,w_200/v1/logo.png": true,
		"":                            false,
		p:                             false,
		"http://res.cloudinary.com/demo/image/upload/a.png":           false,
		"https://res.cloudinary.com:443/demo/image/upload/a":          false,
		"https://user@res.cloudinary.com/demo/image/upload/a":         false,
		"https://evil.example/demo/image/upload/a.png":                false,
		"https://res.cloudinary.com.evil.example/demo/image/upload/a": false,
		"https://res.cloudinary.com/other/image/upload/a.png":         false,
		"https://res.cloudinary.com/demo/image/fetch/a.png":           false,
		p + "a.png?x=1":                      false,
		p + "a.png?":                         false,
		p + "a.png#f":                        false,
		p + "../../other/image/upload/a.png": false,
		p + "%2e%2e/x.png":                   false,
		p + "a/../b.png":                     false,
	}
	for src, want := range cases {
		if got := allowedLogoSource(src, p); got != want {
			t.Errorf("%q: got %v want %v", src, got, want)
		}
	}
	if allowedLogoSource(p+"a.png", "") {
		t.Error("empty prefix must reject everything")
	}
	if NewLogoCache("").DataURI(context.Background(), p+"a.png") != "" {
		t.Error("empty cloud name must reject everything")
	}
}

func TestLogoFetchOK(t *testing.T) {
	f := newLogoFixture(t, servePNG(t))
	got := string(f.cache.DataURI(context.Background(), f.src))
	if !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Fatalf("got %.40q", got)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(got, "data:image/png;base64,"))
	if err != nil || !bytes.Equal(raw, tinyPNG(t)) {
		t.Error("payload does not round-trip")
	}
	if p := <-f.paths; p != "/demo/image/upload/c_limit,w_360,h_112,f_png/v1/brand.png" {
		t.Errorf("fetch path %q", p)
	}
	if f.cache.Peek() != template.URL(got) {
		t.Error("Peek must return the cached value")
	}
}

func TestLogoFetchRejections(t *testing.T) {
	big := append(tinyPNG(t), bytes.Repeat([]byte{0}, logoMaxBytes)...)
	cases := map[string]http.HandlerFunc{
		"not found": func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) },
		"redirect": func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://elsewhere.example/x.png", http.StatusFound)
		},
		"oversize": func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(big) },
		"html":     func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("<!doctype html><html></html>")) },
		"svg": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`))
		},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			f := newLogoFixture(t, h)
			if got := f.cache.DataURI(context.Background(), f.src); got != "" {
				t.Errorf("got %.40q, want empty", got)
			}
		})
	}
}

func TestLogoCacheBehaviour(t *testing.T) {
	var up atomic.Bool
	up.Store(true)
	body := tinyPNG(t)
	f := newLogoFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		if !up.Load() {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_, _ = w.Write(body)
	})
	ctx := context.Background()
	f.cache.DataURI(ctx, f.src)
	f.cache.DataURI(ctx, f.src)
	if f.hits.Load() != 1 {
		t.Fatalf("two calls must hit upstream once, got %d", f.hits.Load())
	}
	f.clock.add(logoOKTTL + time.Second)
	f.cache.DataURI(ctx, f.src)
	if f.hits.Load() != 2 {
		t.Fatalf("expired success must refetch, got %d", f.hits.Load())
	}

	other := f.cache.prefix + "v2/other.png"
	up.Store(false)
	if f.cache.DataURI(ctx, other) != "" || f.hits.Load() != 3 {
		t.Fatalf("a new source fetches at once (hits %d)", f.hits.Load())
	}
	f.clock.add(logoFailTTL - time.Second)
	f.cache.DataURI(ctx, other)
	if f.hits.Load() != 3 {
		t.Fatal("a failure must not be retried inside 5 minutes")
	}
	up.Store(true)
	f.clock.add(2 * time.Second)
	if f.cache.DataURI(ctx, other) == "" || f.hits.Load() != 4 {
		t.Fatalf("a failure is retried after 5 minutes (hits %d)", f.hits.Load())
	}

	if f.cache.Peek() == "" {
		t.Fatal("Peek should hold the logo")
	}
	if f.cache.DataURI(ctx, "") != "" || f.cache.Peek() != "" {
		t.Fatal("an empty source must clear Peek")
	}
}

func TestLogoConcurrentMissesShareOneFetch(t *testing.T) {
	body := tinyPNG(t)
	release := make(chan struct{})
	f := newLogoFixture(t, func(w http.ResponseWriter, _ *http.Request) { <-release; _, _ = w.Write(body) })
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); f.cache.DataURI(context.Background(), f.src) }()
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := f.hits.Load(); n != 1 {
		t.Errorf("upstream hits = %d, want 1", n)
	}
}

func TestNilLogoCacheIsSafe(t *testing.T) {
	var c *LogoCache
	if c.Peek() != "" || c.DataURI(context.Background(), "https://res.cloudinary.com/demo/image/upload/a.png") != "" {
		t.Error("nil cache must answer empty")
	}
}
