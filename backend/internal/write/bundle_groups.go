package write

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Copy the Backoffice shows verbatim.
const (
	MsgBundleStale            = "Harga bundle sudah diubah orang lain. Muat ulang."
	MsgBundleRevisionRequired = "Revisi harga bundle wajib dikirim. Muat ulang."
	MsgPriceGroupUnknown      = "Kelompok harga tidak ditemukan. Muat ulang."
	MsgBundleOutletUnknown    = "Outlet tidak ditemukan. Muat ulang."
)

// BundleGroupPricesIn is the full price set of one non-default group.
type BundleGroupPricesIn struct {
	GroupID    string
	Standard   []BundlePriceIn
	LinePrices []BundleLinePriceIn
}

// BundleOutletGroupIn moves one outlet into a group (the default group stores NULL).
type BundleOutletGroupIn struct {
	OutletID, GroupID string
}

// BundleConflictError is a refused save the client can fix by reloading (409).
type BundleConflictError struct{ Msg string }

func (e *BundleConflictError) Error() string { return e.Msg }

// IsBundleConflict reports whether err is a BundleConflictError.
func IsBundleConflict(err error) bool {
	var e *BundleConflictError
	return errors.As(err, &e)
}

// bundleGroupState is one group as it will be after the save.
type bundleGroupState struct {
	ID, Name  string
	IsDefault bool
	Listed    bool // the body carries this group's prices
	Standard  map[string]float64
	Lines     map[string]map[string]float64
}

// bundleSizeMl orders sizes like 100ml numerically; anything else sorts last.
func bundleSizeMl(s string) int {
	n, err := strconv.Atoi(strings.TrimSuffix(s, "ml"))
	if err != nil {
		return int(^uint(0) >> 1)
	}
	return n
}

// validateBundleGroups checks the cross-group rule on the merged post-save state: a group may
// only price a size the default group prices. Groups come in sort order, default first.
func validateBundleGroups(groups []bundleGroupState) error {
	var def *bundleGroupState
	for i := range groups {
		if groups[i].IsDefault {
			def = &groups[i]
			break
		}
	}
	if def == nil {
		return nil
	}
	for _, g := range groups {
		if g.IsDefault {
			continue
		}
		sizes := make([]string, 0, len(g.Standard))
		for s := range g.Standard {
			sizes = append(sizes, s)
		}
		sort.Slice(sizes, func(i, j int) bool {
			a, b := bundleSizeMl(sizes[i]), bundleSizeMl(sizes[j])
			if a != b {
				return a < b
			}
			return sizes[i] < sizes[j]
		})
		for _, s := range sizes {
			if _, ok := def.Standard[s]; ok {
				continue
			}
			if g.Listed {
				return fmt.Errorf("Harga %s %s butuh harga %s %s", g.Name, s, def.Name, s)
			}
			return fmt.Errorf("Ukuran %s masih punya harga di kelompok %s. Hapus harga itu dulu.", s, g.Name)
		}
	}
	return nil
}

// bundlePriceRow is one stored bundle_prices row.
type bundlePriceRow struct {
	GroupID, Line, Size string
	Price               float64
}

// bundlePriceRowsChanged reports whether the two row sets differ (order-insensitive).
func bundlePriceRowsChanged(before, after []bundlePriceRow) bool {
	if len(before) != len(after) {
		return true
	}
	type key struct{ g, l, s string }
	seen := make(map[key]float64, len(before))
	for _, r := range before {
		seen[key{r.GroupID, r.Line, r.Size}] = r.Price
	}
	for _, r := range after {
		p, ok := seen[key{r.GroupID, r.Line, r.Size}]
		if !ok || p != r.Price {
			return true
		}
	}
	return false
}

// Price group limits (spec): at most 5 groups, names 1-40 characters.
const (
	MaxPriceGroups       = 5
	MaxPriceGroupNameLen = 40
)

const (
	msgPriceGroupNameRequired = "Nama kelompok wajib diisi"
	msgPriceGroupNameTooLong  = "Nama kelompok maksimal 40 karakter"
	msgPriceGroupNameTaken    = "Nama kelompok sudah dipakai"
	msgPriceGroupMax          = "Maksimal 5 kelompok harga"
	msgPriceGroupDefaultKeep  = "Kelompok default tidak bisa dihapus"
)

// normalizePriceGroupName trims the name and checks its length (in runes).
func normalizePriceGroupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New(msgPriceGroupNameRequired)
	}
	if utf8.RuneCountInString(name) > MaxPriceGroupNameLen {
		return "", errors.New(msgPriceGroupNameTooLong)
	}
	return name, nil
}

