package sync

import (
	"context"
	"encoding/json"
	"strings"

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
	return processBatch(ctx, c, items, e.processOne, e.Version)
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

func processBatch(ctx context.Context, c Caller, items []BatchItem,
	process func(context.Context, Caller, BatchItem) ItemResult,
	version func(context.Context, string) (VersionInfo, error),
) (BatchResult, error) {
	out := BatchResult{Results: make([]ItemResult, 0, len(items))}
	// A06/M3: the close snapshot is never recomputed, so a shift_close must not commit
	// while an earlier item of this batch (a sale or refund the snapshot should count)
	// failed retryably. Permanent refusals are review items the server never counts,
	// so they do not hold it. Any earlier retryable failure holds (conservative; the
	// POS sends FIFO and resends the same keys, so the held close just runs next flush).
	earlierRetryable := false
	for _, it := range items {
		var res ItemResult
		if msg := heldMessage(it.Type); msg != "" && earlierRetryable {
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
	vi, err := version(ctx, c.OutletID)
	if err != nil {
		return out, err
	}
	out.Version = vi.Version
	out.StockSeq = vi.StockSeq
	return out, nil
}
