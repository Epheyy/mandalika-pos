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
	"github.com/mandalika/pos-backend/internal/ledger"
)

// MovementFilter selects ledger rows of ONE location (kartu stok). From/To are resolved
// instants over TIME RECORDED (recorded_at), [From, To); the repo turns them into a seq Window
// (see SeqWindow, ResolveWindow) that every query uses. Kinds, Shortage and Giveaway narrow the row list
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
	// Window is the seq window of From/To; call Repo.ResolveWindow before querying.
	Window SeqWindow
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
	where, args = windowSQL(f.Window, where, args)
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
  (m.dedupe_key LIKE 'giveaway:%'), m.actor, u.display_name, COALESCE(wsa.reason, CASE WHEN sci.reason_code IS NOT NULL THEN sci.reason_text ELSE sc.reason_text END, NULLIF(orf.reason, '')), eo.status,
  COALESCE(wsa.reason_code, sci.reason_code, sc.reason_code), au.display_name, sar.number, pb.number,
  COALESCE(gr.source = 'warranty', false), sar.id, orf.seq
FROM stock_movements m
LEFT JOIN LATERAL (SELECT r.seq, r.reason FROM order_refunds r
                   WHERE m.kind='refund' AND r.order_id = m.ref_id
                     AND (m.dedupe_key LIKE r.ledger_document_key || ':%'
                          OR (r.ledger_document_key = 'refund:' || r.order_id AND m.dedupe_key NOT LIKE 'refund:%:%'))
                   ORDER BY r.seq LIMIT 1) orf ON true
LEFT JOIN outlets lo ON m.location_type='outlet' AND lo.id=m.location_id
LEFT JOIN warehouses lw ON m.location_type='warehouse' AND lw.id=m.location_id
LEFT JOIN products p ON p.id=m.product_id
LEFT JOIN LATERAL (SELECT sku, barcode FROM product_variants pv
                   WHERE pv.product_id=m.product_id AND pv.size=m.variant_size LIMIT 1) v ON true
LEFT JOIN users u ON u.id::text = m.actor
LEFT JOIN goods_receipts gr ON m.kind='receipt' AND m.ref_type='goods_receipt' AND gr.id = m.ref_id
LEFT JOIN warehouse_stock_adjustments wsa ON m.ref_type='stock_adjustment' AND wsa.id=m.ref_id
LEFT JOIN stock_adjustment_requests sar ON wsa.request_id = sar.id
LEFT JOIN stock_counts sc ON m.ref_type='stock_count' AND sc.id=m.ref_id
LEFT JOIN stock_count_items sci ON m.ref_type='stock_count' AND sci.stock_count_id=m.ref_id
                               AND sci.product_id=m.product_id AND sci.variant_size=m.variant_size
LEFT JOIN users au ON au.id = COALESCE(sar.approved_by, sc.approved_by)
LEFT JOIN LATERAL (SELECT sr.number FROM inventory_doc_events e
                   JOIN stock_requisitions sr ON sr.id = e.doc_id
                   WHERE m.ref_type='transfer' AND e.doc_type='requisition'
                     AND e.action IN ('fulfilled','refulfilled') AND e.data->>'transferId' = m.ref_id::text -- index inventory_doc_events_transfer (0075)
                   ORDER BY e.at DESC LIMIT 1) pb ON true
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
		m                                         api.StockMovementRow
		kind, locType                             string
		locName, prodName, sku, barcode           *string
		refID                                     *openapi_types.UUID
		refNumber, actor, actorName, reason       *string
		erpStatus                                 *string
		reasonCode, approver, docNumber, pbNumber *string
		requestID                                 *openapi_types.UUID
		isWarranty                                bool
		refundSeq                                 *int
	)
	err := rows.Scan(&m.Id, &m.Seq, &m.OccurredAt, &m.RecordedAt, &kind, &locType, &m.LocationId,
		&locName, &prodName, &m.ProductId, &m.VariantSize, &sku, &barcode,
		&m.Qty, &m.QtyBefore, &m.QtyAfter, &m.RefType, &refID, &refNumber, &m.Flags,
		&m.IsGiveaway, &actor, &actorName, &reason, &erpStatus, &reasonCode, &approver, &docNumber, &pbNumber,
		&isWarranty, &requestID, &refundSeq)
	if err != nil {
		return m, fmt.Errorf("movement scan: %w", err)
	}
	m.Kind = api.StockMovementRowKind(kind)
	m.LocationType = api.InventoryLocationType(locType)
	m.LocationName, m.ProductName, m.Sku, m.Barcode = locName, prodName, sku, barcode
	m.RefId, m.RefNumber, m.ActorId, m.ActorName, m.ReasonText, m.ErpStatus = refID, refNumber, actor, actorName, reason, erpStatus
	if reasonCode != nil {
		rc := api.InventoryReasonCode(*reasonCode)
		m.ReasonCode = &rc
	}
	m.ApprovedByName, m.DocNumber, m.RequisitionNumber = approver, docNumber, pbNumber
	m.RequestId = requestID
	m.RefundSeq = refundSeq
	if isWarranty {
		m.IsWarranty = &isWarranty
	}
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

