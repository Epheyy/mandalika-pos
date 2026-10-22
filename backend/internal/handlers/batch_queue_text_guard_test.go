package handlers

import (
	"os"
	"strings"
	"testing"
)

// queueDeferredMessage copies sync.budgetDeferredMessage (unexported). Deferrals are
// normally 0 in the BE gate, so drift would only surface on a slow CI run; this
// non-PG check catches it in every go test.
func TestQueueDeferredMessageMatchesSync(t *testing.T) {
	src, err := os.ReadFile("../sync/batch.go")
	if err != nil {
		t.Fatalf("read sync/batch.go: %v", err)
	}
	if !strings.Contains(string(src), `budgetDeferredMessage = "`+queueDeferredMessage+`"`) {
		t.Fatal("queueDeferredMessage drifted from sync.budgetDeferredMessage")
	}
}
