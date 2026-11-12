package bundles

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Querier is the one pgx method LoadPrices needs, so a pool or a transaction both fit.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// LoadPrices reads bundle_prices: line ” is the standard price per size.
func LoadPrices(ctx context.Context, q Querier) (Prices, error) {
	rows, err := q.Query(ctx, `SELECT line, size, price::float8 FROM bundle_prices ORDER BY line, size`)
	if err != nil {
		return Prices{}, fmt.Errorf("bundle prices: %w", err)
	}
	defer rows.Close()
	p := Prices{Standard: map[string]float64{}, Lines: map[string]map[string]float64{}}
	for rows.Next() {
		var line, size string
		var price float64
		if err := rows.Scan(&line, &size, &price); err != nil {
			return Prices{}, fmt.Errorf("bundle prices scan: %w", err)
		}
		if line == "" {
			p.Standard[size] = price
			continue
		}
		if p.Lines[line] == nil {
			p.Lines[line] = map[string]float64{}
		}
		p.Lines[line][size] = price
	}
	return p, rows.Err()
}
