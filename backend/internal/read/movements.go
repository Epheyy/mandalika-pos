package read

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/bizday"
)

// MovementFilter selects ledger rows of ONE location (kartu stok). From/To are resolved
// instants over occurred_at, [From, To). Kinds, Shortage and Giveaway narrow the row list
// only; the saldo header always describes the SKU's whole chain in the date range.
type MovementFilter struct {
	LocationType string
	LocationID   string
	ProductID    string
	VariantSize  string
	Kinds        []string
	Shortage     bool
	Giveaway     *bool
	From, To     *time.Time
}

// SingleSKU reports whether the filter names one SKU (the saldo header needs both parts).
func (f MovementFilter) SingleSKU() bool { return f.ProductID != "" && f.VariantSize != "" }

// ErrBadCursor is returned for a cursor that is not one this package issued.
var ErrBadCursor = errors.New("invalid cursor")

// EncodeMovementCursor makes the opaque keyset cursor for the given seq.
func EncodeMovementCursor(seq int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte("s" + strconv.FormatInt(seq, 10)))
}

// DecodeMovementCursor reads a cursor made by EncodeMovementCursor.
func DecodeMovementCursor(c string) (int64, error) {
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil || len(raw) < 2 || raw[0] != 's' {
		return 0, ErrBadCursor
	}
	seq, err := strconv.ParseInt(string(raw[1:]), 10, 64)
	if err != nil || seq < 1 {
		return 0, ErrBadCursor
	}
	return seq, nil
}

// LocationZone returns the timezone of an outlet or warehouse and whether the location exists.
// Warehouses have no timezone of their own and read in the default zone.
func (r *Repo) LocationZone(ctx context.Context, locType, locID string) (*time.Location, bool, error) {
	if locType == "warehouse" {
		var n int
		if err := r.Pool.QueryRow(ctx, `SELECT count(*) FROM warehouses WHERE id=$1`, locID).Scan(&n); err != nil {
			return nil, false, fmt.Errorf("warehouse lookup: %w", err)
		}
		return bizday.Zone(""), n > 0, nil
	}
	var tz string
	err := r.Pool.QueryRow(ctx, `SELECT timezone FROM outlets WHERE id=$1`, locID).Scan(&tz)
	if errors.Is(err, pgx.ErrNoRows) {
		return bizday.Zone(""), false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("outlet lookup: %w", err)
	}
	return bizday.Zone(tz), true, nil
}

// movementWhere builds the WHERE of the row list over `stock_movements m` and its args.
// withChips adds the kind/flag/giveaway narrowing; the cursor is added by the caller.
func movementWhere(f MovementFilter, withChips bool) (string, []any) {
	args := []any{f.LocationType, f.LocationID}
	add := func(v any) int {
		args = append(args, v)
		return len(args)
	}
	where := "m.location_type=$1 AND m.location_id=$2"
	if f.ProductID != "" {
		where += fmt.Sprintf(" AND m.product_id=$%d", add(f.ProductID))
	}
	if f.VariantSize != "" {
		where += fmt.Sprintf(" AND m.variant_size=$%d", add(f.VariantSize))
	}
	if f.From != nil {
		where += fmt.Sprintf(" AND m.occurred_at >= $%d", add(*f.From))
	}
	if f.To != nil {
		where += fmt.Sprintf(" AND m.occurred_at < $%d", add(*f.To))
	}
	if !withChips {
		return where, args
	}
	if len(f.Kinds) > 0 {
		where += fmt.Sprintf(" AND m.kind = ANY($%d)", add(f.Kinds))
	}
	if f.Shortage {
		where += " AND 'shortage' = ANY(m.flags)"
	}
	if f.Giveaway != nil {
		if *f.Giveaway {
			where += " AND m.dedupe_key LIKE 'giveaway:%'"
		} else {
			where += " AND m.dedupe_key NOT LIKE 'giveaway:%'"
		}
	}
	return where, args
}

const movementSelect = `
SELECT m.id, m.seq, m.occurred_at, m.recorded_at, m.kind, m.location_type, m.location_id,
  COALESCE(lo.name, lw.name), p.name, m.product_id, m.variant_size, NULLIF(v.sku,''), v.barcode,
  m.qty, m.qty_before, m.qty_after, m.ref_type, m.ref_id, m.ref_number, m.flags,
  (m.dedupe_key LIKE 'giveaway:%'), m.actor, u.display_name, wsa.reason, eo.status
FROM stock_movements m
LEFT JOIN outlets lo ON m.location_type='outlet' AND lo.id=m.location_id
LEFT JOIN warehouses lw ON m.location_type='warehouse' AND lw.id=m.location_id
LEFT JOIN products p ON p.id=m.product_id
LEFT JOIN LATERAL (SELECT sku, barcode FROM product_variants pv
                   WHERE pv.product_id=m.product_id AND pv.size=m.variant_size LIMIT 1) v ON true
LEFT JOIN users u ON u.id::text = m.actor
LEFT JOIN warehouse_stock_adjustments wsa ON m.ref_type='stock_adjustment' AND wsa.id=m.ref_id
LEFT JOIN erp_outbox eo ON eo.document_id=m.document_id`

