package auth

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// rightsWrites matches SQL that changes what an access token grants. Such a
// statement must live in an allowed file, where it bumps users.perm_version in
// the same transaction (instant permission revocation).
var rightsWrites = []*regexp.Regexp{
	regexp.MustCompile(`(?is)UPDATE\s+users\s+SET[^;` + "`" + `]*?\b(role|outlet_id|password_hash)\b`),
	regexp.MustCompile(`(?is)INSERT\s+INTO\s+users\b[^;` + "`" + `]*?ON\s+CONFLICT[^;` + "`" + `]*?DO\s+UPDATE\s+SET[^;` + "`" + `]*?\b(role|outlet_id|password_hash)\b`),
	regexp.MustCompile(`(?i)INSERT\s+INTO\s+user_permissions`),
	regexp.MustCompile(`(?i)DELETE\s+FROM\s+user_permissions`),
	regexp.MustCompile(`(?i)DELETE\s+FROM\s+users\b`),
}

// Paths (relative to backend/, slash-separated) allowed to write rights.
var rightsWriteAllowed = []string{
	"internal/auth/store.go",
	"internal/fsmigrate/tables.go",
	"sample_seed.sql",
	"cmd/seed/",
}

func TestRightsWritesOnlyInAllowedFunctions(t *testing.T) {
	root := filepath.Join("..", "..")
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if rel == "internal/db/migrations" || d.Name() == "node_modules" || d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		isSrc := strings.HasSuffix(rel, ".go") && !strings.HasSuffix(rel, "_test.go")
		if !isSrc && !strings.HasSuffix(rel, ".sql") {
			return nil
		}
		scanned++
		for _, a := range rightsWriteAllowed {
			if rel == a || (strings.HasSuffix(a, "/") && strings.HasPrefix(rel, a)) {
				return nil
			}
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, re := range rightsWrites {
			if re.Match(src) {
				t.Errorf("%s writes user rights (%s) outside the allowed files: bump users.perm_version "+
					"in the same transaction and publish, or add the file to rightsWriteAllowed with review", rel, re)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned == 0 {
		t.Fatal("guard scanned nothing")
	}
}
