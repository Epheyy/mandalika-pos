package write

import "fmt"

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
	return fmt.Errorf("aksi tidak diizinkan dari status '%s'", from)
}

// transferDiff is received minus sent (negative = shortfall, positive = surplus).
func transferDiff(sent, received int) int { return received - sent }
