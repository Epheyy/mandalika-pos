package redact

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The vector file is shared with packages/sync/src/redact.test.ts: both
// redactors must produce exactly these outputs.
const vectorsPath = "../../../packages/sync/src/__fixtures__/redact-vectors.json"

func decode(t *testing.T, raw []byte) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return v
}

func canon(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

func TestSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var file struct {
		Vectors []struct {
			Name     string          `json:"name"`
			Tier     string          `json:"tier"`
			Input    json.RawMessage `json:"input"`
			Expected json.RawMessage `json:"expected"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(file.Vectors) < 20 {
		t.Fatalf("expected the full vector set, got %d", len(file.Vectors))
	}
	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			tier := Secrets
			if v.Tier == "logs" {
				tier = Logs
			}
			in := decode(t, v.Input)
			before := canon(t, in)
			got := canon(t, Value(in, tier))
			want := canon(t, decode(t, v.Expected))
			if got != want {
				t.Fatalf("got  %s\nwant %s", got, want)
			}
			if canon(t, in) != before {
				t.Fatal("input was mutated")
			}
		})
	}
}

func TestLongStringsAndTotalCapInLogsTierOnly(t *testing.T) {
	long := strings.Repeat("x", maxStringLogs+500)
	got := Value(map[string]any{"s": long}, Logs).(map[string]any)["s"].(string)
	if !strings.HasSuffix(got, "...[truncated]") || len(got) > maxStringLogs+50 {
		t.Fatalf("logs tier should truncate, len=%d", len(got))
	}
	if Value(map[string]any{"s": long}, Secrets).(map[string]any)["s"].(string) != long {
		t.Fatal("secrets tier must not truncate")
	}
	items := make([]any, 200)
	for i := range items {
		items[i] = map[string]any{"text": strings.Repeat("y", 1000)}
	}
	out, ok := Value(map[string]any{"items": items}, Logs).(map[string]any)
	if !ok || out["_truncated"] != true {
		t.Fatalf("oversize logs payload should be replaced by a marker, got %v", out)
	}
}

func TestDepthCapInLogsTier(t *testing.T) {
	var deep any = map[string]any{"leaf": "x"}
	for i := 0; i < 12; i++ {
		deep = map[string]any{"n": deep}
	}
	if !strings.Contains(canon(t, Value(deep, Logs)), "[MaxDepth]") {
		t.Fatal("expected [MaxDepth]")
	}
}

func TestJSONStripsNULAndRoundTrips(t *testing.T) {
	out, err := JSON([]byte(`{"a\u0000b":"x\u0000y 081234567890","n":1.50,"pin":"1"}`), Logs)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"ab":"xy [REDACTED]","n":1.50,"pin":"[REDACTED]"}` {
		t.Fatalf("unexpected: %s", out)
	}
	if _, err := JSON([]byte(`{bad`), Logs); err == nil {
		t.Fatal("invalid JSON must error")
	}
}
