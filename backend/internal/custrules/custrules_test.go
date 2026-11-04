package custrules

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

const emailVectors = "../../../packages/types/src/__fixtures__/email-vectors.json"

func TestCheckEmailMatchesSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(emailVectors)
	if err != nil {
		t.Fatal(err)
	}
	var vs []struct {
		Input string
		Ok    bool
	}
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		err := CheckEmail(v.Input)
		if (err == nil) != v.Ok {
			t.Errorf("CheckEmail(%q) err=%v, want ok=%v", v.Input, err, v.Ok)
		}
	}
	if err := CheckEmail(strings.Repeat("a", 250) + "@b.co"); !errors.Is(err, ErrEmailInvalid) {
		t.Errorf("over-long email should be invalid, got %v", err)
	}
}

func TestCheckPhone(t *testing.T) {
	cases := []struct {
		in   string
		want error
	}{
		{"", ErrPhoneRequired},
		{"   ", ErrPhoneRequired},
		{"abc123", ErrPhoneInvalid},
		{"12345", ErrPhoneInvalid},
		{"0812-3456-7890", nil},
		{"+65 8123 4567", nil},
		{"+1 (415) 555-2671", nil},
	}
	for _, c := range cases {
		if got := CheckPhone(c.in); !errors.Is(got, c.want) {
			t.Errorf("CheckPhone(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
