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