// ForEachMovement streams the filtered rows newest first by seq (seq DESC), at most limit
// rows (limit <= 0: no cap), starting after the cursor seq when afterSeq > 0. The saldo of a
// row is its QtyAfter: the chain is continuous in seq order, not in occurred_at order.
func (r *Repo) ForEachMovement(ctx context.Context, f MovementFilter, afterSeq int64, limit int, fn func(api.StockMovementRow) error) error {
	where, args := movementWhere(f, true)
	if afterSeq > 0 {
		args = append(args, afterSeq)
		where += fmt.Sprintf(" AND m.seq < $%d", len(args))
	}
	sql := movementSelect + " WHERE " + where + " ORDER BY m.seq DESC"
	if limit > 0 {
		sql += fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := r.Pool.Query(ctx, sql, args...)
	if err != nil {
		return fmt.Errorf("movements query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		row, err := scanMovement(rows)
		if err != nil {
			return err
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return rows.Err()
}

func scanMovement(rows pgx.Rows) (api.StockMovementRow, error) {
	var (
		m                                   api.StockMovementRow
		kind, locType                       string
		locName, prodName, sku, barcode     *string
		refID                               *openapi_types.UUID
		refNumber, actor, actorName, reason *string
		erpStatus                           *string
	)
	err := rows.Scan(&m.Id, &m.Seq, &m.OccurredAt, &m.RecordedAt, &kind, &locType, &m.LocationId,
		&locName, &prodName, &m.ProductId, &m.VariantSize, &sku, &barcode,
		&m.Qty, &m.QtyBefore, &m.QtyAfter, &m.RefType, &refID, &refNumber, &m.Flags,
		&m.IsGiveaway, &actor, &actorName, &reason, &erpStatus)
	if err != nil {
		return m, fmt.Errorf("movement scan: %w", err)
	}
	m.Kind = api.StockMovementRowKind(kind)
	m.LocationType = api.InventoryLocationType(locType)
	m.LocationName, m.ProductName, m.Sku, m.Barcode = locName, prodName, sku, barcode
	m.RefId, m.RefNumber, m.ActorId, m.ActorName, m.ReasonText, m.ErpStatus = refID, refNumber, actor, actorName, reason, erpStatus
	if m.Flags == nil {
		m.Flags = []string{}
	}
	return m, nil
}

// CountMovements counts the filtered rows, stopping at max+1 (an export cap check).
func (r *Repo) CountMovements(ctx context.Context, f MovementFilter, max int) (int, error) {
	where, args := movementWhere(f, true)
	var n int
	err := r.Pool.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM stock_movements m WHERE `+where+
		fmt.Sprintf(` LIMIT %d) c`, max+1), args...).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("movements count: %w", err)
	}
	return n, nil
}

// MovementSaldo is the saldo header of one SKU over the date range, ignoring the kind, flag and
// giveaway chips so that opening + in - out = closing always holds:
//   - opening = qty_before of the first in-range row (lowest seq), closing = qty_after of the last;
//   - with no row in range, both are the balance at the last earlier row (highest seq among rows
//     before From). A SKU whose history only starts after the range falls back to the first later
//     row's qty_before; a SKU with no history reads 0.
func (r *Repo) MovementSaldo(ctx context.Context, f MovementFilter) (api.StockMovementSummary, error) {
	where, args := movementWhere(f, false)
	var (
		out     api.StockMovementSummary
		n       int
		opening *int
		closing *int
	)
	err := r.Pool.QueryRow(ctx, `
SELECT count(*), COALESCE(SUM(CASE WHEN m.qty > 0 THEN m.qty ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN m.qty < 0 THEN -m.qty ELSE 0 END), 0),
       (array_agg(m.qty_before ORDER BY m.seq ASC))[1], (array_agg(m.qty_after ORDER BY m.seq DESC))[1]
FROM stock_movements m WHERE `+where, args...).Scan(&n, &out.TotalIn, &out.TotalOut, &opening, &closing)
	if err != nil {
		return out, fmt.Errorf("saldo query: %w", err)
	}
	if n > 0 && opening != nil && closing != nil {
		out.Opening, out.Closing = *opening, *closing
		return out, nil
	}
	bal, err := r.balanceOutsideRange(ctx, f)
	if err != nil {
		return out, err
	}
	out.Opening, out.Closing = bal, bal
	return out, nil
}

// balanceOutsideRange reads the SKU balance when no row falls in the range (see MovementSaldo).
func (r *Repo) balanceOutsideRange(ctx context.Context, f MovementFilter) (int, error) {
	base := `FROM stock_movements m WHERE m.location_type=$1 AND m.location_id=$2 AND m.product_id=$3 AND m.variant_size=$4`
	args := []any{f.LocationType, f.LocationID, f.ProductID, f.VariantSize}
	var bal int
	if f.From != nil {
		err := r.Pool.QueryRow(ctx, `SELECT m.qty_after `+base+` AND m.occurred_at < $5 ORDER BY m.seq DESC LIMIT 1`,
			append(args, *f.From)...).Scan(&bal)
		if err == nil {
			return bal, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return 0, fmt.Errorf("balance before range: %w", err)
		}
	}
	err := r.Pool.QueryRow(ctx, `SELECT m.qty_before `+base+` ORDER BY m.seq ASC LIMIT 1`, args...).Scan(&bal)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("balance first row: %w", err)
	}
	return bal, nil
}

// MovementLedgerSummary returns one line per SKU of the location: opening, incoming and outgoing
// quantity by kind over [from, to), and closing, all from the ledger. A SKU with history but no
// movement in range still shows, with opening = closing = its balance at the last earlier row.
func (r *Repo) MovementLedgerSummary(ctx context.Context, locType, locID string, from, to *time.Time, q string, page, limit int) ([]api.MovementLedgerSummaryRow, int, error) {
	inRange := "m.location_type=$1 AND m.location_id=$2"
	args := []any{locType, locID}
	if from != nil {
		args = append(args, *from)
		inRange += fmt.Sprintf(" AND m.occurred_at >= $%d", len(args))
	}
	if to != nil {
		args = append(args, *to)
		inRange += fmt.Sprintf(" AND m.occurred_at < $%d", len(args))
	}
	prevCond := "false"
	if from != nil {
		prevCond = "m.occurred_at < $3"
	}
	args = append(args, "%"+likeEscape(strings.TrimSpace(q))+"%", off(page, limit), limit)
	qArg, offArg, limArg := len(args)-2, len(args)-1, len(args)
	sql := fmt.Sprintf(`
WITH rng AS (
  SELECT product_id, variant_size, kind, qty, qty_before, qty_after, seq
  FROM stock_movements m WHERE %[1]s
),
firsts AS (SELECT DISTINCT ON (product_id, variant_size) product_id, variant_size, qty_before
           FROM rng ORDER BY product_id, variant_size, seq ASC),
lasts AS (SELECT DISTINCT ON (product_id, variant_size) product_id, variant_size, qty_after
          FROM rng ORDER BY product_id, variant_size, seq DESC),
prev AS (SELECT DISTINCT ON (product_id, variant_size) product_id, variant_size, qty_after
         FROM stock_movements m WHERE m.location_type=$1 AND m.location_id=$2 AND %[2]s
         ORDER BY product_id, variant_size, seq DESC),
bykind AS (SELECT product_id, variant_size, kind,
             SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) AS qin, SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS qout
           FROM rng GROUP BY 1,2,3),
kagg AS (SELECT product_id, variant_size,
           COALESCE(jsonb_object_agg(kind, qin) FILTER (WHERE qin > 0), '{}'::jsonb) AS in_by,
           COALESCE(jsonb_object_agg(kind, qout) FILTER (WHERE qout > 0), '{}'::jsonb) AS out_by
         FROM bykind GROUP BY 1,2),
skus AS (SELECT product_id, variant_size FROM firsts UNION SELECT product_id, variant_size FROM prev)
SELECT json_build_object(
  'productId', s.product_id, 'productName', COALESCE(p.name, ''), 'variantSize', s.variant_size,
  'sku', COALESCE(v.sku, ''), 'barcode', v.barcode,
  'opening', COALESCE(f.qty_before, pv.qty_after, 0), 'closing', COALESCE(l.qty_after, pv.qty_after, 0),
  'inByKind', COALESCE(k.in_by, '{}'::jsonb), 'outByKind', COALESCE(k.out_by, '{}'::jsonb)
), COUNT(*) OVER ()
FROM skus s
LEFT JOIN firsts f ON f.product_id=s.product_id AND f.variant_size=s.variant_size
LEFT JOIN lasts l ON l.product_id=s.product_id AND l.variant_size=s.variant_size
LEFT JOIN prev pv ON pv.product_id=s.product_id AND pv.variant_size=s.variant_size
LEFT JOIN kagg k ON k.product_id=s.product_id AND k.variant_size=s.variant_size
LEFT JOIN products p ON p.id=s.product_id
LEFT JOIN LATERAL (SELECT sku, barcode FROM product_variants pv2
                   WHERE pv2.product_id=s.product_id AND pv2.size=s.variant_size LIMIT 1) v ON true
WHERE ($%[3]d = '%%%%' OR p.name ILIKE $%[3]d OR v.sku ILIKE $%[3]d OR v.barcode ILIKE $%[3]d)
ORDER BY p.name, s.variant_size, s.product_id
OFFSET $%[4]d LIMIT $%[5]d`, inRange, prevCond, qArg, offArg, limArg)
	return listJSON[api.MovementLedgerSummaryRow](ctx, r.Pool, sql, args...)
}

// likeEscape escapes LIKE metacharacters so a search term matches literally.
func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
