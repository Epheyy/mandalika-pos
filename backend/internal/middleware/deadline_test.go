package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func deadlineOut(t *testing.T, limit time.Duration) (time.Duration, bool) {
	t.Helper()
	var left time.Duration
	var has bool
	h := Deadline(func(*http.Request) time.Duration { return limit })(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		var dl time.Time
		dl, has = r.Context().Deadline()
		left = time.Until(dl)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	return left, has
}

func TestDeadlineSetsContextDeadline(t *testing.T) {
	left, has := deadlineOut(t, 15*time.Second)
	if !has || left < 14*time.Second || left > 15*time.Second {
		t.Fatalf("deadline in %v (has=%v), want about 15s", left, has)
	}
}

func TestDeadlineZeroLeavesContextUntouched(t *testing.T) {
	if _, has := deadlineOut(t, 0); has {
		t.Fatal("limit 0 means exempt: no deadline may be added")
	}
}

func TestDeadlineKeepsAnEarlierParentDeadline(t *testing.T) {
	left, _ := deadlineOut(t, time.Hour)
	if left > time.Hour {
		t.Fatalf("got %v", left)
	}
}

func TestDeadlineExpiresContextForSlowHandler(t *testing.T) {
	var err error
	h := Deadline(func(*http.Request) time.Duration { return 20 * time.Millisecond })(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		err = r.Context().Err()
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	if err == nil || err.Error() != "context deadline exceeded" {
		t.Fatalf("err = %v", err)
	}
}
