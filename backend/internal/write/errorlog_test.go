package write

import (
	"strings"
	"testing"
)

func TestRedactErrorLogScrubsEveryFreeTextAndJSONField(t *testing.T) {
	in := ErrorLog{
		Source: "sync", Kind: "dead_letter", Action: "GET /x?token=CANARY-URL",
		Message:     "gagal untuk 081234567890 (budi@example.com) Bearer CANARY.A.B",
		Payload:     []byte(`{"orderId":"o-1","customerPhone":"081234567890","steps":[{"pin":"CANARY-PIN"}]}`),
		Breadcrumbs: []byte(`[{"at":"t","label":"pilih 081234567890"}]`),
	}
	payloadBefore := string(in.Payload)
	out := redactErrorLog(in)
	all := strings.Join([]string{out.Message, out.Action, out.Kind, string(out.Payload), string(out.Breadcrumbs)}, "|")
	for _, canary := range []string{"CANARY", "081234567890", "budi@example.com"} {
		if strings.Contains(all, canary) {
			t.Fatalf("%q survived redaction: %s", canary, all)
		}
	}
	if !strings.Contains(string(out.Payload), "o-1") {
		t.Fatalf("ids must survive: %s", out.Payload)
	}
	if string(in.Payload) != payloadBefore {
		t.Fatal("input payload mutated")
	}
}

func TestRedactErrorLogHandlesBadAndHugeJSON(t *testing.T) {
	bad := redactErrorLog(ErrorLog{Source: "s", Message: "m", Payload: []byte(`{not json`)})
	if string(bad.Payload) != `{"_invalid":true}` {
		t.Fatalf("invalid payload = %s", bad.Payload)
	}
	huge := redactErrorLog(ErrorLog{Source: "s", Message: "m", Payload: []byte(`"` + strings.Repeat("a", maxELJSONBytes) + `"`)})
	if !strings.Contains(string(huge.Payload), `"_truncated":true`) {
		t.Fatalf("huge payload = %.80s", huge.Payload)
	}
	if got := redactErrorLog(ErrorLog{Source: "s", Message: "m"}); got.Payload != nil || got.Breadcrumbs != nil {
		t.Fatal("absent JSON must stay absent")
	}
}

func TestRedactErrorLogStripsNULAndClips(t *testing.T) {
	out := redactErrorLog(ErrorLog{Source: "s", Message: "a\x00b" + strings.Repeat("x", maxELMessageRunes)})
	if strings.Contains(out.Message, "\x00") || len([]rune(out.Message)) != maxELMessageRunes {
		t.Fatalf("message len=%d", len([]rune(out.Message)))
	}
}
