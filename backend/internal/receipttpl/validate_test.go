package receipttpl

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/mandalika/pos-backend/internal/api"
)

type validateCase struct {
	Name     string `json:"name"`
	Template struct {
		Name       string             `json:"name"`
		PaperWidth int                `json:"paperWidth"`
		Blocks     []api.ReceiptBlock `json:"blocks"`
	} `json:"template"`
	Valid  bool   `json:"valid"`
	Code   string `json:"code"`
	TSOnly bool   `json:"tsOnly"`
}

func loadCases(t *testing.T) []validateCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []validateCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("only %d cases", len(cases))
	}
	return cases
}

func TestValidateCases(t *testing.T) {
	for _, c := range loadCases(t) {
		if c.TSOnly {
			// The generated type has no such field, so the JSON decode drops it before Validate sees it.
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			err := Validate(c.Template.Name, c.Template.PaperWidth, c.Template.Blocks)
			if c.Valid {
				if err != nil {
					t.Fatalf("want valid, got %v", err)
				}
				return
			}
			var ve *Error
			if !errors.As(err, &ve) {
				t.Fatalf("want %s, got %v", c.Code, err)
			}
			if ve.Code != c.Code {
				t.Fatalf("want first issue %s, got %s (%s)", c.Code, ve.Code, ve.Message)
			}
			if ve.Message == "" {
				t.Fatal("empty message")
			}
		})
	}
}

func TestIssuesFirstEqualsValidate(t *testing.T) {
	for _, c := range loadCases(t) {
		is := Issues(c.Template.Name, c.Template.PaperWidth, c.Template.Blocks)
		err := Validate(c.Template.Name, c.Template.PaperWidth, c.Template.Blocks)
		if (len(is) == 0) != (err == nil) {
			t.Fatalf("%s: Issues and Validate disagree", c.Name)
		}
	}
}
