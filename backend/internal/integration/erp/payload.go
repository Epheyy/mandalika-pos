package erp

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrNoMovements marks an outbox row whose document has no stock_movements: it can
// never be sent, so the relay dead-letters it.
var ErrNoMovements = errors.New("erp: document has no stock movements")

// ErrUnknownKind marks a document kind the contract does not define.
var ErrUnknownKind = errors.New("erp: unknown document kind")

const (
	maxHeldVariants = 5
	sentFlagPrefix  = "sent:"
)

var knownKinds = map[string]bool{
	"sale": true, "refund": true, "transfer_out": true, "transfer_in": true, "transfer_cancel": true,
	"receipt": true, "adjust": true, "count": true, "opening": true, "write_off": true,
}

// tenderMethods are the payment methods the contract defines. POS payment methods are
// freeform since migration 0005, so anything else is omitted rather than guessed.
var tenderMethods = map[string]bool{"cash": true, "card": true, "transfer": true, "qris": true}

// OutboxHeader is the erp_outbox row the document is built for.
type OutboxHeader struct {
	ID, DocumentID, Kind, LocationType, LocationID string
	RefType, RefID, RefNumber                      string
	Part, PartCount                                int
	CreatedAt                                      time.Time
}

// MovementRow is one stock_movements row plus its ERP finished-goods code.
type MovementRow struct {
	ID, ProductID, VariantSize string
	Qty, QtyBefore, QtyAfter   int
	Flags                      []string
	RefundOfMovementID         string
	RefLine                    string
	OccurredAt                 time.Time
	Actor, DeviceID            string
	FgCode                     string // "" = variant not mapped
}

// OrderInfo is what a sale/refund document needs from its order.
type OrderInfo struct {
	PaymentMethod string
	Total         int64
	LinePrice     map[string]int64 // order_items.id -> rounded price
}

// BuildInput is everything BuildDocument needs; it holds no connection.
type BuildInput struct {
	Header       OutboxHeader
	LocationSlug string // "" = not mapped
	Movements    []MovementRow
	Order        *OrderInfo
	Brand        string
}

// BuildDocument builds the wire document. A non-empty holdReason means a mapping is
// missing: the row is held and retried later without counting an attempt. An error
// means the document can never be sent.
func BuildDocument(in BuildInput) (doc StockDocument, holdReason string, err error) {
	h := in.Header
	if !knownKinds[h.Kind] {
		return StockDocument{}, "", fmt.Errorf("%w: %q", ErrUnknownKind, h.Kind)
	}
	if len(in.Movements) == 0 {
		return StockDocument{}, "", ErrNoMovements
	}
	if in.LocationSlug == "" {
		return StockDocument{}, fmt.Sprintf("lokasi %s %s belum dipetakan ke ERP (erp_slug kosong)",
			h.LocationType, h.LocationID), nil
	}
	if reason := unmappedVariants(in.Movements); reason != "" {
		return StockDocument{}, reason, nil
	}

	doc = StockDocument{
		DocumentID: h.DocumentID,
		Kind:       h.Kind,
		Source:     buildSource(in),
		Location:   DocumentLocation{Type: h.LocationType, Slug: in.LocationSlug},
		OccurredAt: in.Movements[0].OccurredAt.UTC().Format(time.RFC3339),
		RecordedAt: h.CreatedAt.UTC().Format(time.RFC3339),
		Ref:        DocumentRef{Type: h.RefType, ID: h.RefID, Number: h.RefNumber},
		Lines:      make([]StockLine, 0, len(in.Movements)),
	}
	if h.PartCount > 1 {
		doc.Part = &DocumentPart{Index: h.Part, Count: h.PartCount}
	}
	for _, m := range in.Movements {
		doc.Lines = append(doc.Lines, buildLine(h.Kind, m, in.Order))
	}
	doc.Tenders = buildTenders(h, in.Order)
	return doc, "", nil
}

// unmappedVariants returns the hold reason for movements without an fg_code, or "".
func unmappedVariants(ms []MovementRow) string {
	seen := map[string]bool{}
	var missing []string
	for _, m := range ms {
		if m.FgCode != "" {
			continue
		}
		key := m.ProductID + " " + m.VariantSize
		if !seen[key] {
			seen[key] = true
			missing = append(missing, key)
		}
	}
	if len(missing) == 0 {
		return ""
	}
	shown := missing
	if len(shown) > maxHeldVariants {
		shown = shown[:maxHeldVariants]
	}
	reason := "varian belum dipetakan ke ERP: " + strings.Join(shown, ", ")
	if extra := len(missing) - len(shown); extra > 0 {
		reason += fmt.Sprintf(", +%d lainnya", extra)
	}
	return reason
}

func buildSource(in BuildInput) DocumentSource {
	src := DocumentSource{System: "pos", Brand: in.Brand}
	for _, m := range in.Movements {
		if src.DeviceID == "" {
			src.DeviceID = m.DeviceID
		}
		if src.Actor == "" {
			src.Actor = m.Actor
		}
	}
	return src
}

