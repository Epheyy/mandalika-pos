package receiptlink

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

var (
	commentRE   = regexp.MustCompile(`(?s)/\*.*?\*/`)
	declRE      = regexp.MustCompile(`(--[a-z0-9-]+)\s*:\s*([^;{}]+);`)
	hexRE       = regexp.MustCompile(`#[0-9a-fA-F]{3,8}\b`)
	wsRE        = regexp.MustCompile(`\s+`)
	rootBlockRE = regexp.MustCompile(`(?s):root\s*\{(.*?)\}`)
)

// cssDecls returns the custom-property declarations of css (comments stripped, whitespace
// collapsed). The first declaration of a name wins.
func cssDecls(css string) map[string]string {
	out := map[string]string{}
	for _, m := range declRE.FindAllStringSubmatch(commentRE.ReplaceAllString(css, ""), -1) {
		if _, seen := out[m[1]]; !seen {
			out[m[1]] = strings.TrimSpace(wsRE.ReplaceAllString(m[2], " "))
		}
	}
	return out
}

func readStyle(t *testing.T) string {
	t.Helper()
	raw, err := pageFS.ReadFile("style.html")
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// TestStyleTokensMatchBackoffice: the page's :root block declares only names that exist in the
// shared token sources, with the same values (drift fails here).
func TestStyleTokensMatchBackoffice(t *testing.T) {
	source := map[string]string{}
	for _, p := range []string{"tokens.css", "materials.css"} {
		raw, err := os.ReadFile("../../../packages/ui-tokens/" + p)
		if err != nil {
			t.Fatal(err)
		}
		for k, v := range cssDecls(string(raw)) {
			if _, ok := source[k]; !ok {
				source[k] = v
			}
		}
	}
	raw, err := os.ReadFile("../../../apps/backoffice/src/index.css")
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range cssDecls(string(raw)) {
		if _, ok := source[k]; !ok {
			source[k] = v
		}
	}

	css := readStyle(t)
	root := rootBlockRE.FindStringSubmatch(css)
	if root == nil {
		t.Fatal("style.html has no :root block")
	}
	page := cssDecls(root[1])
	if len(page) < 10 {
		t.Fatalf("suspiciously few page tokens: %d", len(page))
	}
	for name, val := range page {
		want, ok := source[name]
		if !ok {
			t.Errorf("%s is not defined in packages/ui-tokens or the Backoffice index.css", name)
			continue
		}
		if val != want {
			t.Errorf("%s drifted: page %q, source %q", name, val, want)
		}
	}
}

// TestStyleRules: no hex colour outside :root other than white, no color-mix, no @font-face, no
// external url().
func TestStyleRules(t *testing.T) {
	css := commentRE.ReplaceAllString(readStyle(t), "")
	rest := rootBlockRE.ReplaceAllString(css, "")
	for _, h := range hexRE.FindAllString(rest, -1) {
		if l := strings.ToLower(h); l != "#fff" && l != "#ffffff" {
			t.Errorf("hex colour %s outside :root", h)
		}
	}
	for _, bad := range []string{"color-mix(", "@font-face", "url(", "@import"} {
		if strings.Contains(css, bad) {
			t.Errorf("style must not contain %s", bad)
		}
	}
}
