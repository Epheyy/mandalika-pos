// Package coverage answers "which outlets may this user act on?". It is an infra-tier
// package (it only imports pgx, no other internal package) so auth, middleware, scope and sync
// can all share one rule.
package coverage

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Coverage is the set of outlets a user covers: every outlet (All) or an explicit list.
type Coverage struct {
	All       bool
	OutletIDs []string
}

// Covers reports whether the outlet is covered. An empty id is never covered.
func (c Coverage) Covers(outletID string) bool {
	if outletID == "" {
		return false
	}
	if c.All {
		return true
	}
	for _, id := range c.OutletIDs {
		if strings.EqualFold(id, outletID) {
			return true
		}
	}
	return false
}

// merge returns home first, then extras, deduped case-insensitively; an empty home is dropped.
// Never nil.
func merge(home string, extras []string) []string {
	out := []string{}
	add := func(id string) {
		if id == "" {
			return
		}
		for _, have := range out {
			if strings.EqualFold(have, id) {
				return
			}
		}
		out = append(out, id)
	}
	add(home)
	for _, e := range extras {
		add(e)
	}
	return out
}

// Of derives coverage from a user's role, home outlet, extra outlets and all-outlets flag.
func Of(role, home string, extras []string, allOutlets bool) Coverage {
	switch role {
	case "admin":
		return Coverage{All: true}
	case "manager":
		if allOutlets {
			return Coverage{All: true}
		}
		if home == "" {
			// No home outlet and not all-outlets: unassigned, whatever user_outlets holds.
			return Coverage{OutletIDs: []string{}}
		}
		return Coverage{OutletIDs: merge(home, extras)}
	case "cashier":
		return Coverage{OutletIDs: merge(home, nil)}
	}
	return Coverage{}
}

// SelectCols is appended to a `SELECT ... FROM users u` and scans as (bool, []string).
const SelectCols = "u.all_outlets, ARRAY(SELECT uo.outlet_id::text FROM user_outlets uo WHERE uo.user_id = u.id ORDER BY uo.outlet_id)"

// Querier is the read surface shared by a pool and a transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Load reads a user's role, home outlet and coverage. An unknown user wraps pgx.ErrNoRows.
func Load(ctx context.Context, q Querier, userID string) (role, home string, cov Coverage, err error) {
	var homeP *string
	var all bool
	var extras []string
	err = q.QueryRow(ctx,
		`SELECT u.role, u.outlet_id::text, `+SelectCols+` FROM users u WHERE u.id = $1`, userID,
	).Scan(&role, &homeP, &all, &extras)
	if err != nil {
		return "", "", Coverage{}, fmt.Errorf("load coverage: %w", err)
	}
	if homeP != nil {
		home = *homeP
	}
	return role, home, Of(role, home, extras, all), nil
}

// Guard is a shift-open check (service.OpenShiftInput.Authorize): it re-reads the user's
// coverage inside tx and returns refusal when the user no longer covers outletID or no longer
// exists. Run it while holding the user row lock, so an admin's coverage change, home move or
// delete is either already committed and seen, or waits for this transaction.
func Guard(userID, outletID string, refusal error) func(context.Context, pgx.Tx) error {
	return func(ctx context.Context, tx pgx.Tx) error {
		_, _, cov, err := Load(ctx, tx, userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return refusal
		}
		if err != nil {
			return err
		}
		if !cov.Covers(outletID) {
			return refusal
		}
		return nil
	}
}

// Caller is who reads or edits an outlet-scoped list on behalf of a user: Admin is role
// admin, Cov is the user's coverage (Cov.All for "Semua Outlet" managers).
type Caller struct {
	UserID string
	Admin  bool
	Cov    Coverage
}

// Sees reports whether the caller may act on the outlet.
func (c Caller) Sees(outletID string) bool { return c.Admin || c.Cov.Covers(outletID) }

// AllScope is true when the caller is not limited to a list of outlets.
func (c Caller) AllScope() bool { return c.Admin || c.Cov.All }

// Meets reports whether a user's coverage shares an outlet with the caller's; admin and
// Semua Outlet callers meet everyone.
func (c Caller) Meets(user Coverage) bool {
	if c.AllScope() {
		return true
	}
	if user.All {
		return len(c.Cov.OutletIDs) > 0
	}
	for _, o := range user.OutletIDs {
		if c.Cov.Covers(o) {
			return true
		}
	}
	return false
}
