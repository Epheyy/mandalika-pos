package erp

// Pure decision logic of the relay: what one ERP answer means for the outbox row.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Row statuses (the erp_outbox.status values the relay writes).
const (
	statusPending   = "pending"
	statusHeld      = "held"
	statusDelivered = "delivered"
	statusReplayed  = "replayed"
	statusDead      = "dead"
)

// outcome is the pure decision for one send attempt; finish persists it.
type outcome struct {
	status     string
	attempts   int           // value to store in erp_outbox.attempts
	delay      time.Duration // next_attempt_at offset
	stop       string        // non-empty ends the run
	httpStatus *int
	lastError  string
	response   *string // erp_response as JSON text; nil keeps the stored one
	holdReason string  // erp_outbox.hold_reason; set only with statusHeld
	// clearPayload drops the frozen body so the next look rebuilds it. Only safe after an
	// answer that proves nothing was applied (a 422 writes nothing, and the ERP checks for
	// a replay before it validates the outlet).
	clearPayload bool
}

func (o outcome) count(rep *RunReport) {
	switch {
	case o.status == statusDelivered:
		rep.Delivered++
	case o.status == statusReplayed:
		rep.Replayed++
	case o.status == statusDead:
		rep.Dead++
	case o.status == statusHeld:
		rep.Held++
	case o.stop == stopUnauthorized || o.stop == stopForbidden || o.stop == stopRateLimited:
		rep.Released++ // put back untouched: not the document's fault
	default:
		rep.Retried++
	}
}

// classify turns the ERP answer into the next state. attempts is the count before this
// try; sha is the frozen payload hash (named in 409 errors); documentID is the document
// the answer must be about to count as a delivery.
func classify(resp Response, err error, attempts int, sha, documentID string, cfg Config) outcome {
	if err != nil {
		return retry(attempts, cfg, Response{}, nil, truncate(cleanText(err.Error()), maxErrorLen))
	}
	st := resp.Status
	code := st
	switch {
	case st >= 200 && st < 300:
		return classifySuccess(resp, attempts, documentID, cfg)
	case st == http.StatusUnauthorized, st == http.StatusForbidden:
		// 403 is deliberately not dead-lettered (plan §5.2 says it should be): a suspended
		// client or a missing scope would otherwise dead-letter every queued document.
		// Pause and retry later instead; attempts stay unchanged.
		stop := stopUnauthorized
		if st == http.StatusForbidden {
			stop = stopForbidden
		}
		return outcome{status: statusPending, attempts: attempts, delay: cfg.AuthBackoff, stop: stop,
			httpStatus: &code, lastError: truncate(errorText(resp), maxErrorLen), response: rawJSON(resp.Body)}
	case st == http.StatusUnprocessableEntity && onlyLocationDetails(resp.Body):
		// The outlet is unknown to the ERP or not yet set on this client (its BR4/BR5), or an
		// old body names the outlet by slug only: an ERP admin task, not a broken document.
		// Hold it without burning an attempt, and rebuild the body at the next look so a
		// corrected outlets.erp_code is picked up.
		msg := truncate(errorText(resp), maxErrorLen)
		return outcome{status: statusHeld, attempts: attempts, delay: cfg.HoldDelay, httpStatus: &code,
			lastError: msg, holdReason: msg, response: rawJSON(resp.Body), clearPayload: true}
	case st == http.StatusBadRequest, st == http.StatusConflict, st == http.StatusUnprocessableEntity,
		st == http.StatusRequestEntityTooLarge:
		suffix := ""
		if st == http.StatusConflict {
			suffix = fmt.Sprintf(" (the ERP already holds a different body for this document_id; payload_sha256=%s)", sha)
		}
		// Cut the ERP text, never the suffix: the 409 must keep naming the payload hash.
		return outcome{status: statusDead, attempts: attempts + 1, httpStatus: &code,
			lastError: truncate(errorText(resp), maxErrorLen-len(suffix)) + suffix, response: rawJSON(resp.Body)}
	case st == http.StatusTooManyRequests:
		// Like 401/403, a 429 is not the document's fault: no attempt is burned.
		return outcome{status: statusPending, attempts: attempts, delay: max(resp.RetryAfter, rateLimitPause),
			stop: stopRateLimited, httpStatus: &code, lastError: truncate(errorText(resp), maxErrorLen),
			response: rawJSON(resp.Body)}
	}
	return retry(attempts, cfg, resp, &code, truncate(errorText(resp), maxErrorLen))
}

// classifySuccess accepts a 2xx only when it is the ERP's answer for this document. Two
// envelopes are accepted (owner decision 2026-10-25): the ERP's {"status":"success"} and
// the stub's legacy {"success":true}.
func classifySuccess(resp Response, attempts int, documentID string, cfg Config) outcome {
	code := resp.Status
	var env struct {
		Success *bool    `json:"success"`
		Status  string   `json:"status"`
		Data    struct { // movement_ids is not read: a malformed one must not reject an applied document
			DocumentID string `json:"document_id"`
			Status     string `json:"status"`
		} `json:"data"`
	}
	ok := json.Unmarshal(resp.Body, &env) == nil && successEnvelope(env.Success, env.Status) &&
		strings.EqualFold(env.Data.DocumentID, documentID) &&
		(env.Data.Status == "applied" || env.Data.Status == "replayed")
	if !ok {
		return retry(attempts, cfg, resp, &code, "unexpected 2xx body")
	}
	status := statusDelivered
	if env.Data.Status == "replayed" {
		status = statusReplayed
	}
	return outcome{status: status, attempts: attempts + 1, httpStatus: &code, response: rawJSON(resp.Body)}
}

