package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

// detail is one entry of the VALIDATION_ERROR details array.
type detail struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// errBody is the ERP error envelope.
type errBody struct {
	Success   bool     `json:"success"`
	Error     string   `json:"error"`
	Message   string   `json:"message"`
	Code      string   `json:"code"`
	RequestID string   `json:"requestId"`
	Details   []detail `json:"details,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func requestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeErr(w http.ResponseWriter, status int, code, msg string, details []detail) {
	writeJSON(w, status, errBody{
		Error:     http.StatusText(status),
		Message:   msg,
		Code:      code,
		RequestID: requestID(),
		Details:   details,
	})
}

func writeValidation(w http.ResponseWriter, details []detail) {
	writeErr(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "validation failed", details)
}

// writeOK writes the {"success":true,"data":...} envelope used by documents and hooks.
func writeOK(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, map[string]any{"success": true, "data": data})
}

// writeCatalog writes the {"status":"success","data":...} envelope used by GET catalog/stock.
func writeCatalog(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "success", "data": data})
}

func (s *server) authOK(r *http.Request) bool {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(h[len(prefix):]), []byte(s.key)) == 1
}

func writeUnauthorized(w http.ResponseWriter) {
	writeErr(w, http.StatusUnauthorized, "INTEGRATION_UNAUTHORIZED", "missing or invalid API key", nil)
}

// api wraps an integration route: fault hook, then bearer key, then handler.
func (s *server) api(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if status, ok := s.takeFault(); ok {
			writeFault(w, status)
			return
		}
		if !s.authOK(r) {
			writeUnauthorized(w)
			return
		}
		h(w, r)
	}
}

// hook wraps a /_stub route: bearer key only, never faulted.
func (s *server) hook(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authOK(r) {
			writeUnauthorized(w)
			return
		}
		h(w, r)
	}
}

func (s *server) takeFault() (int, bool) {
	s.fmu.Lock()
	defer s.fmu.Unlock()
	if s.faultLeft <= 0 {
		return 0, false
	}
	s.faultLeft--
	return s.faultStatus, true
}

func writeFault(w http.ResponseWriter, status int) {
	code := "STUB_FAULT"
	switch status {
	case http.StatusServiceUnavailable:
		code = "INTEGRATION_BUSY"
	case http.StatusTooManyRequests:
		code = "RATE_LIMIT_EXCEEDED"
	}
	w.Header().Set("Retry-After", "1")
	writeErr(w, status, code, "injected fault", nil)
}
