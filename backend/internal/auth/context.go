package auth

import (
	"context"

	"github.com/mandalika/pos-backend/internal/coverage"
)

type ctxKey string

const (
	CtxUserID   ctxKey = "uid"
	CtxRole     ctxKey = "role"
	CtxOutletID ctxKey = "outlet"
	CtxPerms    ctxKey = "perms"
	// CtxCoverage holds the coverage.Coverage the token grants.
	CtxCoverage ctxKey = "coverage"
)

// CoverageFrom returns the request's outlet coverage; empty (covers nothing) when unset.
func CoverageFrom(ctx context.Context) coverage.Coverage {
	c, _ := ctx.Value(CtxCoverage).(coverage.Coverage)
	return c
}

// CatalogueWide reports whether the caller may change the shared catalogue: an admin, or a
// manager set to "Semua Outlet". A cashier is never catalogue-wide, whatever its coverage says.
func CatalogueWide(ctx context.Context) bool {
	role, _ := ctx.Value(CtxRole).(string)
	switch role {
	case "admin":
		return true
	case "manager":
		return CoverageFrom(ctx).All
	}
	return false
}
