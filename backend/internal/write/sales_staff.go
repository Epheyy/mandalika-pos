package write

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/coverage"
)

// Tim Sales: the per-outlet list of sales staff. Coverage rules for managers who cover only
// some of a person's outlets live in planSalesStaffUpdate (pure, unit tested).

// Domain errors; the text is Indonesian and safe to show (handlers answer it verbatim).
var (
	ErrSalesStaffInvalid       = apperr.New(apperr.Rejected, "Data sales tidak valid.")
	ErrSalesStaffNotFound      = apperr.New(apperr.NotFound, "Sales tidak ditemukan.")
	ErrSalesStaffForbidden     = apperr.New(apperr.Forbidden, "Anda hanya bisa mengatur outlet yang Anda kelola.")
	ErrSalesStaffDuplicateName = apperr.New(apperr.Conflict, "Nama sudah dipakai sales aktif lain di outlet yang sama.")
	ErrSalesStaffUserTaken     = apperr.New(apperr.Conflict, "Akun ini sudah ditautkan ke sales lain.")
)

// salesStaffInvalidError is ErrSalesStaffInvalid with a specific message.
type salesStaffInvalidError struct{ msg string }

func (e *salesStaffInvalidError) Error() string          { return e.msg }
func (e *salesStaffInvalidError) ErrorCode() apperr.Code { return apperr.Rejected }
func (e *salesStaffInvalidError) Is(target error) bool   { return target == ErrSalesStaffInvalid }

func invalidSalesStaff(msg string) error { return &salesStaffInvalidError{msg} }

const salesStaffNameMax = 60

// SalesStaffInput is the editable shape of a person.
type SalesStaffInput struct {
	Name      string
	Active    bool
	OutletIDs []string
	UserID    *string
}

func sameID(a, b string) bool { return strings.EqualFold(a, b) }

func containsID(ids []string, id string) bool {
	for _, x := range ids {
		if sameID(x, id) {
			return true
		}
	}
	return false
}

// dedupeIDs keeps the first of each id (case-insensitive); never nil.
func dedupeIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !containsID(out, id) {
			out = append(out, id)
		}
	}
	return out
}

func sameUser(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return sameID(*a, *b)
}

func cleanSalesStaffName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if c := utf8.RuneCountInString(n); c < 1 || c > salesStaffNameMax {
		return "", invalidSalesStaff("Nama wajib diisi (maksimal 60 karakter).")
	}
	return n, nil
}

// planSalesStaffUpdate applies the coverage rules: the editor changes only what they cover
// unless they cover every outlet of the person (or are admin / Semua Outlet).
func planSalesStaffUpdate(c coverage.Caller, cur SalesStaffInput, in SalesStaffInput) (SalesStaffInput, error) {
	covers := c.Sees
	covered := make([]string, 0, len(cur.OutletIDs))
	uncovered := make([]string, 0, len(cur.OutletIDs))
	for _, o := range cur.OutletIDs {
		if covers(o) {
			covered = append(covered, o)
		} else {
			uncovered = append(uncovered, o)
		}
	}
	full := c.AllScope() || (len(cur.OutletIDs) > 0 && len(uncovered) == 0)
	if !full && len(covered) == 0 {
		return SalesStaffInput{}, ErrSalesStaffNotFound
	}
	want := dedupeIDs(in.OutletIDs)
	for _, o := range want {
		if !covers(o) && !containsID(cur.OutletIDs, o) {
			return SalesStaffInput{}, ErrSalesStaffForbidden
		}
	}
	if full {
		name, err := cleanSalesStaffName(in.Name)
		if err != nil {
			return SalesStaffInput{}, err
		}
		if len(want) == 0 {
			return SalesStaffInput{}, invalidSalesStaff("Pilih minimal satu outlet.")
		}
		return SalesStaffInput{Name: name, Active: in.Active, OutletIDs: want, UserID: in.UserID}, nil
	}
	if strings.TrimSpace(in.Name) != strings.TrimSpace(cur.Name) || !sameUser(in.UserID, cur.UserID) || (in.Active && !cur.Active) {
		return SalesStaffInput{}, ErrSalesStaffForbidden
	}
	res := SalesStaffInput{Name: cur.Name, Active: cur.Active, UserID: cur.UserID, OutletIDs: append([]string{}, uncovered...)}
	// Only the Aktif -> Nonaktif transition removes the editor's own outlets; any other edit
	// (including on an already inactive person) just ticks or unticks the covered ones.
	if !(cur.Active && !in.Active) {
		for _, o := range want {
			if covers(o) && !containsID(res.OutletIDs, o) {
				res.OutletIDs = append(res.OutletIDs, o)
			}
		}
	}
	if len(res.OutletIDs) == 0 {
		return SalesStaffInput{}, invalidSalesStaff("Pilih minimal satu outlet.")
	}
	return res, nil
}

