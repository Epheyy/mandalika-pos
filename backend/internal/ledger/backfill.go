package ledger

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// BackfillOptions selects what Backfill does. The default mode writes `opening`
// movements; Reanchor writes `adjust` movements for drift instead.
type BackfillOptions struct {
	DryRun     bool      // compute and report, insert nothing
	Reanchor   bool      // see Backfill
	RunID      string    // required in every mode; part of every document key, never reuse one
	OccurredAt time.Time // zero = now
}

// BackfillReport counts what a run did (or, in a dry run, would do).
type BackfillReport struct {
	Reanchor    bool
	KeysScanned int // stock keys and ledger-only keys seen, in either mode
	Candidates  int // keys that need a row
	Inserted    int // rows actually inserted (0 in a dry run)
	WouldInsert int // rows a dry run would insert (0 otherwise)
	Documents   int // documents (one per location) holding the candidates
	Parts       int // parts after the 200-line split
}

// stockKeyRow is one (location, product, size) with its live stock and ledger sum.
type stockKeyRow struct {
	lt, lid, pid, size string
	hasLive            bool
	live, ledger       int
	hasOpening         bool
}

// Backfill brings the ledger in line with live stock inside the caller's transaction
// (the caller rolls back a dry run). It first takes SHARE MODE on both stock tables so
// no writer moves stock while it reads, with a 5s lock_timeout: on a timeout it fails
// and the command should retry.
//
// Default (opening) mode: every stock key with no opening row yet gets an `opening`
// movement of live - (sum of its existing movements), so the invariant holds even if
// movements began before the first run. Keys that already have an opening row are
// skipped, which makes a re-run with a NEW RunID a no-op. It does NOT repair a key that
// has an opening row but has drifted since (e.g. an old revision wrote stock without
// movements during a rollout): that is what Reanchor is for.
//
// Reanchor mode: every key where live != sum of movements (stock key or ledger-only
// key) gets an `adjust` movement for the difference.
//
// RunID is part of every document key (so of its ERP document id) and must be new for
// each run that writes: if any document id it would use already exists, or a write
// run inserts fewer rows than it planned, Backfill fails instead of silently doing less.
func Backfill(ctx context.Context, tx pgx.Tx, opts BackfillOptions) (BackfillReport, error) {
	if opts.RunID == "" {
		return BackfillReport{}, errors.New("ledger: backfill needs a run id")
	}
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
		return BackfillReport{}, fmt.Errorf("ledger: backfill lock timeout: %w", err)
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE outlet_variant_stock, warehouse_variant_stock IN SHARE MODE`); err != nil {
		return BackfillReport{}, fmt.Errorf("ledger: backfill lock: %w", err)
	}
	keys, err := scanStockKeys(ctx, tx)
	if err != nil {
		return BackfillReport{}, err
	}
	if opts.OccurredAt.IsZero() {
		opts.OccurredAt = time.Now().UTC()
	}
	docs := backfillDocuments(keys, opts)
	rep := BackfillReport{Reanchor: opts.Reanchor, KeysScanned: len(keys), Documents: len(docs)}
	for _, d := range docs {
		rep.Candidates += len(d.Lines)
		rep.Parts += len(splitParts(d.Lines))
	}
	if err := checkRunIDUnused(ctx, tx, docs, opts.RunID); err != nil {
		return BackfillReport{}, err
	}
	if opts.DryRun {
		rep.WouldInsert = rep.Candidates
		return rep, nil
	}
	for _, d := range docs {
		res, err := Record(ctx, tx, d)
		if err != nil {
			return BackfillReport{}, err
		}
		for _, p := range res.Parts {
			rep.Inserted += p.Inserted
		}
	}
	if rep.Inserted < rep.Candidates {
		return BackfillReport{}, fmt.Errorf("ledger: backfill run %q inserted %d of %d planned rows", opts.RunID, rep.Inserted, rep.Candidates)
	}
	return rep, nil
}

// checkRunIDUnused fails when any document id the run would write already exists.
func checkRunIDUnused(ctx context.Context, tx pgx.Tx, docs []Document, runID string) error {
	var ids []string
	for _, d := range docs {
		n := len(splitParts(d.Lines))
		if n <= 1 {
			ids = append(ids, DocumentID(d.Key, 0))
			continue
		}
		for part := 1; part <= n; part++ {
			ids = append(ids, DocumentID(d.Key, part))
		}
	}
	if len(ids) == 0 {
		return nil
	}
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM stock_movements WHERE document_id = ANY($1::uuid[]))`, ids).Scan(&used); err != nil {
		return fmt.Errorf("ledger: backfill run id check: %w", err)
	}
	if used {
		return fmt.Errorf("ledger: backfill run id %q already used", runID)
	}
	return nil
}

