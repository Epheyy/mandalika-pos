package redact

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// wantVectors is the exact size of the shared vector file: a silently shrinking file fails here.
const wantVectors = 62

var templateRE = regexp.MustCompile(`\{\{(\d+)\*([^}]*)\}\}`)

// expand replaces {{N*unit}} templates in every string, like the TS harness.
func expand(v any) any {
	switch x := v.(type) {
	case string:
		return templateRE.ReplaceAllStringFunc(x, func(m string) string {
			g := templateRE.FindStringSubmatch(m)
			n, _ := strconv.Atoi(g[1])
			return strings.Repeat(g[2], n)
		})
	case []any:
		for i := range x {
			x[i] = expand(x[i])
		}
	case map[string]any:
		for k := range x {
			x[k] = expand(x[k])
		}
	}
	return v
}

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
	if len(file.Vectors) != wantVectors {
		t.Fatalf("shared vector file holds %d vectors, this test expects %d (update wantVectors with the file)", len(file.Vectors), wantVectors)
	}
	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			tier := Secrets
			if v.Tier == "logs" {
				tier = Logs
			}
			in := expand(decode(t, v.Input))
			before := canon(t, in)
			out := Value(in, tier)
			expected := expand(decode(t, v.Expected))
			if m, ok := expected.(map[string]any); ok && m["_truncated"] == true {
				om, isMap := out.(map[string]any)
				n, _ := om["bytes"].(int)
				if !isMap || om["_truncated"] != true || n <= maxTotalLogs {
					t.Fatalf("expected a truncation marker over the cap, got %v", out)
				}
				return
			}
			got := canon(t, out)
			want := canon(t, expected)
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

func TestWideAdversarialPayloadStaysCheap(t *testing.T) {
	wide := make(map[string]any)
	for i := 0; i < 12000; i++ {
		wide["k"+strconv.Itoa(i)] = "v"
	}
	start := time.Now()
	out := Value(wide, Logs)
	if d := time.Since(start); d > 250*time.Millisecond {
		t.Fatalf("wide payload took %v", d)
	}
	if m, ok := out.(map[string]any); !ok || m["_truncated"] != true {
		t.Fatal("a payload past the node budget must collapse to a marker")
	}
	allocs := testing.AllocsPerRun(3, func() { Value(wide, Logs) })
	if allocs > 100000 {
		t.Fatalf("too many allocations for a capped walk: %.0f", allocs)
	}
}

func TestAdversarialStringsAreLinearEnough(t *testing.T) {
	cases := map[string]string{
		"email":  strings.Repeat("a", 32*1024),
		"jwt":    "eyJ" + strings.Repeat("a", 32*1024),
		"phone":  strings.Repeat("0 8 ", 8192),
		"json1":  strings.Repeat(`"password":`, 3000),
		"json2":  strings.Repeat(`"password":"`, 3000),
		"json3":  strings.Repeat(`\"password\":\"`, 2000),
		"phone2": strings.Repeat("0812 ", 6000),
		"jwts":   strings.Repeat("eyJ", 10000),
	}
	for name, in := range cases {
		start := time.Now()
		String(in, Logs)
		if d := time.Since(start); d > 100*time.Millisecond {
			t.Errorf("%s: %v", name, d)
		}
	}
}

func BenchmarkWideLogsPayload(b *testing.B) {
	wide := make(map[string]any)
	for i := 0; i < 12000; i++ {
		wide["k"+strconv.Itoa(i)] = "v"
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		Value(wide, Logs)
	}
}

func TestStackHelperUsesLargerCap(t *testing.T) {
	got := Stack(strings.Repeat("a", 5000))
	if len([]rune(got)) != maxStackLogs+len(truncatedSuffix) {
		t.Fatalf("stack len = %d", len([]rune(got)))
	}
}

func TestScannersStayLinearInBothTiers(t *testing.T) {
	cases := []string{
		strings.Repeat("0812 ", 13000),
		strings.Repeat("1", 65536),
		strings.Repeat("0 8 ", 16000),
		strings.Repeat("08-1.2 3/4-5.6 7", 4000),
		strings.Repeat("0812", 16000),
		strings.Repeat("62 8", 16000),
		strings.Repeat("eyJ", 43000),
		strings.Repeat("eyJa.", 26000),
		strings.Repeat(`"token":{`, 8000),
	}
	for _, tier := range []Tier{Logs, Secrets} {
		for i, c := range cases {
			start := time.Now()
			String(c, tier)
			if d := time.Since(start); d > 250*time.Millisecond {
				t.Errorf("tier %d case %d took %v", tier, i, d)
			}
		}
	}
}

// Wall-clock caps are noisy on shared CI hardware, so linearity is checked as a ratio:
// 8x the input must cost less than 16x the time (quadratic behaviour would cost ~64x).
func TestScannersScaleLinearly(t *testing.T) {
	best := func(in string, tier Tier) time.Duration {
		min := time.Hour
		for i := 0; i < 3; i++ {
			start := time.Now()
			String(in, tier)
			if d := time.Since(start); d < min {
				min = d
			}
		}
		return min
	}
	for _, unit := range []string{"eyJ", "eyJa.", "0812 ", `"token":{`, "62 8"} {
		for _, tier := range []Tier{Logs, Secrets} {
			small := best(strings.Repeat(unit, 16*1024/len(unit)), tier)
			big := best(strings.Repeat(unit, 128*1024/len(unit)), tier)
			base := small
			if base < 2*time.Millisecond {
				base = 2 * time.Millisecond
			}
			if big > 16*base {
				t.Errorf("unit %q tier %d: 16 KB took %v but 128 KB took %v", unit, tier, small, big)
			}
		}
	}
}
