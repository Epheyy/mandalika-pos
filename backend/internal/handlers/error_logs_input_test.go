package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Body/shape rejections happen before any caller or database lookup, so a bare
// Handlers value is enough.
func TestCreateErrorLogsRejectsBadInput(t *testing.T) {
	item := `{"source":"sync","message":"m"}`
	cases := []struct {
		name string
		body string
		want int
	}{
		{"oversize body", `{"items":[{"source":"sync","message":"` + strings.Repeat("a", errorLogsBodyLimit) + `"}]}`, http.StatusRequestEntityTooLarge},
		{"malformed JSON", `{"items":[`, http.StatusBadRequest},
		{"wrong shape", `{"items":"nope"}`, http.StatusBadRequest},
		{"too many items", `{"items":[` + strings.Repeat(item+",", maxErrorLogItems) + item + `]}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/error-logs", strings.NewReader(c.body))
			(&Handlers{}).CreateErrorLogs(w, r)
			if w.Code != c.want {
				t.Fatalf("status = %d, want %d (%s)", w.Code, c.want, w.Body.String())
			}
		})
	}
}