// MovementSaldo is the saldo header of one SKU over the window, ignoring the kind, flag and
// giveaway chips so that opening + in - out = closing always holds:
//   - opening = qty_before of the first row in the window (lowest seq), closing = qty_after of the last;
//   - with no row of the SKU in the window, both are qty_after of the SKU's last row with seq
//     below the window (0 if none).
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
	var bal int
	err = r.Pool.QueryRow(ctx, `SELECT m.qty_after FROM stock_movements m
WHERE m.location_type=$1 AND m.location_id=$2 AND m.product_id=$3 AND m.variant_size=$4 AND m.seq < $5
ORDER BY m.seq DESC LIMIT 1`, f.LocationType, f.LocationID, f.ProductID, f.VariantSize, f.Window.Before).Scan(&bal)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, fmt.Errorf("balance before window: %w", err)
	}
	out.Opening, out.Closing = bal, bal
	return out, nil
}

// MovementLedgerSummary returns one line per SKU of the location: opening, the signed quantity per
// bucket (ledger.BucketOf), the by-kind in/out quantities over the seq window of the range (time
// recorded), and closing, all from the ledger. A SKU with history but no movement in the window
// still shows, with opening = closing = its balance at its last earlier row (seq below the window).
func (r *Repo) MovementLedgerSummary(ctx context.Context, w SeqWindow, locType, locID, q string, page, limit int) ([]api.MovementLedgerSummaryRow, int, error) {
	return r.movementLedgerSummary(ctx, w, locType, locID, q, off(page, limit), &limit)
}

// MovementLedgerSummaryAll is MovementLedgerSummary without paging, for the export: at most
// maxRows rows (the caller treats maxRows+1 as over the cap).
func (r *Repo) MovementLedgerSummaryAll(ctx context.Context, w SeqWindow, locType, locID, q string, maxRows int) ([]api.MovementLedgerSummaryRow, error) {
	limit := maxRows + 1
	rows, _, err := r.movementLedgerSummary(ctx, w, locType, locID, q, 0, &limit)
	return rows, err
}

