package read

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/coverage"
)

// SalesStaffFilter narrows the admin list. Active nil means both.
type SalesStaffFilter struct {
	OutletID string
	Active   *bool
	Q        string
}

const salesStaffSelect = `
SELECT s.id::text, s.name, s.active, s.updated_at, u.id::text, u.display_name,
       ARRAY(SELECT so.outlet_id::text FROM sales_staff_outlets so WHERE so.staff_id = s.id ORDER BY so.outlet_id)
  FROM sales_staff s LEFT JOIN users u ON u.id = s.user_id`

type rowScanner interface{ Scan(dest ...any) error }

// scanSalesStaff maps one salesStaffSelect row to the caller's view. ok is false when the
// caller covers none of the person's outlets (the row is invisible to them).
func scanSalesStaff(row rowScanner, c coverage.Caller) (s api.SalesStaff, ok bool, err error) {
	var id, name string
	var active bool
	var updated time.Time
	var userID, userName *string
	var outlets []string
	if err = row.Scan(&id, &name, &active, &updated, &userID, &userName, &outlets); err != nil {
		return s, false, err
	}
	visible := make([]uuid.UUID, 0, len(outlets))
	allCovered := true
	for _, o := range outlets {
		if !c.Sees(o) {
			allCovered = false
			continue
		}
		ou, perr := uuid.Parse(o)
		if perr != nil {
			return s, false, fmt.Errorf("outlet id %q: %w", o, perr)
		}
		visible = append(visible, ou)
	}
	if !c.AllScope() && len(visible) == 0 {
		return s, false, nil
	}
	sid, err := uuid.Parse(id)
	if err != nil {
		return s, false, err
	}
	s = api.SalesStaff{
		Id: sid, Name: name, Active: active, UpdatedAt: updated, OutletIds: visible,
		HiddenOutletCount: len(outlets) - len(visible),
		CanEditDetails:    c.AllScope() || (len(outlets) > 0 && allCovered),
	}
	if userID != nil && userName != nil {
		uid, perr := uuid.Parse(*userID)
		if perr != nil {
			return s, false, perr
		}
		s.User = &api.PullUser{Id: uid, DisplayName: *userName}
	}
	return s, true, nil
}

// SalesStaffList is the Tim Sales list as the caller may see it: admin and Semua Outlet
// managers see everyone, other callers see people with at least one outlet they cover,
// with only those outlets named. Ordered by lower(name).
func (r *Repo) SalesStaffList(ctx context.Context, c coverage.Caller, f SalesStaffFilter) ([]api.SalesStaff, error) {
	out := []api.SalesStaff{}
	if f.OutletID != "" && !c.Sees(f.OutletID) {
		return out, nil
	}
	where := []string{"TRUE"}
	args := []any{}
	if f.OutletID != "" {
		args = append(args, f.OutletID)
		where = append(where, fmt.Sprintf("EXISTS (SELECT 1 FROM sales_staff_outlets x WHERE x.staff_id = s.id AND x.outlet_id = $%d::uuid)", len(args)))
	}
	if f.Active != nil {
		args = append(args, *f.Active)
		where = append(where, fmt.Sprintf("s.active = $%d", len(args)))
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		args = append(args, q)
		where = append(where, fmt.Sprintf("strpos(lower(s.name), lower($%d)) > 0", len(args)))
	}
	rows, err := r.Pool.Query(ctx, salesStaffSelect+" WHERE "+strings.Join(where, " AND ")+" ORDER BY lower(s.name), s.id", args...)
	if err != nil {
		return nil, fmt.Errorf("list sales staff: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		s, ok, err := scanSalesStaff(rows, c)
		if err != nil {
			return nil, fmt.Errorf("scan sales staff: %w", err)
		}
		if ok {
			out = append(out, s)
		}
	}
	return out, rows.Err()
}

// SalesStaffByID is one person as the caller may see them; ErrNotFound when missing or
// when the caller covers none of their outlets.
func (r *Repo) SalesStaffByID(ctx context.Context, q RowQuerier, c coverage.Caller, id string) (api.SalesStaff, error) {
	if _, err := uuid.Parse(id); err != nil {
		return api.SalesStaff{}, ErrNotFound
	}
	s, ok, err := scanSalesStaff(q.QueryRow(ctx, salesStaffSelect+" WHERE s.id = $1::uuid", id), c)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !ok) {
		return api.SalesStaff{}, ErrNotFound
	}
	if err != nil {
		return api.SalesStaff{}, fmt.Errorf("sales staff by id: %w", err)
	}
	return s, nil
}

