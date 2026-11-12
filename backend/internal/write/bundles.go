package write

import (
	"context"
	"fmt"
	"math"
	"regexp"

	"github.com/jackc/pgx/v5"
)

// BundlePriceIn is one standard bundle price (line ”).
type BundlePriceIn struct {
	Size  string
	Price float64
}

// BundleLinePriceIn is one per-line bundle price.
type BundleLinePriceIn struct {
	Line  string
	Size  string
	Price float64
}

// BundleSettingsInput replaces the whole bundle price table.
type BundleSettingsInput struct {
	Standard   []BundlePriceIn
	LinePrices []BundleLinePriceIn
}

var bundleSizeRe = regexp.MustCompile(`^[0-9]+ml$`)

func validBundlePrice(p float64) bool {
	return p > 0 && p == math.Trunc(p) && p <= 1_000_000_000
}

// validateBundleSettings checks the copy the Backoffice shows verbatim. knownLines is the
// line allowlist (ERP line names).
func validateBundleSettings(in BundleSettingsInput, knownLines []string) error {
	known := map[string]bool{}
	for _, l := range knownLines {
		known[l] = true
	}
	std := map[string]bool{}
	for _, s := range in.Standard {
		if !bundleSizeRe.MatchString(s.Size) {
			return fmt.Errorf("Ukuran harus seperti 120ml")
		}
		if !validBundlePrice(s.Price) {
			return fmt.Errorf("Harga bundle harus bilangan bulat > 0")
		}
		if std[s.Size] {
			return fmt.Errorf("Ukuran %s dobel", s.Size)
		}
		std[s.Size] = true
	}
	seen := map[[2]string]bool{}
	for _, lp := range in.LinePrices {
		if !known[lp.Line] {
			return fmt.Errorf("Lini tidak dikenal: %s", lp.Line)
		}
		if !bundleSizeRe.MatchString(lp.Size) {
			return fmt.Errorf("Ukuran harus seperti 120ml")
		}
		if !validBundlePrice(lp.Price) {
			return fmt.Errorf("Harga bundle harus bilangan bulat > 0")
		}
		if !std[lp.Size] {
			return fmt.Errorf("Harga lini %s butuh harga standar %s", lp.Size, lp.Size)
		}
		k := [2]string{lp.Line, lp.Size}
		if seen[k] {
			return fmt.Errorf("Ukuran %s dobel", lp.Size)
		}
		seen[k] = true
	}
	return nil
}

// UpdateBundleSettings replaces every bundle price in one transaction and bumps the content
// version, so tablets pick the new prices up on their next pull.
func (r *Repo) UpdateBundleSettings(ctx context.Context, userID string, in BundleSettingsInput) error {
	if err := validateBundleSettings(in, bundleLineNames); err != nil {
		return err
	}
	return r.tx(ctx, "bundle_prices", func(t pgx.Tx) error {
		if _, err := t.Exec(ctx, `DELETE FROM bundle_prices`); err != nil {
			return err
		}
		by := nilIfEmpty(userID)
		for _, s := range in.Standard {
			if _, err := t.Exec(ctx,
				`INSERT INTO bundle_prices (line, size, price, updated_by) VALUES ('', $1, $2, $3)`,
				s.Size, s.Price, by); err != nil {
				return err
			}
		}
		for _, lp := range in.LinePrices {
			if _, err := t.Exec(ctx,
				`INSERT INTO bundle_prices (line, size, price, updated_by) VALUES ($1, $2, $3, $4)`,
				lp.Line, lp.Size, lp.Price, by); err != nil {
				return err
			}
		}
		return nil
	})
}

// bundleLineNames is the ERP line allowlist for bundle prices.
var bundleLineNames = []string{"EXTRAIT DE PARFUM", "PARFUM INTENSE"}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
