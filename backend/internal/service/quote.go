package service

import (
	"encoding/json"
	"math"
)

// A10 quoted receipt total. The POS sends the total it showed and printed plus a
// small receipt snapshot; the server stores them unchanged and only FLAGS a
// difference against its own recompute (never rejects, on both routes).
const (
	QuoteMismatch = "quote_mismatch" // |quoted - server total| > Rp1
	QuoteInvalid  = "quote_invalid"  // quote unusable: stored NULL, sale accepted

	quoteSnapshotMaxBytes = 64 * 1024
	quoteMaxCents         = 99999999999999 // numeric(14,2) ceiling in cents
)

// evaluateQuote judges a client quote against the server total. A nil quote is
// "no quote" (old outbox items): stored NULL, no flag. An unusable quote (NaN,
// infinite, negative, over numeric(14,2), snapshot missing/null, over 64 KB or not a
// JSON object) is stored NULL with QuoteInvalid. Comparison is in whole cents with the
// same Rp1 tolerance as the tender rules.
func evaluateQuote(quoted *float64, snap json.RawMessage, finalTotal float64) (stored *float64, reason string) {
	if quoted == nil {
		return nil, ""
	}
	q := *quoted
	if math.IsNaN(q) || math.IsInf(q, 0) || q < 0 || math.Round(q*100) > quoteMaxCents {
		return nil, QuoteInvalid
	}
	// A real quote always carries a valid snapshot object, so receipt_snapshot IS NOT NULL
	// means "real quote" everywhere. JSON null counts as absent.
	if !validSnapshot(snap) {
		return nil, QuoteInvalid
	}
	diff := int64(math.Round(q*100)) - int64(math.Round(finalTotal*100))
	if diff < 0 {
		diff = -diff
	}
	if diff > tenderToleranceCents {
		return quoted, QuoteMismatch
	}
	return quoted, ""
}

func validSnapshot(snap json.RawMessage) bool {
	if len(snap) > quoteSnapshotMaxBytes {
		return false
	}
	var obj map[string]json.RawMessage
	return json.Unmarshal(snap, &obj) == nil && obj != nil
}
