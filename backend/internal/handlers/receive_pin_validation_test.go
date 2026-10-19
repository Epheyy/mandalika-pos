package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// A08: the receive PIN is digits only, 4-8 long, validated before any store call.
func TestSetUserReceivePinRejectsNonDigits(t *testing.T) {
	h := &Handlers{} // nil Store: a request that reaches it would panic
	for _, pin := range []string{"abcd", "12 34", "12-34", "123", "123456789", "١٢٣٤", "12ab"} {
		r := chi.NewRouter()
		r.Put("/users/{id}/receive-pin", h.SetUserReceivePin)
		req := httptest.NewRequest("PUT", "/users/u1/receive-pin", strings.NewReader(`{"pin":"`+pin+`"}`))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("pin %q: got %d, want 400", pin, w.Code)
		}
	}
}
