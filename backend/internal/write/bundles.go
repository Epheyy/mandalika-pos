package write

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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

// BundleSettingsInput saves the default group's prices (Standard, LinePrices) and, in the new
// shape, the listed groups' prices and outlet assignments. The old body (no Groups or
// OutletGroups) never touches other groups or assignments.
type BundleSettingsInput struct {
	Standard     []BundlePriceIn
	LinePrices   []BundleLinePriceIn
	Groups       []BundleGroupPricesIn
	OutletGroups []BundleOutletGroupIn
	Revision     *int64
	// NewShape is true when the JSON carried groups or outletGroups; it then needs a Revision.
	NewShape bool
}

var bundleSizeRe = regexp.MustCompile(`^[0-9]+ml$`)

// bundleNotLarge mirrors bundles.NotLargeSizes (write may not import bundles, see archtest).
var bundleNotLarge = map[string]bool{"2ml": true, "10ml": true, "15ml": true}

const maxBundlePrice = 1_000_000_000

func validBundlePrice(p float64) bool {
	return p > 0 && p == math.Trunc(p)
}

func checkBundlePrice(p float64) error {
	if !validBundlePrice(p) {
		return fmt.Errorf("Harga bundle harus bilangan bulat > 0")
	}
	if p > maxBundlePrice {
		return fmt.Errorf("Harga bundle maksimal Rp 1.000.000.000")
	}
	return nil
}

// validateBundlePrices checks one group's prices with the copy the Backoffice shows verbatim.
// knownLines is the line allowlist (ERP line names). groupLabel is empty for the default group
// (today's copy); otherwise line-rule sizes read "<group> <size>".
func validateBundlePrices(stdIn []BundlePriceIn, lines []BundleLinePriceIn, knownLines []string, groupLabel string) error {
	known := map[string]bool{}
	for _, l := range knownLines {
		known[l] = true
	}
	std := map[string]bool{}
	for _, s := range stdIn {
		if !bundleSizeRe.MatchString(s.Size) {
			return fmt.Errorf("Ukuran harus seperti 120ml")
		}
		if bundleNotLarge[s.Size] {
			return fmt.Errorf("Ukuran %s bukan ukuran botol besar", s.Size)
		}
		if err := checkBundlePrice(s.Price); err != nil {
			return err
		}
		if std[s.Size] {
			return fmt.Errorf("Ukuran %s dobel", s.Size)
		}
		std[s.Size] = true
	}
	seen := map[[2]string]bool{}
	for _, lp := range lines {
		if !known[lp.Line] {
			return fmt.Errorf("Lini tidak dikenal: %s", lp.Line)
		}
		if !bundleSizeRe.MatchString(lp.Size) {
			return fmt.Errorf("Ukuran harus seperti 120ml")
		}
		if err := checkBundlePrice(lp.Price); err != nil {
			return err
		}
		if !std[lp.Size] {
			if groupLabel == "" {
				return fmt.Errorf("Harga lini %s butuh harga standar %s", lp.Size, lp.Size)
			}
			return fmt.Errorf("Harga lini %s %s butuh harga standar %s %s", groupLabel, lp.Size, groupLabel, lp.Size)
		}
		k := [2]string{lp.Line, lp.Size}
		if seen[k] {
			return fmt.Errorf("Ukuran %s dobel", lp.Size)
		}
		seen[k] = true
	}
	return nil
}

// bundleGroupRow is a price_groups row as loaded inside the save transaction.
type bundleGroupRow struct {
	id, name  string
	isDefault bool
}

