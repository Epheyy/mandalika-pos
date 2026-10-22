package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every direct response site must route error text through writeErr/safeDomainText.
// A raw `httpx.Err(w, S, <x>.Error())` or `"error": <x>.Error()` is allowed only for the
// reviewed domain-only sites below (key: file + trimmed line text).
var (
	rawHTTPErr  = regexp.MustCompile(`httpx\.Err\(.*\.Error\(\)\)`)
	rawJSONErr  = regexp.MustCompile(`"error":\s*[A-Za-z_][\w.]*\.Error\(\)`)
	rawAllowDoc = map[string]string{
		"orders.go|httpx.Err(w, http.StatusConflict, write.ErrBusy.Error()) // nothing applied, safe to retry":                                                              "fixed sentinel text",
		"orders.go|httpx.Err(w, http.StatusUnprocessableEntity, err.Error())":                                                                                               "service.ErrTenderRejected: cashier's own amounts only",
		"sync_review.go|httpx.Err(w, http.StatusBadRequest, errReviewBatchSize.Error())":                                                                                    "fixed package-level message",
		"receive_approval.go|writeJSON(w, http.StatusTooManyRequests, map[string]any{\"error\": locked.Error(), \"retryAfterSeconds\": secs, \"hardLocked\": locked.Hard})": "write.LockedError: fixed lockout text",
	}
)

func TestNoRawErrorTextInDirectResponses(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	used := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if !rawHTTPErr.MatchString(line) && !rawJSONErr.MatchString(line) {
				continue
			}
			key := f + "|" + line
			if _, ok := rawAllowDoc[key]; ok {
				used[key] = true
				continue
			}
			t.Errorf("%s:%d sends raw error text: %s (use writeErr/safeDomainText or add a reviewed allowlist entry)", f, i+1, line)
		}
	}
	for k := range rawAllowDoc {
		if !used[k] {
			t.Errorf("stale allowlist entry: %s", k)
		}
	}
}
