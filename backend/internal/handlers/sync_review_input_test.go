package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

func validReport(key string) reviewReportIn {
	return reviewReportIn{
		IdempotencyKey:  key,
		Type:            "refund",
		ReviewCode:      "forbidden",
		ReviewReason:    "denied",
		ClientCreatedAt: "2026-10-12T03:00:00Z",
		Payload:         json.RawMessage(`{"orderNumber":"BSD-G0007","total":225000}`),
	}
}

func TestNormalizeReviewReportsBatchSize(t *testing.T) {
	if _, err := normalizeReviewReports(nil); err != errReviewBatchSize {
		t.Fatalf("empty batch: %v", err)
	}
	many := make([]reviewReportIn, maxReviewReports+1)
	if _, err := normalizeReviewReports(many); err != errReviewBatchSize {
		t.Fatalf("201 items: %v", err)
	}
}

func TestNormalizeReviewReportsSkipsInvalidItems(t *testing.T) {
	bad := []reviewReportIn{
		validReport("dev:ok"),
		validReport("dev:ok"), // duplicate key
		func() reviewReportIn { r := validReport(""); return r }(),
		func() reviewReportIn { r := validReport("dev:t"); r.Type = "sale"; return r }(),
		func() reviewReportIn { r := validReport("dev:d"); r.ClientCreatedAt = "yesterday"; return r }(),
		func() reviewReportIn { r := validReport(strings.Repeat("k", maxReviewKeyLen+1)); return r }(),
	}
	out, err := normalizeReviewReports(bad)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Key != "dev:ok" {
		t.Fatalf("want only dev:ok, got %+v", out)
	}
}

func TestNormalizeReviewReportsClipsAndStrips(t *testing.T) {
	r := validReport("dev:1")
	r.ReviewReason = strings.Repeat("é", maxReviewTextRunes+5)
	r.LastError = "a\x00b"
	r.ReviewCode = strings.Repeat("c", maxReviewCodeLen+3)
	r.OwnerUserID = "not-a-uuid"
	r.CapturedOutletID = "00000000-0000-4000-8a00-000000000001"
	out, _ := normalizeReviewReports([]reviewReportIn{r})
	if len(out) != 1 {
		t.Fatalf("want 1 item, got %d", len(out))
	}
	got := out[0]
	if n := len([]rune(got.ReviewReason)); n != maxReviewTextRunes {
		t.Fatalf("reason runes = %d", n)
	}
	if got.LastError != "ab" {
		t.Fatalf("NUL not stripped: %q", got.LastError)
	}
	if len(got.ReviewCode) != maxReviewCodeLen {
		t.Fatalf("code len = %d", len(got.ReviewCode))
	}
	if got.OwnerUserID != "" || got.CapturedOutletID != "00000000-0000-4000-8a00-000000000001" {
		t.Fatalf("uuid handling: owner=%q captured=%q", got.OwnerUserID, got.CapturedOutletID)
	}
}

func TestSanitizeReviewPayload(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"strips pin", `{"transferId":"t1","pin":"1234"}`, `{"transferId":"t1"}`},
		{"nested secrets are redacted, customer data kept", `{"customerPhone":"0812","a":{"token":"t","list":[{"password":"p"}]},"h":"Bearer abc.def"}`,
			`{"a":{"list":[{"password":"[REDACTED]"}],"token":"[REDACTED]"},"customerPhone":"0812","h":"Bearer [REDACTED]"}`},
		{"not an object", `[1,2]`, `{"_invalid":true}`},
		{"NUL in string", `{"note":"a\u0000b"}`, `{"note":"ab"}`},
	}
	for _, c := range cases {
		if got := string(sanitizeReviewPayload(json.RawMessage(c.in))); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
	str := func(in, key string) string {
		var m map[string]any
		if err := json.Unmarshal(sanitizeReviewPayload(json.RawMessage(in)), &m); err != nil {
			t.Fatalf("output not valid JSON for %s: %v", in, err)
		}
		s, _ := m[key].(string)
		return s
	}
	if got := str(`{"n":"\ud83d"}`, "n"); got != "�" {
		t.Errorf("lone surrogate: got %q", got)
	}
	if got := str("{\"a\":\"a\\\\u0000b\"}", "a"); got != "a\\u0000b" {
		t.Errorf("escaped backslash text corrupted: got %q", got)
	}
	if got := string(sanitizeReviewPayload(json.RawMessage(`null`))); got != `{"_invalid":true}` {
		t.Errorf("null: got %s", got)
	}
	if got := string(sanitizeReviewPayload(nil)); got != `{"_invalid":true}` {
		t.Errorf("empty: got %s", got)
	}
	if got := string(sanitizeReviewPayload(json.RawMessage(`{"x":{"y":["a\u0000b"]}}`))); got != `{"x":{"y":["ab"]}}` {
		t.Errorf("nested NUL: got %s", got)
	}
	big := json.RawMessage(`{"x":"` + strings.Repeat("a", maxReviewPayloadBytes) + `"}`)
	var m map[string]any
	if err := json.Unmarshal(sanitizeReviewPayload(big), &m); err != nil || m["_truncated"] != true {
		t.Fatalf("oversized payload: %v %v", m, err)
	}
}

func TestNormalizeResolveNote(t *testing.T) {
	if _, err := normalizeResolveNote("   "); err != errResolveNote {
		t.Fatal("blank note accepted")
	}
	if _, err := normalizeResolveNote(strings.Repeat("x", maxResolveNoteRunes+1)); err != errResolveNote {
		t.Fatal("501-rune note accepted")
	}
	if n, err := normalizeResolveNote("  refund manual sudah  "); err != nil || n != "refund manual sudah" {
		t.Fatalf("got %q %v", n, err)
	}
}

func TestDecodeReviewReportsSkipsBadlyTypedItems(t *testing.T) {
	raw := []json.RawMessage{
		json.RawMessage(`{"idempotencyKey":"dev:1","type":"order"}`),
		json.RawMessage(`{"idempotencyKey":5}`),
		json.RawMessage(`"not an object"`),
	}
	out := decodeReviewReports(raw)
	if len(out) != 1 || out[0].IdempotencyKey != "dev:1" {
		t.Fatalf("decoded = %+v", out)
	}
}
