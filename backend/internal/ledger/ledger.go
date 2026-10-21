package ledger

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Stock movement ledger (plan §2). Every stock change is recorded as one row per
// non-zero line in stock_movements, inside the caller's transaction. The table is
// append-only (ledger_guard_test.go) and there is no database trigger on purpose: the
// stock guards in write/stockseq_guard_test.go reject one (lock-order cycle).
//
// Call order inside a non-frozen writer: Record/RecordDeltas BEFORE BumpStockSeq, so
// "the bump is the last stock/version statement" stays literally true. This package
// reads stock (RecordDeltas post-read, backfill) but never writes it.

// MaxLinesPerDocument is the largest document the ERP contract accepts (handoff §4.6).
// A bigger document is split into parts, each with its own document id.
const MaxLinesPerDocument = 200

// idNamespace seeds every deterministic id below. It is a random v4 uuid generated once
// and hard-coded; it must NEVER change, or every id (and so every dedupe against rows
// already written or already sent to the ERP) changes with it.
var idNamespace = uuid.MustParse("5b0d6c1e-3f4a-4d79-8a2c-9e61b7f0c4d3")

type Kind string

const (
	KindSale           Kind = "sale"
	KindRefund         Kind = "refund"
	KindTransferOut    Kind = "transfer_out"
	KindTransferIn     Kind = "transfer_in"
	KindTransferCancel Kind = "transfer_cancel"
	KindReceipt        Kind = "receipt"
	KindAdjust         Kind = "adjust"
	KindCount          Kind = "count"
	KindOpening        Kind = "opening"
	KindWriteOff       Kind = "write_off"
)

var validKinds = map[Kind]bool{
	KindSale: true, KindRefund: true, KindTransferOut: true, KindTransferIn: true,
	KindTransferCancel: true, KindReceipt: true, KindAdjust: true, KindCount: true,
	KindOpening: true, KindWriteOff: true,
}

type LocationType string

const (
	LocOutlet    LocationType = "outlet"
	LocWarehouse LocationType = "warehouse"
)

// Line is one stock movement. Qty is signed (negative = stock leaves the location).
type Line struct {
	ProductID          string
	VariantSize        string
	VariantID          string // optional
	Qty                int    // zero lines are skipped, except for KindOpening
	QtyBefore          int    // Record: caller-supplied, must satisfy QtyAfter = QtyBefore + Qty
	QtyAfter           int    // RecordDeltas: both ignored and computed from the locked row
	DedupeKey          string // required, globally unique and deterministic, e.g. "sale:<order_item_id>"
	RefLine            string // optional
	Flags              []string
	RefundOfMovementID string // optional; a movement that does not exist is stored as NULL (never aborts the sale)
}

// Document groups the lines of one business event at one location.
type Document struct {
	Key          string // deterministic, e.g. "sale:<order_id>"
	Kind         Kind
	LocationType LocationType
	LocationID   string
	RefType      string // order|transfer|goods_receipt|stock_adjustment|stock_count|product|backfill
	RefID        string // optional uuid
	RefNumber    string // optional
	Actor        string // optional
	DeviceID     string // optional
	OccurredAt   time.Time
	Lines        []Line
}

// Part describes one inserted document part. Part is 0 for an unsplit document.
type Part struct {
	DocumentID string
	Part       int
	Lines      int
	Inserted   int // rows actually inserted; fewer than Lines on a replay
}

type Result struct{ Parts []Part }

// DocumentID is the deterministic id of a document (part 0) or of one of its parts
// (n >= 1). It is the ERP Idempotency-Key.
func DocumentID(key string, part int) string {
	if part > 0 {
		key = fmt.Sprintf("%s:part:%d", key, part)
	}
	return uuid.NewSHA1(idNamespace, []byte(key)).String()
}

// MovementID is the deterministic id of the movement row with this dedupe key.
func MovementID(dedupeKey string) string {
	return uuid.NewSHA1(idNamespace, []byte("movement:"+dedupeKey)).String()
}

// Record inserts the document's non-zero lines with the before/after the caller
// supplied. Replaying the same dedupe keys inserts nothing. Callers must pass lines in
// a deterministic order: it is also the per-key application order (and so the row
// order within a key), and it decides which part a line lands in on replay.
func Record(ctx context.Context, tx pgx.Tx, doc Document) (Result, error) {
	lines, err := prepare(doc)
	if err != nil {
		return Result{}, err
	}
	for _, l := range lines {
		if l.QtyAfter != l.QtyBefore+l.Qty {
			return Result{}, fmt.Errorf("ledger: line %s: qty_after %d != qty_before %d + qty %d",
				l.DedupeKey, l.QtyAfter, l.QtyBefore, l.Qty)
		}
	}
	return insertDocument(ctx, tx, doc, lines)
}