// UpdateBundleSettings saves bundle prices and outlet assignments in one transaction and returns
// the new revision. The revision row lock serializes every bundle write; the default group and
// each listed group are replaced, unlisted groups and (old shape) assignments are untouched.
// Tablets are bumped only as needed: all outlets when any price row changed, else just the
// outlets that moved group.
func (r *Repo) UpdateBundleSettings(ctx context.Context, userID string, in BundleSettingsInput) (int64, error) {
	if in.NewShape && in.Revision == nil {
		return 0, errors.New(MsgBundleRevisionRequired)
	}
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer t.Rollback(ctx)

	var rev int64
	err = t.QueryRow(ctx, `UPDATE bundle_price_revision SET revision = revision + 1
		WHERE $1::bigint IS NULL OR revision = $1::bigint RETURNING revision`, in.Revision).Scan(&rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, &BundleConflictError{Msg: MsgBundleStale}
	}
	if err != nil {
		return 0, err
	}

	groups, before, err := loadBundleGroups(ctx, t)
	if err != nil {
		return 0, err
	}
	known := map[string]*bundleGroupRow{}
	var def *bundleGroupRow
	for i := range groups {
		known[groups[i].id] = &groups[i]
		if groups[i].isDefault {
			def = &groups[i]
		}
	}
	if def == nil {
		return 0, errors.New("default price group missing")
	}
	outletIDs, err := loadOutletIDs(ctx, t, in.OutletGroups)
	if err != nil {
		return 0, err
	}
	if err := checkBundleTargets(in, known, def.id, outletIDs); err != nil {
		return 0, err
	}

	if err := validateBundlePrices(in.Standard, in.LinePrices, bundleLineNames, ""); err != nil {
		return 0, err
	}
	for _, g := range in.Groups {
		if err := validateBundlePrices(g.Standard, g.LinePrices, bundleLineNames, known[g.GroupID].name); err != nil {
			return 0, err
		}
	}

	newRows := []bundlePriceRow{}
	for _, s := range in.Standard {
		newRows = append(newRows, bundlePriceRow{def.id, "", s.Size, s.Price})
	}
	for _, lp := range in.LinePrices {
		newRows = append(newRows, bundlePriceRow{def.id, lp.Line, lp.Size, lp.Price})
	}
	replaced := []string{def.id}
	for _, g := range in.Groups {
		replaced = append(replaced, g.GroupID)
		for _, s := range g.Standard {
			newRows = append(newRows, bundlePriceRow{g.GroupID, "", s.Size, s.Price})
		}
		for _, lp := range g.LinePrices {
			newRows = append(newRows, bundlePriceRow{g.GroupID, lp.Line, lp.Size, lp.Price})
		}
	}
	after := append([]bundlePriceRow{}, newRows...)
	isReplaced := map[string]bool{}
	for _, id := range replaced {
		isReplaced[id] = true
	}
	for _, b := range before {
		if !isReplaced[b.GroupID] {
			after = append(after, b)
		}
	}
	if err := validateBundleGroups(mergedBundleGroups(groups, after, isReplaced)); err != nil {
		return 0, err
	}

	if _, err := t.Exec(ctx, `DELETE FROM bundle_prices WHERE group_id = ANY($1::uuid[])`, replaced); err != nil {
		return 0, err
	}
	by := nilIfEmpty(userID)
	for _, row := range newRows {
		if _, err := t.Exec(ctx,
			`INSERT INTO bundle_prices (group_id, line, size, price, updated_by) VALUES ($1::uuid, $2, $3, $4, $5)`,
			row.GroupID, row.Line, row.Size, row.Price, by); err != nil {
			return 0, err
		}
	}

	moved := []string{}
	for _, og := range in.OutletGroups {
		var target any // NULL stores the default group
		if og.GroupID != def.id {
			target = og.GroupID
		}
		var id string
		err := t.QueryRow(ctx, `UPDATE outlets SET price_group_id = $2::uuid
			WHERE id = $1::uuid AND COALESCE(price_group_id, $3::uuid) IS DISTINCT FROM COALESCE($2::uuid, $3::uuid)
			RETURNING id::text`, og.OutletID, target, def.id).Scan(&id)
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23503" {
			return 0, errors.New(MsgPriceGroupUnknown)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, err
		}
		moved = append(moved, id)
	}

	if bundlePriceRowsChanged(before, after) {
		err = bumpVersion(ctx, t, "bundle_prices")
	} else if len(moved) > 0 {
		err = bumpVersionOutlets(ctx, t, "bundle_prices", moved)
	}
	if err != nil {
		return 0, fmt.Errorf("bump version: %w", err)
	}
	if err := t.Commit(ctx); err != nil {
		return 0, err
	}
	return rev, nil
}

