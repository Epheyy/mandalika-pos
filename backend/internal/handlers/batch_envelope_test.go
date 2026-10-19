package handlers

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	syncpkg "github.com/mandalika/pos-backend/internal/sync"
)

const envelopeValidItem = `{"type":"shift_open","idempotencyKey":"original-key","payload":{"startingCash":0}}`

// Raw HTTP strings are deliberate: normal map marshaling would erase duplicates.
// The first five cases port the review's evidence, without its replacement stubs.
func invalidBatchEnvelopes() []struct{ name, raw string } {
	cases := []struct{ name, raw string }{
		{"trailing junk", `{"items":[` + envelopeValidItem + `]} junk`},
		{"second object", `{"items":[` + envelopeValidItem + `]} {}`},
		{"duplicate Items alias", `{"items":[{"type":"shift_open","idempotencyKey":"discarded-key","payload":{"startingCash":null}}],"Items":[` + envelopeValidItem + `]}`},
		{"duplicate payload", `{"items":[{"type":"shift_open","idempotencyKey":"original-key","payload":{"startingCash":null},"payload":{"startingCash":0}}]}`},
		{"duplicate envelope", `{"items":[{"type":"shift_open","idempotencyKey":"original-key","payload":{"startingCash":0},"envelope":{"v":1},"ENVELOPE":{"v":1}}]}`},
		{"duplicate type", `{"items":[{"type":"shift_close","type":"shift_open","idempotencyKey":"original-key","payload":{"startingCash":0}}]}`},
	}
	for _, suffix := range []string{` {`, ` 1`, ` []`, ` null`} {
		cases = append(cases, struct{ name, raw string }{"tail" + suffix, `{"items":[` + envelopeValidItem + `]}` + suffix})
	}
	for _, key := range []string{`items`, `ITEMS`, `\u0069tems`} {
		cases = append(cases, struct{ name, raw string }{"repeat " + key, `{"items":[` + envelopeValidItem + `],"` + key + `":[` + envelopeValidItem + `]}`})
	}
	for _, field := range []string{"type", "idempotencyKey", "payload"} {
		value := map[string]string{"type": `"shift_open"`, "idempotencyKey": `"original-key"`, "payload": `{"startingCash":0}`}[field]
		for _, alias := range []string{field, strings.ToUpper(field), fmt.Sprintf(`\u%04x%s`, field[0], field[1:])} {
			duplicate := strings.TrimSuffix(envelopeValidItem, "}") + `,"` + alias + `":` + value + `}`
			cases = append(cases, struct{ name, raw string }{"later item repeat " + alias, `{"items":[` + envelopeValidItem + `,` + duplicate + `]}`})
		}
	}
	for _, raw := range []string{"", "null", "[]", "1", `{"items":{}}`, `{"items":[null]}`, `{"items":[3]}`, `{"items":[` + envelopeValidItem,
		`{"items":[{"type":"shift_open","payload":{"startingCash":0}}]}`,
		`{"items":[{"type":"shift_open","idempotencyKey":null,"payload":{"startingCash":0}}]}`,
		`{"items":[{"type":"shift_open","idempotencyKey":" ","payload":{"startingCash":0}}]}`,
		`{"items":[{"type":1,"idempotencyKey":"key"}]}`,
		`{"items":[{"type":"shift_open","idempotencyKey":1}]}`} {
		cases = append(cases, struct{ name, raw string }{"shape " + raw, raw})
	}
	return cases
}

func TestBatchEnvelopeRejectsBeforeDispatch(t *testing.T) {
	for _, tc := range invalidBatchEnvelopes() {
		t.Run(tc.name, func(t *testing.T) {
			calls, resolves := 0, 0
			r := httptest.NewRequest("POST", "/sync/batch", strings.NewReader(tc.raw))
			w := httptest.NewRecorder()
			(&Handlers{}).syncBatch(w, r, func(*http.Request) (callerID, error) { resolves++; return callerID{outletID: "synthetic"}, nil }, func(context.Context, syncpkg.Caller, []syncpkg.BatchItem) (syncpkg.BatchResult, error) {
				calls++
				return syncpkg.BatchResult{}, nil
			})
			if w.Code != 400 || calls != 0 || resolves != 0 {
				t.Fatalf("raw envelope reached processing: status=%d dispatch=%d caller=%d", w.Code, calls, resolves)
			}
		})
	}
}

type failingBatchReader struct{}