// RecordDeltas is for writers that applied deltas and hold no before/after: it reads
// the locked rows back (after = current stock) and walks the lines in the GIVEN order
// backwards per (product, size) to get each before, so the given order must be the
// order the deltas were applied in, and deterministic across replays. The caller
// already holds the row locks from its own write, so this takes none.
func RecordDeltas(ctx context.Context, tx pgx.Tx, doc Document) (Result, error) {
	lines, err := prepare(doc)
	if err != nil {
		return Result{}, err
	}
	current, err := readStock(ctx, tx, doc, lines)
	if err != nil {
		return Result{}, err
	}
	return insertDocument(ctx, tx, doc, fillBeforeAfter(lines, current))
}

type lineKey struct{ product, size string }

// fillBeforeAfter returns a copy of lines (in the same order) with QtyBefore/QtyAfter
// set from the current stock per key: the last line of a key ends at the current
// value, each earlier line ends where the next one starts.
func fillBeforeAfter(lines []Line, current map[lineKey]int) []Line {
	cur := make(map[lineKey]int, len(current))
	for k, v := range current {
		cur[k] = v
	}
	out := make([]Line, len(lines))
	for i := len(lines) - 1; i >= 0; i-- {
		l := lines[i]
		k := lineKey{l.ProductID, l.VariantSize}
		l.QtyAfter = cur[k]
		l.QtyBefore = l.QtyAfter - l.Qty
		cur[k] = l.QtyBefore
		out[i] = l
	}
	return out
}

// prepare validates the document and returns its lines without zero-qty ones (kept for
// KindOpening), in the given order.
func prepare(doc Document) ([]Line, error) {
	if doc.Key == "" || doc.LocationID == "" || doc.RefType == "" {
		return nil, fmt.Errorf("ledger: document needs key, location id and ref type (key %q)", doc.Key)
	}
	if !validKinds[doc.Kind] {
		return nil, fmt.Errorf("ledger: document %s: unknown kind %q", doc.Key, doc.Kind)
	}
	if doc.LocationType != LocOutlet && doc.LocationType != LocWarehouse {
		return nil, fmt.Errorf("ledger: document %s: unknown location type %q", doc.Key, doc.LocationType)
	}
	if doc.OccurredAt.IsZero() {
		return nil, fmt.Errorf("ledger: document %s: occurred_at is required", doc.Key)
	}
	seen := make(map[string]bool, len(doc.Lines))
	lines := make([]Line, 0, len(doc.Lines))
	for _, l := range doc.Lines {
		if l.DedupeKey == "" || l.ProductID == "" {
			return nil, fmt.Errorf("ledger: document %s: line needs dedupe key and product id", doc.Key)
		}
		if seen[l.DedupeKey] {
			return nil, fmt.Errorf("ledger: document %s: duplicate dedupe key %s", doc.Key, l.DedupeKey)
		}
		seen[l.DedupeKey] = true
		if l.Qty == 0 && doc.Kind != KindOpening {
			continue
		}
		lines = append(lines, l)
	}
	return lines, nil
}

// splitParts stably sorts lines by (product, size) and chunks them. The caller's
// order within one key is kept, so duplicate-key chains stay chained in seq order.
// One chunk means an unsplit document (part 0); otherwise parts are numbered from 1.
func splitParts(lines []Line) [][]Line {
	sorted := append([]Line(nil), lines...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.ProductID != b.ProductID {
			return a.ProductID < b.ProductID
		}
		return a.VariantSize < b.VariantSize
	})
	var chunks [][]Line
	for len(sorted) > MaxLinesPerDocument {
		chunks = append(chunks, sorted[:MaxLinesPerDocument])
		sorted = sorted[MaxLinesPerDocument:]
	}
	if len(sorted) > 0 {
		chunks = append(chunks, sorted)
	}
	return chunks
}

