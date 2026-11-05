package phone

import (
	"encoding/json"
	"os"
	"testing"
)

// The vector file is shared with the TypeScript twin (packages/sync) and the SQL
// normalize_phone() function (asserted in the CP PostgreSQL gate).
const vectorsPath = "../../../packages/sync/src/__fixtures__/phone-vectors.json"

func TestNormalizeMatchesSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var vs []struct{ Input, Norm string }
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) < 10 {
		t.Fatalf("vector file too small: %d", len(vs))
	}
	for _, v := range vs {
		if got := Normalize(v.Input); got != v.Norm {
			t.Errorf("Normalize(%q) = %q, want %q", v.Input, got, v.Norm)
		}
	}
}

func TestSearchKeys(t *testing.T) {
	cases := []struct{ in, norm, like string }{
		{"081234567890", "081234567890", "081234567890%"},
		{"6281234567890", "081234567890", "081234567890%"},
		{"+62 812-3456-7890", "081234567890", "081234567890%"},
		{"+62 (0)812 3456 7890", "081234567890", "081234567890%"},
		{"81234567890", "081234567890", "%81234567890%"},
		// partial numbers written with a prefix: same prefix search whatever the spelling
		{"0812-34", "", "081234%"},
		{"62812 34", "", "081234%"},
		{"+62 812 34", "", "081234%"},
		{"0812", "", "0812%"},
		// bare digits may sit anywhere in the number
		{"81234", "", "%81234%"},
		{"3456", "", "%3456%"},
		// a foreign number is never rewritten as Indonesian
		{"+65 8123 4567", "6581234567", "6581234567%"},
		{"+65 8123", "", "658123%"},
		{"0065 8123 4567", "6581234567", "6581234567%"},
		// too short to search by digits, or not phone-shaped
		{"08", "", ""},
		{"628", "", ""},
		{"+62", "", ""},
		{"34", "", ""},
		{"", "", ""},
		{"budi", "", ""},
		{"budi 0812", "", ""},
		{"a@b.id", "", ""},
		{"0812x34", "", ""},
	}
	for _, c := range cases {
		norm, like := SearchKeys(c.in)
		if norm != c.norm || like != c.like {
			t.Errorf("SearchKeys(%q) = (%q, %q), want (%q, %q)", c.in, norm, like, c.norm, c.like)
		}
	}
}
