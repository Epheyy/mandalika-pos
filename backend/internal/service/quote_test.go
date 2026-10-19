package service

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func ptrF(v float64) *float64 { return &v }

func TestEvaluateQuote(t *testing.T) {
	snap := json.RawMessage(`{"v":1,"total":110000}`)
	big := json.RawMessage(`{"v":1,"pad":"` + strings.Repeat("x", quoteSnapshotMaxBytes) + `"}`)
	cases := []struct {
		name       string
		quoted     *float64
		snap       json.RawMessage
		final      float64
		wantStored *float64
		wantReason string
	}{
		{"absent quote is NULL with no flag", nil, nil, 110000, nil, ""},
		{"absent quote ignores a stray snapshot", nil, snap, 110000, nil, ""},
		{"equal quote stored, no flag", ptrF(110000), snap, 110000, ptrF(110000), ""},
		{"plus one rupiah within tolerance", ptrF(110001), snap, 110000, ptrF(110001), ""},
		{"minus one rupiah within tolerance", ptrF(109999), snap, 110000, ptrF(109999), ""},
		{"plus two rupiah mismatch", ptrF(110002), snap, 110000, ptrF(110002), QuoteMismatch},
		{"minus two rupiah mismatch", ptrF(109998), snap, 110000, ptrF(109998), QuoteMismatch},
		{"quote without snapshot is invalid", ptrF(110000), nil, 110000, nil, QuoteInvalid},
		{"quote with JSON null snapshot is invalid", ptrF(110000), json.RawMessage(`null`), 110000, nil, QuoteInvalid},
		{"absent quote with JSON null snapshot is NULL, no flag", nil, json.RawMessage(`null`), 110000, nil, ""},
		{"NaN is invalid", ptrF(math.NaN()), snap, 110000, nil, QuoteInvalid},
		{"infinity is invalid", ptrF(math.Inf(1)), snap, 110000, nil, QuoteInvalid},
		{"negative is invalid", ptrF(-1), snap, 110000, nil, QuoteInvalid},
		{"above numeric(14,2) is invalid", ptrF(1e12), snap, 110000, nil, QuoteInvalid},
		{"oversized snapshot is invalid", ptrF(110000), big, 110000, nil, QuoteInvalid},
		{"non-object snapshot is invalid", ptrF(110000), json.RawMessage(`[1]`), 110000, nil, QuoteInvalid},
		{"zero quote against zero total", ptrF(0), snap, 0, ptrF(0), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stored, reason := evaluateQuote(c.quoted, c.snap, c.final)
			if reason != c.wantReason {
				t.Fatalf("reason = %q, want %q", reason, c.wantReason)
			}
			if (stored == nil) != (c.wantStored == nil) || (stored != nil && *stored != *c.wantStored) {
				t.Fatalf("stored = %v, want %v", stored, c.wantStored)
			}
		})
	}
}
