package auth

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// rightsWrites matches SQL that changes what an access token grants. Such a
// statement must live in an allowed file, where it bumps users.perm_version in
// the same transaction (instant permission revocation). It tolerates an optional
// schema, quoted identifiers, ONLY, and an alias.
var rightsWrites = func() []*regexp.Regexp {
	const (
		tbl   = `(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?%s"?`
		tail  = "[^;`]"
		alias = `(?:\s+(?:AS\s+)?[a-z_]\w*)?`
	)
	users := fmt.Sprintf(tbl, "users")
	perms := fmt.Sprintf(tbl, "user_permissions")
	const wb = `\b` // word boundary: users_archive is not users
	cols := wb + `(?:role|outlet_id|password_hash)` + wb
	return []*regexp.Regexp{
		regexp.MustCompile(`(?is)UPDATE\s+` + users + alias + `\s+SET` + tail + `*?` + cols),
		regexp.MustCompile(`(?is)INSERT\s+INTO\s+` + users + alias + wb + tail + `*?ON\s+CONFLICT` + tail + `*?DO\s+UPDATE\s+SET` + tail + `*?` + cols),
		regexp.MustCompile(`(?is)MERGE\s+INTO\s+` + users + wb),
		regexp.MustCompile(`(?is)INSERT\s+INTO\s+` + perms + wb),
		regexp.MustCompile(`(?is)UPDATE\s+` + perms + wb),
		regexp.MustCompile(`(?is)DELETE\s+FROM\s+` + perms + wb),
		regexp.MustCompile(`(?is)DELETE\s+FROM\s+` + users + wb),
	}
}()

func writesRights(sql string) bool {
	for _, re := range rightsWrites {
		if re.MatchString(sql) {
			return true
		}
	}
	return false
}

func TestRightsWriteRegexFixtures(t *testing.T) {
	positive := []string{
		`UPDATE users SET role=$1 WHERE id=$2`,
		`update public.users set outlet_id=$1`,
		`UPDATE "users" SET password_hash=$1`,
		`UPDATE ONLY users SET role='admin'`,
		`UPDATE users u SET role=$1 WHERE u.id=$2`,
		`UPDATE users AS u SET outlet_id=NULL`,
		`UPDATE user_permissions SET permission='x'`,
		`UPDATE public."user_permissions" SET permission='x'`,
		`DELETE FROM public.users WHERE id=$1`,
		`DELETE FROM "users" WHERE id=$1`,
		`DELETE FROM user_permissions WHERE user_id=$1`,
		`INSERT INTO user_permissions (user_id, permission) VALUES ($1,$2)`,
		`MERGE INTO users USING src ON users.id = src.id WHEN MATCHED THEN UPDATE SET role = src.role`,
		`INSERT INTO users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role`,
		`INSERT INTO public.users u (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET outlet_id=EXCLUDED.outlet_id`,
	}
	negative := []string{
		`UPDATE users SET display_name=$1 WHERE id=$2`,
		`UPDATE users SET photo_url=$1, receive_pin_hash=NULL WHERE id=$2`,
		`SELECT role, outlet_id FROM users WHERE id=$1 FOR NO KEY UPDATE`,
		`SELECT permission FROM user_permissions WHERE user_id=$1`,
		`UPDATE shifts SET status='closed' WHERE cashier_id=$1`,
		`DELETE FROM refresh_tokens WHERE user_id=$1`,
		`INSERT INTO users (id,email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
		`UPDATE users_archive SET role=$1`,
	}
	for _, q := range positive {
		if !writesRights(q) {
			t.Errorf("must be flagged: %s", q)
		}
	}
	for _, q := range negative {
		if writesRights(q) {
			t.Errorf("must not be flagged: %s", q)
		}
	}
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
		if writesRights(string(src)) {
			t.Errorf("%s writes user rights outside the allowed files: bump users.perm_version "+
				"in the same transaction and publish, or add the file to rightsWriteAllowed with review", rel)
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