// priceGroupTx runs fn in its own transaction (no content-version bump, so not r.tx) under the
// bundle revision row lock, which serializes it with every other bundle write. It does not
// advance the revision: an open Backoffice tab stays able to save after a group dialog write.
func (r *Repo) priceGroupTx(ctx context.Context, fn func(t pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	var rev int64
	if err := t.QueryRow(ctx, `SELECT revision FROM bundle_price_revision FOR UPDATE`).Scan(&rev); err != nil {
		return err
	}
	if err := fn(t); err != nil {
		return err
	}
	return t.Commit(ctx)
}

func isPgCode(err error, code, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == code && (constraint == "" || pg.ConstraintName == constraint)
}

// priceGroupNameTaken reports whether another group already has this name (ignoring case).
func priceGroupNameTaken(ctx context.Context, t pgx.Tx, name, exceptID string) (bool, error) {
	var except any // nil = no exception
	if exceptID != "" {
		except = exceptID
	}
	var taken bool
	err := t.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM price_groups
		WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid))`, name, except).Scan(&taken)
	return taken, err
}

// CreatePriceGroup adds a group at the end of the sort order and returns its id.
func (r *Repo) CreatePriceGroup(ctx context.Context, name string) (string, error) {
	name, err := normalizePriceGroupName(name)
	if err != nil {
		return "", err
	}
	var id string
	err = r.priceGroupTx(ctx, func(t pgx.Tx) error {
		var n int
		if err := t.QueryRow(ctx, `SELECT count(*) FROM price_groups`).Scan(&n); err != nil {
			return err
		}
		if n >= MaxPriceGroups {
			return &BundleConflictError{Msg: msgPriceGroupMax}
		}
		taken, err := priceGroupNameTaken(ctx, t, name, "")
		if err != nil {
			return err
		}
		if taken {
			return &BundleConflictError{Msg: msgPriceGroupNameTaken}
		}
		return t.QueryRow(ctx, `INSERT INTO price_groups (name, sort_order)
			VALUES ($1, COALESCE((SELECT max(sort_order) FROM price_groups), -1) + 1) RETURNING id::text`, name).Scan(&id)
	})
	if isPgCode(err, "23505", "price_groups_name_lower") {
		return "", &BundleConflictError{Msg: msgPriceGroupNameTaken}
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

// RenamePriceGroup renames a group (the default group too).
func (r *Repo) RenamePriceGroup(ctx context.Context, id, name string) error {
	name, err := normalizePriceGroupName(name)
	if err != nil {
		return err
	}
	if !isUUID(id) {
		return ErrNotFound
	}
	err = r.priceGroupTx(ctx, func(t pgx.Tx) error {
		var found string
		err := t.QueryRow(ctx, `SELECT id::text FROM price_groups WHERE id = $1::uuid FOR UPDATE`, id).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		taken, err := priceGroupNameTaken(ctx, t, name, id)
		if err != nil {
			return err
		}
		if taken {
			return &BundleConflictError{Msg: msgPriceGroupNameTaken}
		}
		_, err = t.Exec(ctx, `UPDATE price_groups SET name = $2, updated_at = now() WHERE id = $1::uuid`, id, name)
		return err
	})
	if isPgCode(err, "23505", "price_groups_name_lower") {
		return &BundleConflictError{Msg: msgPriceGroupNameTaken}
	}
	return err
}

// DeletePriceGroup deletes a group that has no outlets; its prices go with it (cascade).
func (r *Repo) DeletePriceGroup(ctx context.Context, id string) error {
	if !isUUID(id) {
		return ErrNotFound
	}
	return r.priceGroupTx(ctx, func(t pgx.Tx) error {
		var name string
		var isDefault bool
		err := t.QueryRow(ctx, `SELECT name, is_default FROM price_groups WHERE id = $1::uuid FOR UPDATE`, id).Scan(&name, &isDefault)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if isDefault {
			return &BundleConflictError{Msg: msgPriceGroupDefaultKeep}
		}
		var outlets int
		if err := t.QueryRow(ctx, `SELECT count(*) FROM outlets WHERE price_group_id = $1::uuid`, id).Scan(&outlets); err != nil {
			return err
		}
		if outlets > 0 {
			return &BundleConflictError{Msg: fmt.Sprintf("Kelompok %s masih dipakai %d outlet. Pindahkan outletnya dulu.", name, outlets)}
		}
		_, err = t.Exec(ctx, `DELETE FROM price_groups WHERE id = $1::uuid`, id)
		return err
	})
}
