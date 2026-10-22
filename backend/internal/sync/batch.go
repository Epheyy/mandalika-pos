package sync

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/apperr"
)

type BatchItem struct {
	Type           string          `json:"type"` // order|refund|shift_open|shift_close|cash_flow
	IdempotencyKey string          `json:"idempotencyKey"`
	Payload        json.RawMessage `json:"payload"`
	// Envelope is the raw capture-time identity (A04), absent for legacy clients.
	Envelope json.RawMessage `json:"envelope,omitempty"`
}

type ItemResult struct {
	IdempotencyKey string `json:"idempotencyKey"`
	Status         string `json:"status"` // ok|duplicate|error
	OrderID        string `json:"orderId,omitempty"`
	StockWarning   bool   `json:"stockWarning,omitempty"`
	Error          string `json:"error,omitempty"`
	// Code and Retryable are set exactly when Status is "error" (Retryable is a
	// pointer so false is still serialised). Clients must treat a missing or
	// unknown Code as the pre-contract behaviour (an older server omits both).
	Code          string        `json:"code,omitempty"`
	Retryable     *bool         `json:"retryable,omitempty"`
	TandaTerimaNo string        `json:"tandaTerimaNo,omitempty"`
	Transfer      *api.Transfer `json:"transfer,omitempty"`
	// StockSeq is the outlet stock counter value THIS sale produced (A15 Phase B). Set
	// only for a fresh, successful order whose attributed outlet is the batch caller's
	// outlet; a duplicate, a refund, an error or an order attributed elsewhere carries
	// none. A pointer so a real 0 survives omitempty.
	StockSeq *int64 `json:"stockSeq,omitempty"`
	// attributedOutlet is the outlet StockSeq counts (the item's attributed outlet);
	// processBatch compares it with the caller's outlet. Never serialised.
	attributedOutlet string
}

type BatchResult struct {
	Processed int          `json:"processed"`
	Results   []ItemResult `json:"results"`
	Version   int64        `json:"version"`
	// StockSeq is the caller outlet's counter from the post-items Version() read.
	StockSeq *int64 `json:"stockSeq,omitempty"`
}

// Identity from the authenticated caller (never trusted from payload).
type Caller struct {
	OutletID    string
	UserID      string
	DisplayName string
	// Role and HomeOutletID come from the users row (not the request): the outlet a
	// non-admin may be attributed to is only ever their stored outlet (A04).
	Role         string `json:"-"`
	HomeOutletID string `json:"-"`
	// Server-derived from authenticated request claims; never from a batch body.
	CanRefund bool `json:"-"`
	// EnvelopeShiftID is set by attribute() only when the envelope's shift row exists
	// at the attributed outlet (open or closed); unknown, non-uuid or absent -> "".
	// Never taken from the request: a dangling id would hit the orders FK (23503).
	EnvelopeShiftID string `json:"-"`
}

// ProcessBatch flushes outbox items in order, one at a time, each idempotent.
// A failed item does not abort the batch — POS retries it next flush.
func (e *Engine) ProcessBatch(ctx context.Context, c Caller, items []BatchItem) (BatchResult, error) {
	process, version := e.processOne, e.Version
	if e.testProcess != nil {
		process = e.testProcess
	}
	if e.testVersion != nil {
		version = e.testVersion
	}
	return processBatchBudget(ctx, c, items, process, version, e.workBudget(), time.Now)
}

// DefaultWorkBudget bounds the item-processing phase of one batch. The budget is only
// checked between items and no statement_timeout is set (only lock_timeout), so the
// worst case is budget + one item's own run + the closing version read. The request
// deadline (server.LongDeadline, 28 s) starts at the middleware, before the body upload
// and decode, so the budget is also capped at (time left on ctx) - deadlineHeadroom:
// what remains must cover one item (about 5 s allowance) plus versionReadTimeout, which
// keeps the response inside the 30 s WriteTimeout and the client's abort. Items past the
// budget are deferred, not failed.
const DefaultWorkBudget = 20 * time.Second

// versionReadTimeout is the fresh context the closing version read gets, so a nearly
// expired (or expired) request context still returns the counters.
const versionReadTimeout = 2 * time.Second

// deadlineHeadroom is reserved at the end of the request deadline: one item's run
// (allowance 5 s) plus versionReadTimeout; 28 s - 7 s + 5 s + 2 s = 28 s, inside the 30 s WriteTimeout.
const deadlineHeadroom = 7 * time.Second

// effectiveBudget shrinks budget so work stops deadlineHeadroom before the request
// deadline, when there is one. It stays positive: the first item always runs anyway.
func effectiveBudget(budget time.Duration, start, deadline time.Time, hasDeadline bool) time.Duration {
	if hasDeadline {
		if left := deadline.Sub(start) - deadlineHeadroom; left < budget {
			budget = left
		}
	}
	if budget <= 0 {
		budget = time.Nanosecond
	}
	return budget
}