func loadBundleGroups(ctx context.Context, t pgx.Tx) ([]bundleGroupRow, []bundlePriceRow, error) {
	rows, err := t.Query(ctx, `SELECT id::text, name, is_default FROM price_groups ORDER BY sort_order, name`)
	if err != nil {
		return nil, nil, err
	}
	var groups []bundleGroupRow
	for rows.Next() {
		var g bundleGroupRow
		if err := rows.Scan(&g.id, &g.name, &g.isDefault); err != nil {
			rows.Close()
			return nil, nil, err
		}
		groups = append(groups, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	prows, err := t.Query(ctx, `SELECT group_id::text, line, size, price::float8 FROM bundle_prices`)
	if err != nil {
		return nil, nil, err
	}
	defer prows.Close()
	var before []bundlePriceRow
	for prows.Next() {
		var b bundlePriceRow
		if err := prows.Scan(&b.GroupID, &b.Line, &b.Size, &b.Price); err != nil {
			return nil, nil, err
		}
		before = append(before, b)
	}
	return groups, before, prows.Err()
}

// loadOutletIDs returns the set of outlet ids among the assignments that exist.
func loadOutletIDs(ctx context.Context, t pgx.Tx, ogs []BundleOutletGroupIn) (map[string]bool, error) {
	ids := make([]string, 0, len(ogs))
	for _, og := range ogs {
		ids = append(ids, og.OutletID)
	}
	have := map[string]bool{}
	if len(ids) == 0 {
		return have, nil
	}
	rows, err := t.Query(ctx, `SELECT id::text FROM outlets WHERE id::text = ANY($1::text[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		have[id] = true
	}
	return have, rows.Err()
}

// checkBundleTargets rejects bad group and outlet references, in the documented order.
func checkBundleTargets(in BundleSettingsInput, known map[string]*bundleGroupRow, defID string, outlets map[string]bool) error {
	for _, g := range in.Groups {
		if g.GroupID == defID {
			return errors.New("Harga kelompok default dikirim lewat standard dan linePrices.")
		}
	}
	seenGroup := map[string]bool{}
	for _, g := range in.Groups {
		if seenGroup[g.GroupID] {
			name := g.GroupID
			if k := known[g.GroupID]; k != nil {
				name = k.name
			}
			return fmt.Errorf("Kelompok %s dobel", name)
		}
		seenGroup[g.GroupID] = true
	}
	for _, g := range in.Groups {
		if known[g.GroupID] == nil {
			return errors.New(MsgPriceGroupUnknown)
		}
	}
	for _, og := range in.OutletGroups {
		if known[og.GroupID] == nil {
			return errors.New(MsgPriceGroupUnknown)
		}
	}
	seenOutlet := map[string]bool{}
	for _, og := range in.OutletGroups {
		if seenOutlet[og.OutletID] {
			return errors.New("Outlet dobel di daftar kelompok")
		}
		seenOutlet[og.OutletID] = true
	}
	for _, og := range in.OutletGroups {
		if !outlets[og.OutletID] {
			return errors.New(MsgBundleOutletUnknown)
		}
	}
	return nil
}

// mergedBundleGroups builds the post-save state of every group from the merged row set.
func mergedBundleGroups(groups []bundleGroupRow, after []bundlePriceRow, listed map[string]bool) []bundleGroupState {
	out := make([]bundleGroupState, len(groups))
	idx := map[string]int{}
	for i, g := range groups {
		out[i] = bundleGroupState{ID: g.id, Name: g.name, IsDefault: g.isDefault, Listed: listed[g.id],
			Standard: map[string]float64{}, Lines: map[string]map[string]float64{}}
		idx[g.id] = i
	}
	for _, row := range after {
		g := &out[idx[row.GroupID]]
		if row.Line == "" {
			g.Standard[row.Size] = row.Price
			continue
		}
		if g.Lines[row.Line] == nil {
			g.Lines[row.Line] = map[string]float64{}
		}
		g.Lines[row.Line][row.Size] = row.Price
	}
	return out
}

// bundleLineNames is the ERP line allowlist for bundle prices.
var bundleLineNames = []string{"EXTRAIT DE PARFUM", "PARFUM INTENSE"}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
