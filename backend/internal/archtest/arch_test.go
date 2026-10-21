// Package archtest enforces the backend import direction (ERP review §9).
// Production imports only (test files may cross layers). Stdlib only: go/build
// honours build constraints and needs no subprocess or new module dependency.
package archtest

import (
	"go/build"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const mod = "github.com/mandalika/pos-backend/internal/"

type tier int

const (
	leaf      tier = iota // pure: stdlib + non-pgx third party + other leaves
	infra                 // db, ledger, cache, config, observability
	platform              // auth, middleware
	domain                // read, write, service
	adapter               // integration/erp
	transport             // handlers, sync
	root                  // server (composition root)
	tool                  // offline tools; may not reach domain/transport/root
)

var tiers = map[string]tier{
	"api": leaf, "apperr": leaf, "bizday": leaf, "phone": leaf, "promotionkeys": leaf,
	"redact": leaf, "ota": leaf, "csvimport": leaf, "uploads": leaf, "httpx": leaf,
	"clientip": leaf, "rules": leaf,
	"db": infra, "ledger": infra, "cache": infra, "config": infra, "observability": infra,
	"auth": platform, "middleware": platform,
	"read": domain, "write": domain, "service": domain,
	"integration/erp": adapter, "integration/erp/erpapi": leaf,
	"handlers": transport, "sync": transport,
	"server":  root,
	"codegen": tool, "fsmigrate": tool, "promotionpreflight": tool,
}

// allowed internal targets per package (beyond leaves, which everyone may import).
var allowed = map[string][]string{
	"db":              {},
	"ledger":          {"db"},
	"read":            {"db", "ledger"},
	"write":           {"db", "ledger"},
	"service":         {"db", "ledger"},
	"integration/erp": {"db", "ledger"},
	"sync":            {"db", "ledger", "read", "write", "service", "integration/erp", "auth", "cache"},
	"handlers":        {"db", "ledger", "read", "write", "service", "sync", "integration/erp", "auth", "cache", "config", "middleware"},
}

// strict packages may import only leaves plus their allowed list.
var strict = map[string]bool{"db": true, "ledger": true}

const (
	pgx     = "github.com/jackc/pgx/v5"
	pgxpool = "github.com/jackc/pgx/v5/pgxpool"
	pgconn  = "github.com/jackc/pgx/v5/pgconn"
)

// knownViolations is the ratchet: edges that exist at HEAD 3a2dde5. A fix must
// delete its line (the test fails if a listed edge no longer exists).
var knownViolations = map[string]string{
	"service -> write":      "write.Insert*/BumpStockSeq/ErrBusy/RewardGrantRow in createOrderCore/RefundTx",
	"handlers -> " + pgconn: "handlers/writes.go:1126 refundHTTPError",
	"sync -> " + pgx:        "pgx.Tx in sync.go:55,383,394 + attribute.go poolLookup",
	"sync -> " + pgxpool:    "sync.go:26,105 Engine.Pool",
	"sync -> " + pgconn:     "classify.go:45,54,80",
}

func isPgx(p string) bool { return p == pgx || strings.HasPrefix(p, pgx+"/") }

func violations(pkg string, imports []string) []string {
	t, ok := tiers[pkg]
	if !ok {
		return []string{pkg + " -> ? (unclassified package: add it to tiers)"}
	}
	var bad []string
	ok2 := map[string]bool{}
	for _, a := range allowed[pkg] {
		ok2[a] = true
	}
	for _, imp := range imports {
		if strings.HasPrefix(imp, mod) {
			dep := strings.TrimPrefix(imp, mod)
			dt, known := tiers[dep]
			switch {
			case !known:
				bad = append(bad, pkg+" -> "+dep)
			case t == root, dt == leaf && dep != pkg, ok2[dep]:
			case t == tool && dt < domain:
			case (t == infra || t == platform) && dt <= platform && !strict[pkg]:
			default:
				bad = append(bad, pkg+" -> "+dep)
			}
			continue
		}
		if !isPgx(imp) {
			continue
		}
		switch {
		case t == leaf:
			bad = append(bad, pkg+" -> "+imp)
		case t == transport && (imp == pgconn || pkg == "sync"):
			bad = append(bad, pkg+" -> "+imp)
		}
	}
	return bad
}

func TestImportDirection(t *testing.T) {
	seen := map[string]bool{}
	err := filepath.WalkDir("..", func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() || d.Name() == "testdata" {
			return err
		}
		bp, err := build.ImportDir(p, 0)
		if err != nil || len(bp.GoFiles) == 0 {
			return nil // no production Go files (archtest, dependencycheck, migrations)
		}
		rel, _ := filepath.Rel("..", p)
		for _, v := range violations(filepath.ToSlash(rel), bp.Imports) {
			seen[v] = true
			if _, known := knownViolations[v]; !known {
				t.Errorf("forbidden import: %s", v)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var stale []string
	for k := range knownViolations {
		if !seen[k] {
			stale = append(stale, k)
		}
	}
	sort.Strings(stale)
	for _, k := range stale {
		t.Errorf("knownViolations entry %q no longer occurs: delete it (ratchet)", k)
	}
}