// budgetDeferredMessage is the fixed text of an item left unprocessed by the work
// budget or an expired request context (no receipt claimed, no effect).
const budgetDeferredMessage = "Ditunda: batas waktu proses batch tercapai, akan dicoba ulang otomatis."

// workBudget resolves the engine's budget: zero means DefaultWorkBudget.
func (e *Engine) workBudget() time.Duration {
	if e.WorkBudget <= 0 {
		return DefaultWorkBudget
	}
	return e.WorkBudget
}

// closeHeldMessage is returned for a shift_close held back because an earlier item
// in the same batch failed retryably (its effect must land in the close snapshot).
const closeHeldMessage = "Tutup shift ditunda: ada transaksi sebelumnya yang belum tersimpan, akan dicoba ulang otomatis."

// openHeldMessage is the shift_open counterpart: a new shift must not open while the old
// one is being held open, or it would be refused as a second open shift.
const openHeldMessage = "Buka shift ditunda: ada transaksi sebelumnya yang belum tersimpan, akan dicoba ulang otomatis."

// heldMessage is the hold text for the item types that wait behind an earlier retryable
// failure: shift_close (so its snapshot stays complete) and shift_open (so a new shift
// is not refused as a second open one while the old close is held). Sales and refunds
// are never held.
func heldMessage(itemType string) string {
	switch itemType {
	case "shift_close":
		return closeHeldMessage
	case "shift_open":
		return openHeldMessage
	}
	return ""
}

// processBatch runs a batch with the default work budget and the wall clock.
func processBatch(ctx context.Context, c Caller, items []BatchItem,
	process func(context.Context, Caller, BatchItem) ItemResult,
	version func(context.Context, string) (VersionInfo, error),
) (BatchResult, error) {
	return processBatchBudget(ctx, c, items, process, version, DefaultWorkBudget, time.Now)
}

// processBatchBudget processes items strictly in order. Before every item except the
// first (a batch always makes progress) it checks the request context and the work
// budget; past either, the item is answered as a retryable Busy with no receipt claimed
// and no effect, and later shift_open/shift_close stay held behind it. budget <= 0 means
// DefaultWorkBudget; now is injectable for tests.
func processBatchBudget(ctx context.Context, c Caller, items []BatchItem,
	process func(context.Context, Caller, BatchItem) ItemResult,
	version func(context.Context, string) (VersionInfo, error),
	budget time.Duration, now func() time.Time,
) (BatchResult, error) {
	if budget <= 0 {
		budget = DefaultWorkBudget
	}
	start := now()
	dl, hasDl := ctx.Deadline()
	budget = effectiveBudget(budget, start, dl, hasDl)
	out := BatchResult{Results: make([]ItemResult, 0, len(items))}
	// A06/M3: the close snapshot is never recomputed, so a shift_close must not commit
	// while an earlier item of this batch (a sale or refund the snapshot should count)
	// failed retryably. Permanent refusals are review items the server never counts,
	// so they do not hold it. Any earlier retryable failure holds (conservative; the
	// POS sends FIFO and resends the same keys, so the held close just runs next flush).
	earlierRetryable := false
	for i, it := range items {
		var res ItemResult
		if i > 0 && (ctx.Err() != nil || now().Sub(start) >= budget) {
			// Out of time: do not start more work, and do not let each remaining item
			// fail separately with a context error.
			retryable := true
			res = ItemResult{IdempotencyKey: it.IdempotencyKey, Status: "error", Error: budgetDeferredMessage,
				Code: string(apperr.Busy), Retryable: &retryable}
		} else if msg := heldMessage(it.Type); msg != "" && earlierRetryable {
			// No receipt claimed, no effect: the same key runs normally on retry.
			retryable := true
			res = ItemResult{IdempotencyKey: it.IdempotencyKey, Status: "error", Error: msg,
				Code: string(apperr.Busy), Retryable: &retryable}
		} else {
			res = process(ctx, c, it)
		}
		if res.Status == "error" && res.Retryable != nil && *res.Retryable {
			earlierRetryable = true
		}
		// The per-item counter belongs to the attributed outlet's counter; the batch
		// caller's outlet counter can only explain it when they are the same outlet.
		if res.StockSeq != nil && !strings.EqualFold(res.attributedOutlet, c.OutletID) {
			res.StockSeq = nil
		}
		out.Results = append(out.Results, res)
		if res.Status != "error" {
			out.Processed++
		}
	}
	vctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), versionReadTimeout)
	defer cancel()
	vi, err := version(vctx, c.OutletID)
	if err != nil {
		return out, err
	}
	out.Version = vi.Version
	out.StockSeq = vi.StockSeq
	return out, nil
}
