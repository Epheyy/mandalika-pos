package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// dropPosts answers the first drop POSTs with a closed connection (a lost reply after the
// server applied them) and later POSTs with {"data":{"id":"new"}}.
func dropPosts(t *testing.T, drop int32) (*rt, *atomic.Int32) {
	t.Helper()
	var posts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if posts.Add(1) <= drop {
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				_ = conn.Close()
			}
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"data":{"id":"new"}}`))
	}))
	t.Cleanup(srv.Close)
	return &rt{be: newHTTP(srv.URL, nil)}, &posts
}

func TestOnceRecoverUsesTheWriteThatLanded(t *testing.T) {
	r, posts := dropPosts(t, 1)
	id, err := r.onceRecover("POST", "/transfers", nil, obj{}, dataID, func() (string, error) { return "landed-id", nil })
	if err != nil || id != "landed-id" || posts.Load() != 1 {
		t.Fatalf("id=%q err=%v posts=%d; want the landed id and no second POST", id, err, posts.Load())
	}
}

func TestOnceRecoverResendsWhenTheWriteDidNotLand(t *testing.T) {
	r, posts := dropPosts(t, 1)
	id, err := r.onceRecover("POST", "/transfers", nil, obj{}, dataID, func() (string, error) { return "", nil })
	if err != nil || id != "new" || posts.Load() != 2 {
		t.Fatalf("id=%q err=%v posts=%d; want one resend", id, err, posts.Load())
	}
}

func TestOnceRecoverSendsOnceWhenTheReplyArrives(t *testing.T) {
	r, posts := dropPosts(t, 0)
	id, err := r.onceRecover("POST", "/transfers", nil, obj{}, dataID, func() (string, error) {
		t.Fatal("landed must not be asked when the reply arrived")
		return "", nil
	})
	if err != nil || id != "new" || posts.Load() != 1 {
		t.Fatalf("id=%q err=%v posts=%d", id, err, posts.Load())
	}
}
