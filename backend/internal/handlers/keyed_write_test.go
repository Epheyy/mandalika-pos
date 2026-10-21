package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/service"
)

// fakeRunner stands in for service.RunWithReceipt: it runs the effect (with a nil tx,
// which the test effects never touch) unless fail returns an error for that attempt.
type fakeRunner struct {
	attempts int
	claims   []service.ReceiptClaim
	fail     func(attempt int) error
}

func (f *fakeRunner) run(_ context.Context, c service.ReceiptClaim, effect service.ReceiptEffect) (json.RawMessage, bool, error) {
	f.attempts++
	f.claims = append(f.claims, c)
	if f.fail != nil {
		if err := f.fail(f.attempts); err != nil {
			return nil, false, err
		}
	}
	out, err := effect(nil)
	return out, false, err
}

func keyedReq(key string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/transfers/t1/send", nil)
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	return r.WithContext(context.WithValue(r.Context(), auth.CtxUserID, "u-1"))
}

func runKeyed(t *testing.T, key string, fr *fakeRunner) (*httptest.ResponseRecorder, int, int) {
	t.Helper()
	h := &Handlers{receipts: fr.run}
	unkeyed, effects := 0, 0
	w := httptest.NewRecorder()
	h.keyedMutated(w, keyedReq(key), keyedWrite{
		OpType: "bo.test", Payload: map[string]string{"transferId": "t1"},
		Unkeyed: func() error { unkeyed++; return nil },
		Effect:  func(context.Context, pgx.Tx) error { effects++; return nil },
	})
	return w, unkeyed, effects
}

func TestKeyedMutatedEmptyKeyUsesUnkeyedPath(t *testing.T) {
	fr := &fakeRunner{}
	w, unkeyed, effects := runKeyed(t, "  ", fr)
	if w.Code != http.StatusOK || unkeyed != 1 || effects != 0 || fr.attempts != 0 {
		t.Fatalf("code=%d unkeyed=%d effects=%d runner=%d", w.Code, unkeyed, effects, fr.attempts)
	}
}

func TestKeyedMutatedKeyRunsEffectOnceWithClaim(t *testing.T) {
	fr := &fakeRunner{}
	w, unkeyed, effects := runKeyed(t, " k-1 ", fr)
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"ok":true}` || unkeyed != 0 || effects != 1 {
		t.Fatalf("code=%d body=%s unkeyed=%d effects=%d", w.Code, w.Body.String(), unkeyed, effects)
	}
	c := fr.claims[0]
	if c.Key != "k-1" || c.OpType != "bo.test" || c.Scope != "user:u-1" || string(c.Payload) != `{"transferId":"t1"}` {
		t.Fatalf("claim = %+v", c)
	}
}

func TestKeyedMutatedRetriesDeadlockToOneEffect(t *testing.T) {
	fr := &fakeRunner{fail: func(attempt int) error {
		if attempt == 1 {
			return &pgconn.PgError{Code: "40P01"}
		}
		return nil
	}}
	w, _, effects := runKeyed(t, "k-2", fr)
	if w.Code != http.StatusOK || fr.attempts != 2 || effects != 1 {
		t.Fatalf("code=%d attempts=%d effects=%d, want 200 / 2 / 1", w.Code, fr.attempts, effects)
	}
}

func TestKeyedMutatedPersistentDeadlockIs409(t *testing.T) {
	fr := &fakeRunner{fail: func(int) error { return &pgconn.PgError{Code: "40P01"} }}
	w, _, effects := runKeyed(t, "k-3", fr)
	if w.Code != http.StatusConflict || effects != 0 || strings.Contains(w.Body.String(), "40P01") {
		t.Fatalf("code=%d effects=%d body=%s", w.Code, effects, w.Body.String())
	}
}

func TestKeyedMutatedOverLongKeyIs400(t *testing.T) {
	fr := &fakeRunner{}
	w, unkeyed, effects := runKeyed(t, strings.Repeat("k", maxIdempotencyKeyLen+1), fr)
	if w.Code != http.StatusBadRequest || unkeyed+effects+fr.attempts != 0 {
		t.Fatalf("code=%d unkeyed=%d effects=%d runner=%d", w.Code, unkeyed, effects, fr.attempts)
	}
	if w, _, _ = runKeyed(t, strings.Repeat("k", maxIdempotencyKeyLen), &fakeRunner{}); w.Code != http.StatusOK {
		t.Fatalf("a %d-char key must be accepted, got %d", maxIdempotencyKeyLen, w.Code)
	}
}

func TestKeyedMutatedKeyConflictIs409(t *testing.T) {
	fr := &fakeRunner{fail: func(int) error { return service.ErrReceiptKeyConflict }}
	w, _, effects := runKeyed(t, "k-4", fr)
	if w.Code != http.StatusConflict || effects != 0 || fr.attempts != 1 {
		t.Fatalf("code=%d effects=%d attempts=%d (a key conflict must not be retried)", w.Code, effects, fr.attempts)
	}
}
