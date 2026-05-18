package fsmigrate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestIDDeterministicAndDistinct(t *testing.T) {
	a := id("customers", "abc")
	if a != id("customers", "abc") {
		t.Fatal("id not deterministic for same input")
	}
	if a == id("orders", "abc") {
		t.Fatal("id collides across collections")
	}
	if a == id("customers", "abd") {
		t.Fatal("id collides across doc ids")
	}
}

func TestFKNilOnEmpty(t *testing.T) {
	if fk("customers", "") != nil {
		t.Fatal("empty ref must be NULL")
	}
	if fk("customers", nil) != nil {
		t.Fatal("nil ref must be NULL")
	}
	got := fk("customers", "x")
	if got == nil || *got != id("customers", "x") {
		t.Fatal("non-empty ref must resolve to deterministic id")
	}
}

func TestNumCoercion(t *testing.T) {
	d := doc{"a": json.Number("12.5"), "b": "3.0", "c": float64(7), "d": "x"}
	if num(d, "a") != 12.5 || num(d, "b") != 3.0 || num(d, "c") != 7 {
		t.Fatalf("num coercion wrong: %v %v %v", num(d, "a"), num(d, "b"), num(d, "c"))
	}
	if num(d, "missing") != 0 {
		t.Fatal("missing key must be 0")
	}
}

func TestTimestampShapes(t *testing.T) {
	// epoch number
	if v := ts(doc{"t": json.Number("1700000000")}, "t"); v == nil {
		t.Fatal("epoch number should produce a timestamp")
	}
	// Firestore {_seconds}
	if v := ts(doc{"t": map[string]any{"_seconds": json.Number("1700000000")}}, "t"); v == nil {
		t.Fatal("{_seconds} should produce a timestamp")
	}
	// RFC3339 string passes through
	if v := ts(doc{"t": "2024-01-02T03:04:05Z"}, "t"); v != "2024-01-02T03:04:05Z" {
		t.Fatalf("ISO string should pass through, got %v", v)
	}
	// absent → nil (column default/NULL)
	if ts(doc{}, "t") != nil {
		t.Fatal("absent timestamp must be nil")
	}
}

func TestStrSliceAndJSONB(t *testing.T) {
	d := doc{"p": []any{"a", "b", 3}, "j": []any{1, 2}}
	got := strSlice(d, "p")
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("strSlice should keep only strings, got %v", got)
	}
	if jsonbOrNil(d, "missing") != nil {
		t.Fatal("missing jsonb must be nil")
	}
	if jsonbOrNil(d, "j") != "[1,2]" {
		t.Fatalf("jsonb marshal wrong: %v", jsonbOrNil(d, "j"))
	}
}

func TestLoadParsesExport(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "export.json")
	body := `{"customers":[{"id":"c1","name":"A","phone":"1","totalSpent":1500}],
	          "appSettings":{"taxEnabled":true}}`
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	e, err := Load(p)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(e.Customers) != 1 || e.Customers[0]["name"] != "A" {
		t.Fatalf("customers not parsed: %+v", e.Customers)
	}
	// UseNumber: totalSpent must be json.Number, num() must still coerce it.
	if num(e.Customers[0], "totalSpent") != 1500 {
		t.Fatal("numeric field lost precision/type through Load")
	}
	if !boolv(e.AppSettings, "taxEnabled") {
		t.Fatal("singleton appSettings not parsed")
	}
}
