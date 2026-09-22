package promotionkeys

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedOverlapContract(t *testing.T) {
	var cases []struct {
		Name        string
		Left, Right []string
		Overlap     bool
	}
	raw, err := os.ReadFile("testdata/overlap.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if SetsOverlap(c.Left, c.Right) != c.Overlap || GroupsOverlap([][]string{c.Left, c.Right}) != c.Overlap || SetsOverlap(c.Right, c.Left) != c.Overlap {
				t.Fatal("shared semantic contract mismatch")
			}
		})
	}
	if GroupsOverlap([][]string{{"P", "P|M"}, {"Q"}}) {
		t.Fatal("within-group alternatives are not cross-group overlap")
	}
}