func (r *Repo) movementLedgerSummary(ctx context.Context, w SeqWindow, locType, locID, q string, offset int, limit *int) ([]api.MovementLedgerSummaryRow, int, error) {
	inRange, args := windowSQL(w, "m.location_type=$1 AND m.location_id=$2", []any{locType, locID})
	args = append(args, w.Before)
	prevCond := fmt.Sprintf("m.seq < $%d", len(args))
	if !w.Resolved {
		prevCond = "false"
	}
	args = append(args, "%"+likeEscape(strings.TrimSpace(q))+"%", offset, limit)
	qArg, offArg, limArg := len(args)-2, len(args)-1, len(args)
	sql := fmt.Sprintf(`
WITH rng AS (
  SELECT m.product_id, m.variant_size, m.kind, m.qty, m.qty_before, m.qty_after, m.seq,
         (m.dedupe_key LIKE 'giveaway:%%') AS giveaway,
         COALESCE(gr.source = 'warranty', false) AS warranty,
         (t.source_warehouse_id IS NOT NULL) AS src_wh
  FROM stock_movements m
  LEFT JOIN goods_receipts gr ON m.kind='receipt' AND m.ref_type='goods_receipt' AND gr.id = m.ref_id
  LEFT JOIN transfers t ON m.kind='transfer_in' AND m.ref_type='transfer' AND t.id = m.ref_id
  WHERE %[1]s
),
firsts AS (SELECT DISTINCT ON (product_id, variant_size) product_id, variant_size, qty_before
           FROM rng ORDER BY product_id, variant_size, seq ASC),
lasts AS (SELECT DISTINCT ON (product_id, variant_size) product_id, variant_size, qty_after
          FROM rng ORDER BY product_id, variant_size, seq DESC),
prev AS (SELECT DISTINCT ON (product_id, variant_size) product_id, variant_size, qty_after
         FROM stock_movements m WHERE m.location_type=$1 AND m.location_id=$2 AND %[2]s
         ORDER BY product_id, variant_size, seq DESC),
grp AS (SELECT product_id, variant_size, kind, giveaway, warranty, COALESCE(src_wh, false) AS src_wh,
             SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) AS qin, SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END) AS qout
           FROM rng GROUP BY 1,2,3,4,5,6),
gagg AS (SELECT product_id, variant_size,
           jsonb_agg(jsonb_build_object('kind', kind, 'giveaway', giveaway, 'warranty', warranty,
                                        'srcWh', src_wh, 'qin', qin, 'qout', qout)) AS groups
         FROM grp GROUP BY 1,2),
skus AS (SELECT product_id, variant_size FROM firsts UNION SELECT product_id, variant_size FROM prev)
SELECT json_build_object(
  'productId', s.product_id, 'productName', COALESCE(p.name, ''), 'variantSize', s.variant_size,
  'sku', COALESCE(v.sku, ''), 'barcode', v.barcode,
  'opening', COALESCE(f.qty_before, pv.qty_after, 0), 'closing', COALESCE(l.qty_after, pv.qty_after, 0),
  'groups', COALESCE(k.groups, '[]'::jsonb)
), COUNT(*) OVER ()
FROM skus s
LEFT JOIN firsts f ON f.product_id=s.product_id AND f.variant_size=s.variant_size
LEFT JOIN lasts l ON l.product_id=s.product_id AND l.variant_size=s.variant_size
LEFT JOIN prev pv ON pv.product_id=s.product_id AND pv.variant_size=s.variant_size
LEFT JOIN gagg k ON k.product_id=s.product_id AND k.variant_size=s.variant_size
LEFT JOIN products p ON p.id=s.product_id
LEFT JOIN LATERAL (SELECT sku, barcode FROM product_variants pv2
                   WHERE pv2.product_id=s.product_id AND pv2.size=s.variant_size LIMIT 1) v ON true
WHERE ($%[3]d = '%%%%' OR p.name ILIKE $%[3]d OR v.sku ILIKE $%[3]d OR v.barcode ILIKE $%[3]d)
ORDER BY p.name, s.variant_size, s.product_id
OFFSET $%[4]d LIMIT $%[5]d`, inRange, prevCond, qArg, offArg, limArg)
	raws, total, err := listJSON[summaryRowRaw](ctx, r.Pool, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	out := make([]api.MovementLedgerSummaryRow, 0, len(raws))
	for _, raw := range raws {
		row := raw.MovementLedgerSummaryRow
		row.Buckets, row.MasukGaransi, row.InByKind, row.OutByKind, err = foldGroups(ledger.LocationType(locType), raw.Groups)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, row)
	}
	return out, total, nil
}

// likeEscape escapes LIKE metacharacters so a search term matches literally.
func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// MovementSkus lists up to limit variants matching q that have a ledger row at the location.
func (r *Repo) MovementSkus(ctx context.Context, locType, locID, q string, limit int) ([]api.MovementSku, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return []api.MovementSku{}, nil
	}
	rows, err := r.Pool.Query(ctx, `
SELECT v.product_id, p.name, v.size, v.sku, v.barcode
FROM product_variants v JOIN products p ON p.id = v.product_id
WHERE (p.name ILIKE $3 OR v.sku ILIKE $3 OR v.barcode ILIKE $3)
  AND EXISTS (SELECT 1 FROM stock_movements m WHERE m.location_type=$1 AND m.location_id=$2
              AND m.product_id=v.product_id AND m.variant_size=v.size)
ORDER BY p.name, v.size LIMIT $4`, locType, locID, "%"+likeEscape(q)+"%", limit)
	if err != nil {
		return nil, fmt.Errorf("sku search: %w", err)
	}
	defer rows.Close()
	out := []api.MovementSku{}
	for rows.Next() {
		var m api.MovementSku
		if err := rows.Scan(&m.ProductId, &m.ProductName, &m.VariantSize, &m.Sku, &m.Barcode); err != nil {
			return nil, fmt.Errorf("sku search scan: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