// onlyLocationDetails reports whether a 422 body names location fields and nothing else.
func onlyLocationDetails(body []byte) bool {
	var eb ErrorBody
	if json.Unmarshal(body, &eb) != nil || len(eb.Details) == 0 {
		return false
	}
	for _, d := range eb.Details {
		if p := dottedPath(d.Path); p != "location" && !strings.HasPrefix(p, "location.") {
			return false
		}
	}
	return true
}

// successEnvelope needs at least one success marker and no contrary one: "success":false
// or a "status" other than "success" (exact case) rejects the body.
func successEnvelope(success *bool, status string) bool {
	if success != nil && !*success || status != "" && status != "success" {
		return false
	}
	return success != nil || status != ""
}

// retry schedules another try, or dead-letters the row at MaxAttempts.
func retry(attempts int, cfg Config, resp Response, code *int, lastError string) outcome {
	n := attempts + 1
	o := outcome{attempts: n, httpStatus: code, lastError: lastError, response: rawJSON(resp.Body)}
	if n >= cfg.MaxAttempts {
		o.status = statusDead
		o.lastError = truncate("max attempts reached: "+lastError, maxErrorLen)
		return o
	}
	o.status = statusPending
	o.delay = max(backoff(n), resp.RetryAfter)
	return o
}

// backoff is min(2^n minutes, 60 minutes).
func backoff(n int) time.Duration {
	if n >= 6 {
		return maxBackoffMins * time.Minute
	}
	return time.Duration(1<<n) * time.Minute
}

// errorText renders "<code>: <message> [<path>: <message>; ...]" from the ERP error
// envelope, falling back to the HTTP status when the body is not one.
func errorText(resp Response) string {
	var eb ErrorBody
	if json.Unmarshal(resp.Body, &eb) == nil && (eb.Code != "" || eb.Message != "") {
		code := eb.Code
		if code == "" {
			code = eb.Error
		}
		return cleanText(code + ": " + eb.Message + detailsText(eb.Details))
	}
	return fmt.Sprintf("HTTP %d", resp.Status)
}

// detailsText lists the first maxDetails details so the dead-letter message names the
// offending fields; "" when there are none.
func detailsText(ds []ErrorDetail) string {
	if len(ds) == 0 {
		return ""
	}
	parts := make([]string, 0, min(len(ds), maxDetails)+1)
	for _, d := range ds[:min(len(ds), maxDetails)] {
		switch p := dottedPath(d.Path); {
		case p == "":
			parts = append(parts, d.Message)
		case d.Message == "":
			parts = append(parts, p)
		default:
			parts = append(parts, p+": "+d.Message)
		}
	}
	if n := len(ds) - maxDetails; n > 0 {
		parts = append(parts, fmt.Sprintf("+%d more", n))
	}
	return " [" + strings.Join(parts, "; ") + "]"
}

// dottedPath renders a detail path: an array (["lines", 2, "fg_code"]) as
// "lines.2.fg_code", a string as is, null or absent as "". Anything else is kept as
// its compact JSON text.
func dottedPath(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // a large index must not print as 1e+06
	var v any
	if dec.Decode(&v) != nil {
		return ""
	}
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []any:
		segs := make([]string, len(x))
		for i, e := range x {
			if s, ok := e.(string); ok {
				segs[i] = s
				continue
			}
			b, _ := json.Marshal(e)
			segs[i] = string(b)
		}
		return strings.Join(segs, ".")
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// rawJSON returns the body as jsonb text: the cleaned body when it is a JSON object, else
// a {"raw": "..."} wrapper; nil for an empty body. Everything is sanitised first because
// json.Valid accepts what Postgres rejects (invalid UTF-8, \u0000, lone surrogates).
func rawJSON(body []byte) *string {
	if len(body) == 0 {
		return nil
	}
	text := cleanText(string(body))
	s := cleanJSONObject(text)
	if s == "" {
		b, _ := json.Marshal(map[string]string{"raw": truncate(text, maxRawBodyLen)})
		s = string(b)
	}
	return &s
}

// cleanText makes ERP-derived text storable: valid UTF-8, no NUL.
func cleanText(s string) string {
	return strings.ReplaceAll(strings.ToValidUTF8(s, "\uFFFD"), "\x00", "")
}

// cleanJSONObject decodes and re-encodes a JSON object with every string cleaned (the
// decode turns lone surrogate escapes into U+FFFD); "" when text is not a JSON object.
func cleanJSONObject(text string) string {
	if !json.Valid([]byte(text)) {
		return ""
	}
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil {
		return ""
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	b, err := json.Marshal(cleanValue(obj))
	if err != nil {
		return ""
	}
	return string(b)
}

func cleanValue(v any) any {
	switch x := v.(type) {
	case string:
		return cleanText(x)
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = cleanValue(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[cleanText(k)] = cleanValue(e)
		}
		return out
	}
	return v
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "") // never cut a rune: Postgres rejects invalid UTF-8
}