const stockKeysSQL = `
WITH live AS (
  SELECT 'outlet' lt, outlet_id::text lid, product_id::text pid, variant_size, stock FROM outlet_variant_stock
  UNION ALL SELECT 'warehouse', warehouse_id::text, product_id::text, variant_size, stock FROM warehouse_variant_stock),
led AS (SELECT location_type lt, location_id::text lid, product_id::text pid, variant_size,
               sum(qty)::int s, bool_or(kind = 'opening') has_opening
          FROM stock_movements GROUP BY 1,2,3,4)
SELECT lt, lid, pid, variant_size, live.stock IS NOT NULL, COALESCE(live.stock,0),
       COALESCE(led.s,0), COALESCE(led.has_opening,false)
  FROM live FULL JOIN led USING (lt, lid, pid, variant_size)
 ORDER BY lt, lid, pid, variant_size`

func scanStockKeys(ctx context.Context, tx pgx.Tx) ([]stockKeyRow, error) {
	rows, err := tx.Query(ctx, stockKeysSQL)
	if err != nil {
		return nil, fmt.Errorf("ledger: scan stock keys: %w", err)
	}
	defer rows.Close()
	var out []stockKeyRow
	for rows.Next() {
		var k stockKeyRow
		if err := rows.Scan(&k.lt, &k.lid, &k.pid, &k.size, &k.hasLive, &k.live, &k.ledger, &k.hasOpening); err != nil {
			return nil, fmt.Errorf("ledger: scan stock keys: %w", err)
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: scan stock keys: %w", err)
	}
	return out, nil
}

// backfillDocuments turns the scanned keys into one document per location holding
// only the keys that need a row. keys arrive ordered by location.
func backfillDocuments(keys []stockKeyRow, opts BackfillOptions) []Document {
	var docs []Document
	index := map[string]int{}
	for _, k := range keys {
		line, ok := backfillLine(k, opts)
		if !ok {
			continue
		}
		loc := k.lt + ":" + k.lid
		i, seen := index[loc]
		if !seen {
			i = len(docs)
			index[loc] = i
			docs = append(docs, backfillDocument(k, loc, opts))
		}
		docs[i].Lines = append(docs[i].Lines, line)
	}
	return docs
}

func backfillDocument(k stockKeyRow, loc string, opts BackfillOptions) Document {
	d := Document{
		Key: "opening:" + opts.RunID + ":" + loc, Kind: KindOpening, LocationType: LocationType(k.lt),
		LocationID: k.lid, RefType: "backfill", OccurredAt: opts.OccurredAt,
	}
	if opts.Reanchor {
		d.Key, d.Kind = "reanchor:"+opts.RunID+":"+loc, KindAdjust
	}
	return d
}

// backfillLine returns the movement a key needs, or false when it needs none.
func backfillLine(k stockKeyRow, opts BackfillOptions) (Line, bool) {
	tail := k.lt + ":" + k.lid + ":" + k.pid + ":" + k.size
	l := Line{ProductID: k.pid, VariantSize: k.size, Qty: k.live - k.ledger, QtyBefore: k.ledger, QtyAfter: k.live}
	if opts.Reanchor {
		l.DedupeKey = "reanchor:" + opts.RunID + ":" + tail
		return l, l.Qty != 0
	}
	l.DedupeKey = "opening:" + tail
	return l, k.hasLive && !k.hasOpening
}

// Violation is one key where live stock and the ledger sum disagree.
type Violation struct {
	LocationType string
	LocationID   string
	ProductID    string
	VariantSize  string
	Live         int
	Ledger       int
}

// Querier is satisfied by pgx.Tx and *pgxpool.Pool.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

const invariantSQL = `
WITH live AS (
  SELECT 'outlet' lt, outlet_id lid, product_id, variant_size, stock FROM outlet_variant_stock
  UNION ALL SELECT 'warehouse', warehouse_id, product_id, variant_size, stock FROM warehouse_variant_stock),
led AS (SELECT location_type lt, location_id lid, product_id, variant_size, sum(qty)::int s
          FROM stock_movements GROUP BY 1,2,3,4)
SELECT lt, lid::text, product_id::text, variant_size, COALESCE(live.stock,0), COALESCE(led.s,0)
  FROM live FULL JOIN led USING (lt, lid, product_id, variant_size)
 WHERE COALESCE(live.stock,0) <> COALESCE(led.s,0)
 ORDER BY 1,2,3,4`

// InvariantViolations runs the plan §2.4 invariant: for every key, live stock equals
// the sum of its movements. An empty result means the ledger is consistent.
func InvariantViolations(ctx context.Context, q Querier) ([]Violation, error) {
	rows, err := q.Query(ctx, invariantSQL)
	if err != nil {
		return nil, fmt.Errorf("ledger: invariant query: %w", err)
	}
	defer rows.Close()
	var out []Violation
	for rows.Next() {
		var v Violation
		if err := rows.Scan(&v.LocationType, &v.LocationID, &v.ProductID, &v.VariantSize, &v.Live, &v.Ledger); err != nil {
			return nil, fmt.Errorf("ledger: invariant scan: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: invariant query: %w", err)
	}
	return out, nil
}