// SalesStaffAfterWrite is the Outcome of a write: like SalesStaffByID, but an entry that
// exists and is no longer visible to the caller (a partial Manajer's Nonaktif or unticking
// every outlet they cover) comes back with no visible outlets, all its outlets counted as
// hidden and canEditDetails false. Only a missing id is ErrNotFound.
func (r *Repo) SalesStaffAfterWrite(ctx context.Context, q RowQuerier, c coverage.Caller, id string) (api.SalesStaff, error) {
	if _, err := uuid.Parse(id); err != nil {
		return api.SalesStaff{}, ErrNotFound
	}
	s, ok, err := scanSalesStaff(q.QueryRow(ctx, salesStaffSelect+" WHERE s.id = $1::uuid", id), c)
	if errors.Is(err, pgx.ErrNoRows) {
		return api.SalesStaff{}, ErrNotFound
	}
	if err != nil {
		return api.SalesStaff{}, fmt.Errorf("sales staff after write: %w", err)
	}
	if ok {
		return s, nil
	}
	var name string
	var active bool
	var updated time.Time
	var total int
	if err := q.QueryRow(ctx,
		`SELECT s.name, s.active, s.updated_at, (SELECT count(*) FROM sales_staff_outlets WHERE staff_id = s.id)
		   FROM sales_staff s WHERE s.id = $1::uuid`, id).Scan(&name, &active, &updated, &total); err != nil {
		return api.SalesStaff{}, fmt.Errorf("sales staff after write: %w", err)
	}
	sid, _ := uuid.Parse(id)
	return api.SalesStaff{Id: sid, Name: name, Active: active, UpdatedAt: updated,
		OutletIds: []uuid.UUID{}, HiddenOutletCount: total}, nil
}

// SalesStaffForOutlet is the POS pull list: active people linked to the outlet.
func (r *Repo) SalesStaffForOutlet(ctx context.Context, outletID string) ([]api.SalesStaffPick, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT s.id::text, s.name FROM sales_staff s
		   JOIN sales_staff_outlets so ON so.staff_id = s.id
		  WHERE s.active AND so.outlet_id = $1::uuid
		  ORDER BY lower(s.name), s.id`, outletID)
	if err != nil {
		return nil, fmt.Errorf("sales staff for outlet: %w", err)
	}
	defer rows.Close()
	out := []api.SalesStaffPick{}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		u, err := uuid.Parse(id)
		if err != nil {
			return nil, err
		}
		out = append(out, api.SalesStaffPick{Id: u, Name: name})
	}
	return out, rows.Err()
}

// pullUsers loads users matching where with their coverage and keeps those keep() accepts.
func (r *Repo) pullUsers(ctx context.Context, where string, keep func(cov coverage.Coverage) bool) ([]api.PullUser, error) {
	rows, err := r.Pool.Query(ctx,
		`SELECT u.id::text, u.display_name, u.role, u.outlet_id::text, `+coverage.SelectCols+`
		   FROM users u WHERE `+where+` ORDER BY lower(u.display_name), u.id`)
	if err != nil {
		return nil, fmt.Errorf("pull users: %w", err)
	}
	defer rows.Close()
	out := []api.PullUser{}
	for rows.Next() {
		var id, name, role string
		var home *string
		var all bool
		var extras []string
		if err := rows.Scan(&id, &name, &role, &home, &all, &extras); err != nil {
			return nil, err
		}
		h := ""
		if home != nil {
			h = *home
		}
		if !keep(coverage.Of(role, h, extras, all)) {
			continue
		}
		u, err := uuid.Parse(id)
		if err != nil {
			return nil, err
		}
		out = append(out, api.PullUser{Id: u, DisplayName: name})
	}
	return out, rows.Err()
}

// UsersForOutlet is the POS pull's user list: everyone whose coverage includes the outlet.
func (r *Repo) UsersForOutlet(ctx context.Context, outletID string) ([]api.PullUser, error) {
	return r.pullUsers(ctx, "TRUE", func(cov coverage.Coverage) bool { return cov.Covers(outletID) })
}

// LinkableUsers are the unlinked users the caller may attach to a sales person: everyone
// for admin and Semua Outlet managers, otherwise users whose coverage meets the caller's.
func (r *Repo) LinkableUsers(ctx context.Context, c coverage.Caller) ([]api.PullUser, error) {
	return r.pullUsers(ctx, "NOT EXISTS (SELECT 1 FROM sales_staff s WHERE s.user_id = u.id)",
		func(cov coverage.Coverage) bool { return c.Meets(cov) })
}
