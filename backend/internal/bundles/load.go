package bundles

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Querier is the one pgx method LoadPrices needs, so a pool or a transaction both fit.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// LoadPrices returns the prices an outlet charges: the default group's rows overlaid with
// the outlet's own group (Effective). An empty, unknown or non-UUID outletID, and an outlet
// with no group, resolve to the default group. Line ” is the standard price per size.
func LoadPrices(ctx context.Context, q Querier, outletID string) (Prices, error) {
	// The sync path passes the envelope's outlet id as sent; canonicalise case, braces and
	// no-hyphen spellings so a Premium outlet never falls back to the default group.
	if u, err := uuid.Parse(outletID); err == nil {
		outletID = u.String()
	}
	// o.id::text avoids a uuid cast error on a non-UUID outletID. A group row can only match
	// when the outlet has a non-default group, so the default group is never read twice.
	rows, err := q.Query(ctx, `
		WITH d AS (SELECT id FROM price_groups WHERE is_default),
		g AS (SELECT o.price_group_id AS id FROM outlets o WHERE o.id::text = $1 AND o.price_group_id IS NOT NULL)
		SELECT (bp.group_id = (SELECT id FROM d)) AS is_default, bp.line, bp.size, bp.price::float8
		FROM bundle_prices bp
		WHERE bp.group_id = (SELECT id FROM d) OR bp.group_id = (SELECT id FROM g)
		ORDER BY bp.line, bp.size`, outletID)
	if err != nil {
		return Prices{}, fmt.Errorf("bundle prices: %w", err)
	}
	defer rows.Close()
	standar, group := emptyPrices(), emptyPrices()
	for rows.Next() {
		var isDefault bool
		var line, size string
		var price float64
		if err := rows.Scan(&isDefault, &line, &size, &price); err != nil {
			return Prices{}, fmt.Errorf("bundle prices scan: %w", err)
		}
		dst := &group
		if isDefault {
			dst = &standar
		}
		if line == "" {
			dst.Standard[size] = price
			continue
		}
		if dst.Lines[line] == nil {
			dst.Lines[line] = map[string]float64{}
		}
		dst.Lines[line][size] = price
	}
	if err := rows.Err(); err != nil {
		return Prices{}, err
	}
	return Effective(standar, group), nil
}

func emptyPrices() Prices {
	return Prices{Standard: map[string]float64{}, Lines: map[string]map[string]float64{}}
}
