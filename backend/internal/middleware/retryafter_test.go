package middleware

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestRetryAfterSecondsIsRemainderOfFixedWindow(t *testing.T) {
	window := time.Minute
	cases := []struct {
		name string
		now  time.Time
		want int
	}{
		{"start of window", time.Unix(600, 0), 60},
		{"mid window", time.Unix(630, 0), 30},
		{"one second left", time.Unix(659, 0), 1},
		{"sub-second remainder rounds up and never reaches 0", time.Unix(659, 999_000_000), 1},
	}
	for _, c := range cases {
		if got := retryAfterSeconds(c.now, window); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}
}

// With a one-hour window a revert to the full window (3600) is distinguishable: the header
// must equal the remainder computed from the clock before/after the request.
func TestRateLimit429SendsRemainingWindowSeconds(t *testing.T) {
	window := time.Hour
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	h := RateLimit(disabledCache(t), "ra", 2, window)(ok)
	for i := 1; i <= 2; i++ {
		if code := hit(h, "198.51.100.9"); code != 200 {
			t.Fatalf("request %d: %d", i, code)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req.RemoteAddr = "198.51.100.9:1234"
	rec := httptest.NewRecorder()
	before := retryAfterSeconds(time.Now(), window)
	h.ServeHTTP(rec, req)
	after := retryAfterSeconds(time.Now(), window)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d", rec.Code)
	}
	if after > before {
		t.Skip("hour boundary crossed during the request")
	}
	n, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil || n < after || n > before {
		t.Fatalf("Retry-After %q must be the remainder of the window, in [%d, %d]", rec.Header().Get("Retry-After"), after, before)
	}
}
