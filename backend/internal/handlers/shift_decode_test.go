package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/service"
)

// Same no-mutation assertion before and after the decoder fix. The mutation
// boundary is a spy; separate PostgreSQL tests check actual persisted effects.
func TestShiftMalformedBodyRegression(t *testing.T) {
	for _, operation := range []string{"open", "close"} {
		for _, raw := range []string{`{"startingCash":100,"closingCash":200,`, `{"startingCash":"invalid","closingCash":"invalid"}`} {
			t.Run(operation+raw, func(t *testing.T) {
				calls := 0
				h := &Handlers{}
				w := httptest.NewRecorder()
				r := httptest.NewRequest("POST", "/shifts", strings.NewReader(raw))
				caller := func(*http.Request) (callerID, error) { return callerID{outletID: "synthetic"}, nil }
				if operation == "open" {
					h.openShift(w, r, caller, func(context.Context, service.OpenShiftInput) (string, error) {
						calls++
						return "", errors.New("synthetic stop at mutation")
					})
				} else {
					h.closeShift(w, r, caller, func(context.Context, string, string, float64, map[string]float64) error {
						calls++
						return errors.New("synthetic stop at mutation")
					})
				}
				if calls != 0 || w.Code != 400 {
					t.Fatalf("malformed %s reached mutation: calls=%d status=%d", operation, calls, w.Code)
				}
			})
		}
	}
}