// CreateSalesStaffTx adds a person; the caller must cover every requested outlet.
func (r *Repo) CreateSalesStaffTx(ctx context.Context, tx pgx.Tx, c coverage.Caller, in SalesStaffInput) (string, error) {
	name, err := cleanSalesStaffName(in.Name)
	if err != nil {
		return "", err
	}
	outlets := dedupeIDs(in.OutletIDs)
	if len(outlets) == 0 {
		return "", invalidSalesStaff("Pilih minimal satu outlet.")
	}
	for _, o := range outlets {
		if !c.Sees(o) {
			return "", ErrSalesStaffForbidden
		}
	}
	if err := lockSalesStaffNames(ctx, tx); err != nil {
		return "", err
	}
	if err := checkOutletsExist(ctx, tx, outlets); err != nil {
		return "", err
	}
	if err := checkSalesStaffUser(ctx, tx, c, in.UserID, ""); err != nil {
		return "", err
	}
	if in.Active {
		if err := checkSalesStaffDuplicate(ctx, tx, name, outlets, ""); err != nil {
			return "", err
		}
	}
	var id string
	err = tx.QueryRow(ctx,
		`INSERT INTO sales_staff (name, active, user_id, created_by, updated_by)
		 VALUES ($1, $2, $3::uuid, NULLIF($4,'')::uuid, NULLIF($4,'')::uuid) RETURNING id::text`,
		name, in.Active, in.UserID, c.UserID).Scan(&id)
	if err != nil {
		return "", salesStaffWriteErr(err, "insert sales staff")
	}
	if err := setSalesStaffOutlets(ctx, tx, id, nil, outlets); err != nil {
		return "", err
	}
	if err := bumpVersionOutlets(ctx, tx, "sales_staff", outlets); err != nil {
		return "", fmt.Errorf("bump sales staff version: %w", err)
	}
	return id, nil
}

// UpdateSalesStaffTx edits a person under the coverage rules (see planSalesStaffUpdate).
func (r *Repo) UpdateSalesStaffTx(ctx context.Context, tx pgx.Tx, c coverage.Caller, id string, in SalesStaffInput) error {
	if _, err := uuid.Parse(id); err != nil {
		return ErrSalesStaffNotFound
	}
	if err := lockSalesStaffNames(ctx, tx); err != nil {
		return err
	}
	cur := SalesStaffInput{}
	err := tx.QueryRow(ctx, `SELECT name, active, user_id::text FROM sales_staff WHERE id = $1::uuid FOR UPDATE`, id).
		Scan(&cur.Name, &cur.Active, &cur.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrSalesStaffNotFound
	}
	if err != nil {
		return fmt.Errorf("load sales staff: %w", err)
	}
	rows, err := tx.Query(ctx, `SELECT outlet_id::text FROM sales_staff_outlets WHERE staff_id = $1::uuid ORDER BY outlet_id`, id)
	if err != nil {
		return fmt.Errorf("load sales staff outlets: %w", err)
	}
	cur.OutletIDs, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return fmt.Errorf("load sales staff outlets: %w", err)
	}
	res, err := planSalesStaffUpdate(c, cur, in)
	if err != nil {
		return err
	}
	if err := checkOutletsExist(ctx, tx, res.OutletIDs); err != nil {
		return err
	}
	if !sameUser(res.UserID, cur.UserID) {
		if err := checkSalesStaffUser(ctx, tx, c, res.UserID, id); err != nil {
			return err
		}
	}
	if res.Active {
		if err := checkSalesStaffDuplicate(ctx, tx, res.Name, res.OutletIDs, id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE sales_staff SET name=$2, active=$3, user_id=$4::uuid, updated_by=NULLIF($5,'')::uuid, updated_at=now() WHERE id=$1::uuid`,
		id, res.Name, res.Active, res.UserID, c.UserID); err != nil {
		return salesStaffWriteErr(err, "update sales staff")
	}
	if err := setSalesStaffOutlets(ctx, tx, id, cur.OutletIDs, res.OutletIDs); err != nil {
		return err
	}
	touched := dedupeIDs(append(append([]string{}, cur.OutletIDs...), res.OutletIDs...))
	if err := bumpVersionOutlets(ctx, tx, "sales_staff", touched); err != nil {
		return fmt.Errorf("bump sales staff version: %w", err)
	}
	return nil
}

// lockSalesStaffNames serialises sales-staff writes so the duplicate-name check cannot race.
// Check-after-lock relies on READ COMMITTED (a fresh snapshot per statement).
func lockSalesStaffNames(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('sales_staff_write'))`); err != nil {
		return fmt.Errorf("lock sales staff: %w", err)
	}
	return nil
}