func insertDocument(ctx context.Context, tx pgx.Tx, doc Document, lines []Line) (Result, error) {
	chunks := splitParts(lines)
	res := Result{Parts: make([]Part, 0, len(chunks))}
	for i, chunk := range chunks {
		part := 0
		if len(chunks) > 1 {
			part = i + 1
		}
		p := Part{DocumentID: DocumentID(doc.Key, part), Part: part, Lines: len(chunk)}
		n, err := insertLines(ctx, tx, doc, p.DocumentID, chunk)
		if err != nil {
			return Result{}, fmt.Errorf("ledger: insert %s part %d: %w", doc.Key, part, err)
		}
		p.Inserted = n
		res.Parts = append(res.Parts, p)
	}
	return res, nil
}

const insertMovementSQL = `
INSERT INTO stock_movements (id, document_id, dedupe_key, kind, location_type, location_id,
  product_id, variant_id, variant_size, qty, qty_before, qty_after, ref_type, ref_id,
  ref_number, ref_line, actor, device_id, occurred_at, flags, refund_of_movement_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,(SELECT m.id FROM stock_movements m WHERE m.id = $21::uuid))
ON CONFLICT (dedupe_key) DO NOTHING`

// insertLines sends the lines as one batch and returns how many rows were inserted.
func insertLines(ctx context.Context, tx pgx.Tx, doc Document, docID string, lines []Line) (int, error) {
	batch := &pgx.Batch{}
	for _, l := range lines {
		flags := l.Flags
		if flags == nil {
			flags = []string{}
		}
		batch.Queue(insertMovementSQL, MovementID(l.DedupeKey), docID, l.DedupeKey,
			string(doc.Kind), string(doc.LocationType), doc.LocationID,
			l.ProductID, nullable(l.VariantID), l.VariantSize, l.Qty, l.QtyBefore, l.QtyAfter,
			doc.RefType, nullable(doc.RefID), nullable(doc.RefNumber), nullable(l.RefLine),
			nullable(doc.Actor), nullable(doc.DeviceID), doc.OccurredAt, flags,
			nullable(l.RefundOfMovementID))
	}
	br := tx.SendBatch(ctx, batch)
	inserted := 0
	for range lines {
		tag, err := br.Exec()
		if err != nil {
			_ = br.Close()
			return 0, err
		}
		inserted += int(tag.RowsAffected())
	}
	return inserted, br.Close()
}

// nullable maps "" to SQL NULL.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

const (
	outletStockSQL = `
SELECT v.product_id::text, v.variant_size, v.stock FROM outlet_variant_stock v
WHERE v.outlet_id = $1
  AND (v.product_id, v.variant_size) IN (SELECT t.p::uuid, t.s FROM unnest($2::text[], $3::text[]) AS t(p, s))`
	warehouseStockSQL = `
SELECT v.product_id::text, v.variant_size, v.stock FROM warehouse_variant_stock v
WHERE v.warehouse_id = $1
  AND (v.product_id, v.variant_size) IN (SELECT t.p::uuid, t.s FROM unnest($2::text[], $3::text[]) AS t(p, s))`
)

// readStock returns the current stock of every distinct (product, size) in lines. A
// missing row is an error: the caller just applied a delta, so the row must exist.
func readStock(ctx context.Context, tx pgx.Tx, doc Document, lines []Line) (map[lineKey]int, error) {
	if len(lines) == 0 {
		return map[lineKey]int{}, nil
	}
	var products, sizes []string
	seen := map[lineKey]bool{}
	for _, l := range lines {
		k := lineKey{l.ProductID, l.VariantSize}
		if !seen[k] {
			seen[k] = true
			products = append(products, l.ProductID)
			sizes = append(sizes, l.VariantSize)
		}
	}
	sql := outletStockSQL
	if doc.LocationType == LocWarehouse {
		sql = warehouseStockSQL
	}
	rows, err := tx.Query(ctx, sql, doc.LocationID, products, sizes)
	if err != nil {
		return nil, fmt.Errorf("ledger: read stock for %s: %w", doc.Key, err)
	}
	defer rows.Close()
	current := make(map[lineKey]int, len(seen))
	for rows.Next() {
		var k lineKey
		var stock int
		if err := rows.Scan(&k.product, &k.size, &stock); err != nil {
			return nil, fmt.Errorf("ledger: scan stock for %s: %w", doc.Key, err)
		}
		current[k] = stock
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: read stock for %s: %w", doc.Key, err)
	}
	for k := range seen {
		if _, ok := current[k]; !ok {
			return nil, fmt.Errorf("ledger: document %s: no stock row for product %s size %q", doc.Key, k.product, k.size)
		}
	}
	return current, nil
}
