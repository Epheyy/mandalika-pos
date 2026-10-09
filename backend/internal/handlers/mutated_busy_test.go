package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/write"
)

func TestMutatedBusyIs409WithoutDatabaseText(t *testing.T) {
	h := &Handlers{}
	w := httptest.NewRecorder()
	h.mutated(w, httptest.NewRequest(http.MethodPost, "/x", nil), write.ErrBusy)
	if w.Code != http.StatusConflict {
		t.Fatalf("status %d", w.Code)
	}
	if strings.Contains(strings.ToLower(w.Body.String()), "deadlock") || strings.Contains(w.Body.String(), "40P01") {
		t.Fatalf("raw database text leaked: %s", w.Body.String())
	}
}