func buildLine(kind string, m MovementRow, order *OrderInfo) StockLine {
	line := StockLine{
		MovementID: m.ID, FgCode: m.FgCode,
		Qty: int64(m.Qty), QtyBefore: int64(m.QtyBefore), QtyAfter: int64(m.QtyAfter),
		Reason: kind, Flags: []string{}, RefundOfMovementID: m.RefundOfMovementID,
	}
	sent := -1
	for _, f := range m.Flags {
		if rest, ok := strings.CutPrefix(f, sentFlagPrefix); ok {
			if n, err := strconv.Atoi(rest); err == nil {
				sent = n
			}
			continue
		}
		line.Flags = append(line.Flags, f)
	}
	if kind == "transfer_in" {
		expected := int64(m.Qty)
		if sent >= 0 {
			expected = int64(sent)
		}
		line.ExpectedQty = &expected
	}
	if (kind == "sale" || kind == "refund") && order != nil {
		if p, ok := order.LinePrice[m.RefLine]; ok {
			line.UnitPrice = &p
		}
	}
	return line
}

// buildTenders puts the payment on the unsplit document or its first part only, so a
// split order never double counts.
func buildTenders(h OutboxHeader, order *OrderInfo) []Tender {
	if order == nil || h.Part > 1 || !tenderMethods[order.PaymentMethod] {
		return nil
	}
	switch h.Kind {
	case "sale":
		return []Tender{{Method: order.PaymentMethod, Amount: order.Total}}
	case "refund":
		return []Tender{{Method: order.PaymentMethod, Amount: -order.Total}}
	}
	return nil
}

// Querier is the read side of a pool or transaction.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// The erp_slug columns arrive with migration 0066; reading them through to_jsonb keeps
// the same SQL valid before and after it (NULL while the column does not exist).
const (
	outletSlugSQL    = `SELECT to_jsonb(o)->>'erp_slug' FROM outlets o WHERE o.id=$1`
	warehouseSlugSQL = `SELECT to_jsonb(w)->>'erp_slug' FROM warehouses w WHERE w.id=$1`

	movementsSQL = `
SELECT m.id::text, m.product_id::text, m.variant_size, m.qty, m.qty_before, m.qty_after, m.flags,
  COALESCE(m.refund_of_movement_id::text,''), COALESCE(m.ref_line,''), m.occurred_at,
  COALESCE(m.actor,''), COALESCE(m.device_id,''),
  COALESCE((SELECT v.sku FROM product_variants v WHERE v.product_id=m.product_id AND v.size=m.variant_size
            AND to_jsonb(v)->>'erp_slug' IS NOT NULL AND v.sku <> '' ORDER BY v.id LIMIT 1), '')
FROM stock_movements m WHERE m.document_id=$1 ORDER BY m.seq`

	orderSQL      = `SELECT o.payment_method, round(o.total)::bigint FROM orders o WHERE o.id=$1`
	orderItemsSQL = `SELECT oi.id::text, round(oi.price)::bigint FROM order_items oi WHERE oi.order_id=$1`
)

// LoadBuildInput reads everything BuildDocument needs for one outbox row. Plain reads
// (autocommit pool queries), no transaction.
func LoadBuildInput(ctx context.Context, q Querier, h OutboxHeader, brand string) (BuildInput, error) {
	in := BuildInput{Header: h, Brand: brand}
	slugSQL := outletSlugSQL
	if h.LocationType == "warehouse" {
		slugSQL = warehouseSlugSQL
	}
	var slug *string
	if err := q.QueryRow(ctx, slugSQL, h.LocationID).Scan(&slug); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return in, fmt.Errorf("erp: load location slug: %w", err)
	}
	if slug != nil {
		in.LocationSlug = *slug
	}
	ms, err := loadMovements(ctx, q, h.DocumentID)
	if err != nil {
		return in, err
	}
	in.Movements = ms
	if (h.Kind == "sale" || h.Kind == "refund") && h.RefType == "order" {
		if in.Order, err = loadOrder(ctx, q, h.RefID); err != nil {
			return in, err
		}
	}
	return in, nil
}

func loadMovements(ctx context.Context, q Querier, documentID string) ([]MovementRow, error) {
	rows, err := q.Query(ctx, movementsSQL, documentID)
	if err != nil {
		return nil, fmt.Errorf("erp: load movements: %w", err)
	}
	defer rows.Close()
	var out []MovementRow
	for rows.Next() {
		var m MovementRow
		if err := rows.Scan(&m.ID, &m.ProductID, &m.VariantSize, &m.Qty, &m.QtyBefore, &m.QtyAfter, &m.Flags,
			&m.RefundOfMovementID, &m.RefLine, &m.OccurredAt, &m.Actor, &m.DeviceID, &m.FgCode); err != nil {
			return nil, fmt.Errorf("erp: scan movement: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("erp: read movements: %w", err)
	}
	return out, nil
}

// loadOrder returns nil (no error) when the order row is gone.
func loadOrder(ctx context.Context, q Querier, orderID string) (*OrderInfo, error) {
	info := &OrderInfo{LinePrice: map[string]int64{}}
	err := q.QueryRow(ctx, orderSQL, orderID).Scan(&info.PaymentMethod, &info.Total)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("erp: load order: %w", err)
	}
	rows, err := q.Query(ctx, orderItemsSQL, orderID)
	if err != nil {
		return nil, fmt.Errorf("erp: load order items: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var price int64
		if err := rows.Scan(&id, &price); err != nil {
			return nil, fmt.Errorf("erp: scan order item: %w", err)
		}
		info.LinePrice[id] = price
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("erp: read order items: %w", err)
	}
	return info, nil
}