func checkOutletsExist(ctx context.Context, tx pgx.Tx, outlets []string) error {
	for _, o := range outlets {
		if _, err := uuid.Parse(o); err != nil {
			return invalidSalesStaff("Outlet tidak ditemukan.")
		}
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM outlets WHERE id = ANY($1::uuid[])`, outlets).Scan(&n); err != nil {
		return fmt.Errorf("check outlets: %w", err)
	}
	if n != len(outlets) {
		return invalidSalesStaff("Outlet tidak ditemukan.")
	}
	return nil
}

// checkSalesStaffUser validates a link: the user exists, is not linked to another person,
// and (for callers limited to some outlets) shares coverage with the caller.
func checkSalesStaffUser(ctx context.Context, tx pgx.Tx, c coverage.Caller, userID *string, selfID string) error {
	if userID == nil {
		return nil
	}
	// Callers limited to some outlets get one answer (Forbidden) for an unknown and an
	// out-of-coverage user, and it comes before the linked check, so they cannot probe
	// which accounts exist or are linked.
	var unknown error = ErrSalesStaffForbidden
	if c.AllScope() {
		unknown = invalidSalesStaff("Akun tidak ditemukan.")
	}
	if _, err := uuid.Parse(*userID); err != nil {
		return unknown
	}
	_, _, cov, err := coverage.Load(ctx, tx, *userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return unknown
	}
	if err != nil {
		return err
	}
	if !c.Meets(cov) {
		return ErrSalesStaffForbidden
	}
	var taken bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM sales_staff WHERE user_id = $1::uuid AND ($2::text = '' OR id::text <> $2::text))`,
		*userID, selfID).Scan(&taken); err != nil {
		return fmt.Errorf("check user link: %w", err)
	}
	if taken {
		return ErrSalesStaffUserTaken
	}
	return nil
}

func checkSalesStaffDuplicate(ctx context.Context, tx pgx.Tx, name string, outlets []string, selfID string) error {
	var dup bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1 FROM sales_staff s JOIN sales_staff_outlets so ON so.staff_id = s.id
		    WHERE s.active AND lower(btrim(s.name)) = lower($1)
		      AND so.outlet_id = ANY($2::uuid[]) AND ($3::text = '' OR s.id::text <> $3::text))`,
		name, outlets, selfID).Scan(&dup); err != nil {
		return fmt.Errorf("check duplicate name: %w", err)
	}
	if dup {
		return ErrSalesStaffDuplicateName
	}
	return nil
}

// setSalesStaffOutlets moves a person's outlet links from have to want.
func setSalesStaffOutlets(ctx context.Context, tx pgx.Tx, id string, have, want []string) error {
	for _, o := range have {
		if !containsID(want, o) {
			if _, err := tx.Exec(ctx, `DELETE FROM sales_staff_outlets WHERE staff_id=$1::uuid AND outlet_id=$2::uuid`, id, o); err != nil {
				return fmt.Errorf("unlink outlet: %w", err)
			}
		}
	}
	for _, o := range want {
		if !containsID(have, o) {
			if _, err := tx.Exec(ctx, `INSERT INTO sales_staff_outlets (staff_id, outlet_id) VALUES ($1::uuid, $2::uuid)`, id, o); err != nil {
				return fmt.Errorf("link outlet: %w", err)
			}
		}
	}
	return nil
}

// salesStaffWriteErr maps the user_id unique violation to ErrSalesStaffUserTaken.
func salesStaffWriteErr(err error, what string) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return ErrSalesStaffUserTaken
	}
	return fmt.Errorf("%s: %w", what, err)
}
