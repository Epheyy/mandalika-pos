package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// maxIdempotencyKeyLen bounds the optional Idempotency-Key of a backoffice write.
const maxIdempotencyKeyLen = 200

// okOutcome is the stored (and replayed) body of a keyed write that answers {"ok":true}.
var okOutcome = json.RawMessage(`{"ok":true}`)

// keyedWrite is one backoffice write that may carry an Idempotency-Key (plan §3.1).
// Without the header, Unkeyed runs exactly as before. With it, Effect runs once per
// key inside the receipt claim's transaction and its outcome is stored and replayed.
type keyedWrite struct {
	OpType  string                                     // e.g. "bo.transfer.send"; never a sync op type
	Payload any                                        // canonical request identity: same key + other payload = 409
	Unkeyed func() error                               // the existing path, used when no key was sent
	Effect  func(ctx context.Context, tx pgx.Tx) error // the same write inside the claim's transaction
	// Outcome, when set, builds the response body for a write that answers more than
	// {"ok":true}. It runs after the write: inside the claim's transaction (q is the tx,
	// its result is stored and replayed) or, without a key, against the pool.
	Outcome func(ctx context.Context, q read.RowQuerier) (json.RawMessage, error)
	// OnErr, when set, answers errors the shared mapping would turn into a 400; it
	// returns true once it has written the response.
	OnErr func(w http.ResponseWriter, err error) bool
	// Status is the success status code (0 = 200); a create answers 201 on a replay too.
	Status int
}

func (kw keyedWrite) status() int {
	if kw.Status == 0 {
		return http.StatusOK
	}
	return kw.Status
}

// receiptRunner is the injected runner when set (tests), else the PostgreSQL one.
func (h *Handlers) receiptRunner() service.ReceiptRunner {
	if h.receipts != nil {
		return h.receipts
	}
	return service.PoolReceiptRunner(h.Write.Pool)
}

// keyedMutated runs kw and answers 200 (or kw.Status): {"ok":true} (or the Outcome body) on the first
// run and on a replay.
func (h *Handlers) keyedMutated(w http.ResponseWriter, r *http.Request, kw keyedWrite) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(key) > maxIdempotencyKeyLen {
		httpx.Err(w, http.StatusBadRequest, "Idempotency-Key terlalu panjang")
		return
	}
	if key == "" {
		h.unkeyedMutated(w, r, kw)
		return
	}
	payload, err := json.Marshal(kw.Payload)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	uid := callerUserID(r)
	claim := service.ReceiptClaim{Key: key, OpType: kw.OpType, Scope: "user:" + uid, Payload: payload}
	var outcome json.RawMessage
	err = write.RetryBusy(r.Context(), func() error {
		var e error
		outcome, _, e = h.receiptRunner()(r.Context(), claim, func(tx pgx.Tx) (json.RawMessage, error) {
			if e := kw.Effect(r.Context(), tx); e != nil {
				return nil, e
			}
			if kw.Outcome == nil {
				return okOutcome, nil
			}
			body, e := kw.Outcome(r.Context(), tx)
			if e != nil {
				return nil, e
			}
			// Stored as a JSON string: jsonb would reorder the keys of an object, and a
			// replay must equal the first answer byte for byte.
			return json.Marshal(string(body))
		})
		return e
	})
	if err != nil {
		if kw.OnErr == nil || !kw.OnErr(w, err) {
			h.mutated(w, r, err)
		}
		return
	}
	h.invalidate(r)
	if len(outcome) > 0 && outcome[0] == '"' { // an Outcome body, stored as a string
		var text string
		if json.Unmarshal(outcome, &text) == nil {
			outcome = json.RawMessage(text)
		}
	}
	// A replayed outcome comes back from jsonb with normalised spacing: compact it so the
	// first run and every replay are byte-identical.
	var body bytes.Buffer
	if json.Compact(&body, outcome) != nil {
		body.Reset()
		body.Write(outcome)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(kw.status())
	_, _ = w.Write(body.Bytes())
}

// unkeyedMutated is the no-key path: the existing write, then {"ok":true} or, for a
// write with an Outcome, the same body built from the pool (as writeJSON, so the
// response is what it was before the key existed).
func (h *Handlers) unkeyedMutated(w http.ResponseWriter, r *http.Request, kw keyedWrite) {
	err := kw.Unkeyed()
	if err != nil && kw.OnErr != nil && kw.OnErr(w, err) {
		return
	}
	if err != nil || kw.Outcome == nil {
		h.mutated(w, r, err)
		return
	}
	h.invalidate(r)
	out, err := kw.Outcome(r.Context(), h.Write.Pool)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, kw.status(), out)
}

// isKeyConflict reports an idempotency key reused for another operation.
func isKeyConflict(err error) bool { return errors.Is(err, service.ErrReceiptKeyConflict) }

// callerUserID is the authenticated user id from the request context ("" if none).
func callerUserID(r *http.Request) string {
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	return uid
}
