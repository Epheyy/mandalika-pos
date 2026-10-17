package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/write"
)

func TestErrorLogRetentionConstantsAgree(t *testing.T) {
	if read.ErrorLogRetentionDays != write.ErrorLogRetentionDays {
		t.Fatalf("read (%d) and write (%d) retention differ", read.ErrorLogRetentionDays, write.ErrorLogRetentionDays)
	}
}

// A recent sweep must short-circuit before touching the (nil here) repository.
func TestMaybeSweepErrorLogsIsThrottled(t *testing.T) {
	h := &Handlers{}
	h.lastErrorLogSweep.Store(time.Now().UnixNano())
	h.maybeSweepErrorLogs() // would panic on the nil Write repo if it started a sweep
}

// Body/shape rejections happen before any caller or database lookup, so a bare
// Handlers value is enough.
func TestCreateErrorLogsRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"oversize body", `{"items":[{"source":"sync","message":"` + strings.Repeat("a", errorLogsBodyLimit) + `"}]}`, http.StatusRequestEntityTooLarge},
		{"malformed JSON", `{"items":[`, http.StatusBadRequest},
		{"wrong shape", `{"items":"nope"}`, http.StatusBadRequest},
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