func (failingBatchReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestBatchEnvelopeCompatibility(t *testing.T) {
	for _, raw := range []string{`{}`, `{"items":null}`, `{"items":[]}`} {
		items, err := decodeBatchEnvelope(strings.NewReader(raw))
		if err != nil || len(items) != 0 {
			t.Fatalf("empty compatibility %q: %+v %v", raw, items, err)
		}
	}
	payload := `{ "startingCash":0, "STARTINGCASH":1, "evidence":"original" }`
	raw := `{"future":{"items":null},"future":true,"ItEmS":[{"TYPE":"shift_open","IDEMPOTENCYKEY":" original ","PAYLOAD":` + payload + `,"actor":"forged"}]} ` + "\n\t"
	items, err := decodeBatchEnvelope(strings.NewReader(raw))
	if err != nil || len(items) != 1 || items[0].Type != "shift_open" || items[0].IdempotencyKey != " original " || string(items[0].Payload) != payload {
		t.Fatalf("compatibility: %+v %v", items, err)
	}
	// Missing/unknown type and missing/null payload remain unambiguous command-level
	// failures; no identity is fabricated. Payload semantic validation stays per item.
	for _, raw := range []string{`{"items":[{"idempotencyKey":"known"}]}`, `{"items":[{"type":null,"idempotencyKey":"known","payload":null}]}`, `{"items":[{"type":"future","idempotencyKey":"known","payload":[]} ]}`} {
		items, err := decodeBatchEnvelope(strings.NewReader(raw))
		if err != nil || len(items) != 1 || items[0].IdempotencyKey != "known" {
			t.Fatal(raw, err)
		}
	}
	if _, err := decodeBatchEnvelope(failingBatchReader{}); err == nil {
		t.Fatal("unreadable body accepted")
	}
}

// The capture-time envelope (A04) is read as an opaque sibling of payload: kept
// verbatim, JSON null and absence both mean "legacy item", and neither the
// payload bytes nor the idempotency key are affected by it.
func TestBatchEnvelopeCarriesCaptureEnvelope(t *testing.T) {
	env := `{ "v":1, "outletId":"o", "userId":"u", "deviceId":"d", "capturedAt":"2026-10-11T00:00:00Z" }`
	payload := `{"startingCash":0}`
	raw := `{"items":[` +
		`{"type":"shift_open","idempotencyKey":"d:1","payload":` + payload + `,"ENVELOPE":` + env + `},` +
		`{"type":"shift_open","idempotencyKey":"d:2","payload":` + payload + `,"envelope":null},` +
		`{"type":"shift_open","idempotencyKey":"d:3","payload":` + payload + `}]}`
	items, err := decodeBatchEnvelope(strings.NewReader(raw))
	if err != nil || len(items) != 3 {
		t.Fatalf("decode: %+v %v", items, err)
	}
	if string(items[0].Envelope) != env || string(items[0].Payload) != payload || items[0].IdempotencyKey != "d:1" {
		t.Fatalf("envelope item: %+v", items[0])
	}
	if items[1].Envelope != nil || items[2].Envelope != nil {
		t.Fatalf("null/absent envelope must be nil: %q %q", items[1].Envelope, items[2].Envelope)
	}
}

// Attribution authority (A04): the caller handed to the sync engine carries the
// role and stored outlet from the users row, and the raw envelope rides on the item.
func TestSyncBatchPassesStoredIdentityAndEnvelope(t *testing.T) {
	raw := `{"items":[{"type":"shift_open","idempotencyKey":"d:1","payload":{"startingCash":0},"envelope":{"v":1}}]}`
	var gotCaller syncpkg.Caller
	var gotItems []syncpkg.BatchItem
	w := httptest.NewRecorder()
	(&Handlers{}).syncBatch(w, httptest.NewRequest("POST", "/sync/batch", strings.NewReader(raw)),
		func(*http.Request) (callerID, error) {
			return callerID{outletID: "hdr", userID: "u", role: "admin", homeOutletID: "home"}, nil
		},
		func(_ context.Context, c syncpkg.Caller, items []syncpkg.BatchItem) (syncpkg.BatchResult, error) {
			gotCaller, gotItems = c, items
			return syncpkg.BatchResult{}, nil
		})
	if w.Code != 200 || gotCaller.Role != "admin" || gotCaller.HomeOutletID != "home" || gotCaller.OutletID != "hdr" ||
		len(gotItems) != 1 || string(gotItems[0].Envelope) != `{"v":1}` {
		t.Fatalf("status=%d caller=%+v items=%+v", w.Code, gotCaller, gotItems)
	}
}

// A29: the server bounds both the body size and the array length before any
// per-item decode or dispatch. Old clients (APK 2.1) fall back to isolation on 413.
func runBatchCap(t *testing.T, body string) (code, calls, resolves int) {
	t.Helper()
	w := httptest.NewRecorder()
	(&Handlers{}).syncBatch(w, httptest.NewRequest("POST", "/sync/batch", strings.NewReader(body)),
		func(*http.Request) (callerID, error) { resolves++; return callerID{outletID: "synthetic"}, nil },
		func(context.Context, syncpkg.Caller, []syncpkg.BatchItem) (syncpkg.BatchResult, error) {
			calls++
			return syncpkg.BatchResult{}, nil
		})
	return w.Code, calls, resolves
}

func batchBodyWithItems(n int) string {
	items := make([]string, n)
	for i := range items {
		items[i] = fmt.Sprintf(`{"type":"shift_open","idempotencyKey":"k-%d","payload":{"startingCash":0}}`, i)
	}
	return `{"items":[` + strings.Join(items, ",") + `]}`
}

func TestSyncBatchRejectsTooManyItems(t *testing.T) {
	code, calls, resolves := runBatchCap(t, batchBodyWithItems(maxSyncBatchItems+1))
	if code != http.StatusRequestEntityTooLarge || calls != 0 || resolves != 0 {
		t.Fatalf("201 items: status=%d dispatch=%d caller=%d", code, calls, resolves)
	}
}

func TestSyncBatchAcceptsExactlyMaxItems(t *testing.T) {
	code, calls, _ := runBatchCap(t, batchBodyWithItems(maxSyncBatchItems))
	if code != http.StatusOK || calls != 1 {
		t.Fatalf("200 items: status=%d dispatch=%d", code, calls)
	}
}

func TestSyncBatchRejectsOversizedBody(t *testing.T) {
	big := `{"items":[{"type":"shift_open","idempotencyKey":"k","payload":{"pad":"` +
		strings.Repeat("x", syncBatchBodyLimit) + `"}}]}`
	code, calls, resolves := runBatchCap(t, big)
	if code != http.StatusRequestEntityTooLarge || calls != 0 || resolves != 0 {
		t.Fatalf("oversized body: status=%d dispatch=%d caller=%d", code, calls, resolves)
	}
}
