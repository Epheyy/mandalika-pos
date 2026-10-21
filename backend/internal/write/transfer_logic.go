package write

import (
	"fmt"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// TransferLoc is a polymorphic transfer endpoint (source or destination).
type TransferLoc struct {
	Kind string `json:"kind"` // "outlet" | "warehouse"
	ID   string `json:"id"`
}

func validLocKind(kind string) bool { return kind == "outlet" || kind == "warehouse" }

// sameLoc reports a self-transfer (source and dest are the same place).
func sameLoc(a, b TransferLoc) bool { return a.Kind == b.Kind && a.ID == b.ID }

// transferTransition returns the status a transfer moves to when `action` is
// applied while in `from`, or an error if the action is not allowed there.
// Actions: "send" (draft→in_transit), "receive" (in_transit→completed),
// "cancel" (draft|in_transit→cancelled).
func transferTransition(from, action string) (string, error) {
	switch action {
	case "send":
		if from == "draft" {
			return "in_transit", nil
		}
	case "receive":
		if from == "in_transit" {
			return "completed", nil
		}
	case "cancel":
		if from == "draft" || from == "in_transit" {
			return "cancelled", nil
		}
	}
	return "", errTransitionDenied(from)
}

// errTransitionDenied is the domain error for an action applied in a status that
// does not allow it. Also returned when a guarded status UPDATE matches no row.
func errTransitionDenied(from string) error {
	return apperr.Wrap(apperr.Conflict, fmt.Errorf("aksi tidak diizinkan dari status '%s'", from))
}

// errCompetingReceipt is returned when a receive finds the transfer already
// completed by a different receive. The text matches errTransitionDenied so the
// message every client sees today is unchanged; only the machine code differs.
func errCompetingReceipt(from string) error {
	return apperr.Wrap(apperr.CompetingReceipt, fmt.Errorf("aksi tidak diizinkan dari status '%s'", from))
}

// receivedPerLine resolves the received qty of every line (same order as lines)
// from a payload keyed by product+size, not by line id. Create now refuses two
// lines of the same product+size, but legacy rows can still hold them: for such a
// key the supplied entries are summed and spread over its lines in order (each
// capped at its sent qty, the surplus landing on the last line). A key with a
// single line keeps the last-entry-wins rule; an unsupplied key defaults to sent.
func receivedPerLine(lines []transferLine, items []TransferReceiveItem) ([]int, error) {
	supplied := map[string]int{}
	total := map[string]int{}
	for _, it := range items {
		if it.ReceivedQty < 0 {
			return nil, apperr.Wrap(apperr.Rejected, fmt.Errorf("jumlah terima tidak boleh negatif"))
		}
		k := it.ProductID + "|" + it.VariantSize
		supplied[k] = it.ReceivedQty // last wins (single-line keys)
		total[k] += it.ReceivedQty   // summed (duplicate-line keys)
	}
	count := map[string]int{}
	for _, l := range lines {
		count[l.pid+"|"+l.size]++
	}
	remaining := map[string]int{}
	for k, n := range count {
		if n > 1 {
			if t, ok := total[k]; ok {
				remaining[k] = t
			}
		}
	}
	seen := map[string]int{}
	out := make([]int, len(lines))
	for i, l := range lines {
		k := l.pid + "|" + l.size
		seen[k]++
		if _, ok := supplied[k]; !ok {
			out[i] = l.sent
			continue
		}
		if count[k] == 1 {
			out[i] = supplied[k]
			continue
		}
		rem := remaining[k]
		got := rem
		if seen[k] < count[k] && l.sent < rem {
			got = l.sent
		}
		out[i] = got
		remaining[k] = rem - got
	}
	return out, nil
}

// transferDiff is received minus sent (negative = shortfall, positive = surplus).
func transferDiff(sent, received int) int { return received - sent }
