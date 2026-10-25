package erp

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// pgLocker is the single-flight lock (R1). DATABASE_URL may be a transaction-mode pooler,
// where a session advisory lock can stick on another backend, so the lock is a
// transaction-scoped one: a dedicated connection holds an open transaction for the whole
// run and rolling it back releases the lock, even if the connection dies. Page applies
// run on other pool connections.
type pgLocker struct{ Pool *pgxpool.Pool }

func (l pgLocker) TryLock(ctx context.Context) (func(context.Context) error, bool, error) {
	tx, err := l.Pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	var ok bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtext($1))`, catalogLockName).Scan(&ok); err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, false, err
	}
	if !ok {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, false, nil
	}
	return func(ctx context.Context) error { return tx.Rollback(ctx) }, true, nil
}

// pgStore implements runStore over pgx.
type pgStore struct{ Pool *pgxpool.Pool }

var _ runStore = (*pgStore)(nil)

func (p *pgStore) LoadState(ctx context.Context, resource string) (watermarkState, error) {
	var st watermarkState
	err := p.Pool.QueryRow(ctx,
		`SELECT watermark, last_full_sync_at FROM integration_watermarks WHERE resource=$1`, resource).
		Scan(&st.Watermark, &st.LastFullSyncAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return watermarkState{}, nil
	}
	return st, err
}

func (p *pgStore) StartRun(ctx context.Context, resource string, mode Mode) (string, error) {
	var id string
	err := p.Pool.QueryRow(ctx,
		`INSERT INTO erp_sync_runs (resource, mode) VALUES ($1,$2) RETURNING id::text`, resource, string(mode)).Scan(&id)
	return id, err
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Complete runs the reconcile (full runs only), commits the watermark and finishes
// the run row in one transaction, so a failure leaves the watermark untouched.
func (p *pgStore) Complete(ctx context.Context, c completion) (int, string, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	deact, refused := 0, ""
	// An empty full catalog is treated as an ERP fault, not as "everything was removed".
	if c.Reconcile && len(c.SeenSlugs) > 0 {
		if deact, refused, err = reconcile(ctx, tx, c.Resource, c.SeenSlugs); err != nil {
			return 0, "", fmt.Errorf("reconcile: %w", err)
		}
	}
	note := joinNotes(c.Note, refused)
	var lastFull *time.Time
	if c.Mode == ModeFull {
		lastFull = &c.Now
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO integration_watermarks (resource, watermark, last_full_sync_at, last_run_at, last_status, last_error, updated_at)
		VALUES ($1,$2,$3,$4,'completed',$5,now())
		ON CONFLICT (resource) DO UPDATE SET
		  watermark = EXCLUDED.watermark,
		  last_full_sync_at = COALESCE(EXCLUDED.last_full_sync_at, integration_watermarks.last_full_sync_at),
		  last_run_at = EXCLUDED.last_run_at, last_status = 'completed',
		  last_error = EXCLUDED.last_error, updated_at = now()`,
		c.Resource, c.Watermark, lastFull, c.Now, nullable(note)); err != nil {
		return 0, "", err
	}
	if err := finishRun(ctx, tx, c.RunID, StatusCompleted, note, c.Stats); err != nil {
		return 0, "", err
	}
	return deact, refused, tx.Commit(ctx)
}

// Abort records a partial/failed run. The watermark column is deliberately not in
// the DO UPDATE set, and a brand-new row is inserted with a NULL watermark.
func (p *pgStore) Abort(ctx context.Context, a abortInfo) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO integration_watermarks (resource, last_run_at, last_status, last_error, updated_at)
		VALUES ($1,$2,$3,$4,now())
		ON CONFLICT (resource) DO UPDATE SET
		  last_run_at = EXCLUDED.last_run_at, last_status = EXCLUDED.last_status,
		  last_error = EXCLUDED.last_error, updated_at = now()`,
		a.Resource, a.Now, a.Status, nullable(a.Err)); err != nil {
		return err
	}
	if err := finishRun(ctx, tx, a.RunID, a.Status, a.Err, a.Stats); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func finishRun(ctx context.Context, tx pgx.Tx, runID, status, errText string, st runStats) error {
	_, err := tx.Exec(ctx, `
		UPDATE erp_sync_runs SET finished_at=now(), pages=$2, upserted=$3, tombstoned=$4, status=$5, error=$6
		 WHERE id=$1`, runID, st.Pages, st.Upserted, st.Tombstoned, status, nullable(errText))
	return err
}

// Reconcile cap (R8): a complete full run may deactivate at most max(reconcileFloor, 20% of
// the resource's linked rows); a bigger gap looks like an ERP-side fault, so nothing is
// deactivated and the run records "reconcile refused".
const (
	reconcileFloor   = 5
	reconcilePercent = 20
)

// reconcile deactivates ERP-linked rows that a COMPLETE full run did not see.
// Only rows with erp_slug are touched; nothing is deleted. It returns the number
// deactivated, or a non-empty refusal text when the cap was exceeded.
func reconcile(ctx context.Context, tx pgx.Tx, resource string, seen []string) (int, string, error) {
	switch resource {
	case ResourceOutlets:
		return reconcileOutlets(ctx, tx, seen)
	case ResourceFinishedGoods:
		return reconcileVariants(ctx, tx, seen)
	}
	return 0, "", fmt.Errorf("unknown resource %q", resource)
}

func overCap(missing, linked int) bool {
	return missing > max(reconcileFloor, linked*reconcilePercent/100)
}

func refusal(missing, linked int) string {
	return fmt.Sprintf("reconcile refused: %d of %d linked rows missing from the ERP catalog", missing, linked)
}

// reconcileOutlets is REPORT-ONLY: an outlet missing from a complete full run is never
// deactivated here (review M2: deactivation is sticky, the ERP never re-activates, and it
// locks the outlet's tablets out). It returns a note naming the count for an admin to act
// on; an explicit ERP tombstone (deleted_at) still deactivates the outlet in the item path.
// Whether reconcile may deactivate outlets is an open owner decision.
func reconcileOutlets(ctx context.Context, tx pgx.Tx, seen []string) (int, string, error) {
	var linked, missing int
	if err := tx.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE is_active AND NOT (erp_slug = ANY($1::text[])))
		  FROM outlets WHERE erp_slug IS NOT NULL`, seen).Scan(&linked, &missing); err != nil {
		return 0, "", err
	}
	if missing == 0 {
		return 0, "", nil
	}
	return 0, fmt.Sprintf("outlet reconcile is report-only: %d of %d linked active outlets missing from the ERP catalog (not deactivated)", missing, linked), nil
}

func reconcileVariants(ctx context.Context, tx pgx.Tx, seen []string) (int, string, error) {
	var linked, missing int
	if err := tx.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE is_active AND NOT (erp_slug = ANY($1::text[])))
		  FROM product_variants WHERE erp_slug IS NOT NULL`, seen).Scan(&linked, &missing); err != nil {
		return 0, "", err
	}
	if missing == 0 {
		return 0, "", nil
	}
	if overCap(missing, linked) {
		return 0, refusal(missing, linked), nil
	}
	// R4: lock the parent products first, in id order, like the app (product, then variants).
	if _, err := tx.Exec(ctx, `
		SELECT id FROM products WHERE id IN (
		  SELECT product_id FROM product_variants
		   WHERE erp_slug IS NOT NULL AND is_active AND NOT (erp_slug = ANY($1::text[])))
		 ORDER BY id FOR UPDATE`, seen); err != nil {
		return 0, "", err
	}
	rows, err := tx.Query(ctx,
		`UPDATE product_variants SET is_active=false
		  WHERE erp_slug IS NOT NULL AND is_active AND NOT (erp_slug = ANY($1::text[]))
		  RETURNING product_id::text`, seen)
	if err != nil {
		return 0, "", err
	}
	var products []string
	for rows.Next() {
		var pid string
		if err := rows.Scan(&pid); err != nil {
			rows.Close()
			return 0, "", err
		}
		products = append(products, pid)
	}
	if err := rows.Err(); err != nil || len(products) == 0 {
		return 0, "", err
	}
	// After the variant update (a data-modifying CTE would not see it): re-derive each
	// product's name and category, so a deactivated owner hands over to the next size now,
	// and clear products.is_active when no variant is left active (R2: clear only).
	slices.Sort(products)
	catCreated := false
	for _, pid := range slices.Compact(products) {
		_, created, err := syncProduct(ctx, tx, pid)
		if err != nil {
			return 0, "", err
		}
		catCreated = catCreated || created
	}
	if catCreated {
		if err := bumpVersion(ctx, tx, "categories"); err != nil {
			return 0, "", err
		}
	}
	return len(products), "", bumpVersion(ctx, tx, "products")
}

// bumpVersion is a copy of write.bumpVersion (internal/write/repo.go): the arch rule
// forbids adapter -> write imports. Keep the two in step. Run inside the caller's tx.
func bumpVersion(ctx context.Context, q pgx.Tx, resource string) error {
	_, err := q.Exec(ctx, `
		INSERT INTO content_versions (outlet_id, version, data_manifest, updated_at)
		SELECT id, 2,
		       jsonb_build_object($1::text, 1), now()
		  FROM outlets
		ON CONFLICT (outlet_id) DO UPDATE SET
		  version = content_versions.version + 1,
		  data_manifest = content_versions.data_manifest ||
		    jsonb_build_object($1::text,
		      COALESCE((content_versions.data_manifest->>$1)::int,0) + 1),
		  updated_at = now()`, resource)
	return err
}

// itemError is a deterministic per-item conflict: counted, never aborts the page.
type itemError string

func (e itemError) Error() string { return string(e) }

// applyPage runs one page in one transaction. Each item runs in a savepoint so an
// item-level failure (itemError or an integrity violation) rolls back only that item.
// fn returns changed (rows were written) and whether the item counts as upserted.
//
// pre (optional) runs first inside the tx and may peel off items that need no write
// (R7): it returns the items still to apply, the outcomes of the skipped ones (counted
// as processed, never a savepoint or a version bump) and an optional after step. after
// runs once the item loop is done, so its row locks come after the product locks the
// items take (the app locks product, then variants).
func applyPage[T any](ctx context.Context, pool *pgxpool.Pool, items []T, label func(T) string,
	pre func(ctx context.Context, q pgx.Tx, items []T) ([]T, []itemOutcome, func(context.Context, pgx.Tx) error, error),
	fn func(ctx context.Context, q pgx.Tx, it T) (itemOutcome, error), resources ...string) (pageApply, error) {

	tx, err := pool.Begin(ctx)
	if err != nil {
		return pageApply{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var res pageApply
	bump := map[string]bool{}
	var after func(context.Context, pgx.Tx) error
	if pre != nil {
		rest, skipped, post, err := pre(ctx, tx, items)
		if err != nil {
			return pageApply{}, err
		}
		items, after = rest, post
		for _, o := range skipped {
			res.Upserted++
			if o.tombstoned {
				res.Tombstoned++
			}
		}
	}
	for _, it := range items {
		sp, err := tx.Begin(ctx)
		if err != nil {
			return pageApply{}, err
		}
		out, err := fn(ctx, sp, it)
		if err != nil {
			_ = sp.Rollback(ctx)
			var ie itemError
			var pe *pgconn.PgError
			switch {
			case errors.As(err, &ie):
				res.Errors = append(res.Errors, label(it)+": "+string(ie))
			case errors.As(err, &pe) && (strings.HasPrefix(pe.Code, "23") || strings.HasPrefix(pe.Code, "22")):
				res.Errors = append(res.Errors, fmt.Sprintf("%s: integrity violation (%s %s)", label(it), pe.Code, pe.ConstraintName))
			default:
				return pageApply{}, fmt.Errorf("%s: %w", label(it), err)
			}
			continue
		}
		if err := sp.Commit(ctx); err != nil {
			return pageApply{}, err
		}
		if out.skipped {
			continue
		}
		res.Upserted++
		if out.tombstoned {
			res.Tombstoned++
		}
		for _, r := range out.bump {
			bump[r] = true
		}
	}
	if after != nil {
		if err := after(ctx, tx); err != nil {
			return pageApply{}, err
		}
	}
	// Bump only in a tx that changed rows, once per resource.
	for _, r := range resources {
		if bump[r] {
			if err := bumpVersion(ctx, tx, r); err != nil {
				return pageApply{}, err
			}
		}
	}
	return res, tx.Commit(ctx)
}

// itemOutcome: skipped items (e.g. an unknown tombstone) count nowhere; bump lists
// the content-version resources whose rows this item changed.
type itemOutcome struct {
	skipped, tombstoned bool
	bump                []string
}

func (p *pgStore) ApplyFG(ctx context.Context, items []erpapi.IntegrationFG) (pageApply, error) {
	return applyPage(ctx, p.Pool, items,
		func(fg erpapi.IntegrationFG) string { return "fg " + fg.Slug },
		skipUnchangedFG, applyFGItem, "products", "categories")
}

func (p *pgStore) ApplyOutlets(ctx context.Context, items []erpapi.IntegrationOutlet) (pageApply, error) {
	return applyPage(ctx, p.Pool, items,
		func(o erpapi.IntegrationOutlet) string { return "outlet " + o.Slug },
		nil, applyOutletItem, "outlets")
}

// fgSnap is the stored state of one linked variant and its product, prefetched per page.
type fgSnap struct {
	sku, productID, productName string
	active, productActive       bool
	hasActive                   bool    // the product has at least one active variant
	category                    *string // lower(product category name), nil when none
	erpName, erpCategory        *string // what this FG said last (migration 0068)
	srcName, srcCategory        *string // the product's source values; srcCategory lower-cased
}

// unchangedFG reports whether applying fg would write nothing. It mirrors applyFGItem:
// sku, variant is_active, the FG's stored name and category, the clear-only product
// is_active, and the product already showing its source name and category.
func unchangedFG(fg erpapi.IntegrationFG, sn fgSnap) bool {
	if strings.TrimSpace(fg.Slug) == "" || strings.TrimSpace(fg.Code) == "" || strings.TrimSpace(fg.Name) == "" {
		return false // let the item path report the error
	}
	if sn.sku != fg.Code || sn.active != FGActive(fg) {
		return false
	}
	if sn.erpName == nil || *sn.erpName != ProductNameFromFG(fg.Name, fg.Size) || !sameCategory(sn.erpCategory, fgCategory(fg)) {
		return false
	}
	if sn.productActive && !sn.hasActive {
		return false
	}
	if sn.srcName != nil && sn.productName != *sn.srcName {
		return false
	}
	return sn.srcCategory == nil || sn.category != nil && *sn.category == *sn.srcCategory
}

// skipUnchangedFG is the R7 prefetch: one query for the page's linked variants, then items
// that would write nothing are skipped (no savepoint); their erp_synced_at is bulk-updated by
// the returned after step, which applyPage runs after the item loop (lock order).
// An item is never skipped when an earlier written item of the page touches the same product
// (a written sibling can change the product's source name and category).
func skipUnchangedFG(ctx context.Context, q pgx.Tx, items []erpapi.IntegrationFG) ([]erpapi.IntegrationFG, []itemOutcome, func(context.Context, pgx.Tx) error, error) {
	slugs := make([]string, 0, len(items))
	for _, it := range items {
		slugs = append(slugs, it.Slug)
	}
	rows, err := q.Query(ctx, `
		SELECT v.erp_slug, v.sku, v.is_active, p.id::text, p.name, p.is_active,
		       EXISTS (SELECT 1 FROM product_variants v2 WHERE v2.product_id=p.id AND v2.is_active),
		       lower(c.name), v.erp_name, v.erp_category,
		       `+sourceName("p.id")+`, lower(`+sourceCategory("p.id")+`)
		  FROM product_variants v
		  JOIN products p ON p.id=v.product_id
		  LEFT JOIN categories c ON c.id=p.category_id
		 WHERE v.erp_slug = ANY($1::text[])`, slugs)
	if err != nil {
		return nil, nil, nil, err
	}
	snaps := map[string]fgSnap{}
	for rows.Next() {
		var slug string
		var sn fgSnap
		if err := rows.Scan(&slug, &sn.sku, &sn.active, &sn.productID, &sn.productName, &sn.productActive, &sn.hasActive, &sn.category,
			&sn.erpName, &sn.erpCategory, &sn.srcName, &sn.srcCategory); err != nil {
			rows.Close()
			return nil, nil, nil, err
		}
		snaps[slug] = sn
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, err
	}
	var rest []erpapi.IntegrationFG
	var skipped []itemOutcome
	var skippedSlugs []string
	dirty := map[string]bool{}
	for _, it := range items {
		sn, ok := snaps[it.Slug]
		if ok && !dirty[sn.productID] && unchangedFG(it, sn) {
			skipped = append(skipped, itemOutcome{tombstoned: it.DeletedAt != nil})
			skippedSlugs = append(skippedSlugs, it.Slug)
			continue
		}
		if ok {
			dirty[sn.productID] = true
		}
		rest = append(rest, it)
	}
	if len(skippedSlugs) == 0 {
		return rest, skipped, nil, nil
	}
	after := func(ctx context.Context, q pgx.Tx) error {
		// erp_synced_at is bookkeeping only: it never counts as a change (no version bump).
		_, err := q.Exec(ctx, `UPDATE product_variants SET erp_synced_at=now() WHERE erp_slug = ANY($1::text[])`, skippedSlugs)
		return err
	}
	return rest, skipped, after, nil
}

// upsertCategory matches by case-insensitive name and creates when missing.
// A blank name returns nil (the product keeps whatever category it has).
func upsertCategory(ctx context.Context, q pgx.Tx, name *string) (id *string, created bool, err error) {
	if name == nil {
		return nil, false, nil
	}
	n := collapseSpaces(*name)
	if n == "" {
		return nil, false, nil
	}
	var cid string
	err = q.QueryRow(ctx, `SELECT id::text FROM categories WHERE lower(name)=lower($1) ORDER BY id LIMIT 1`, n).Scan(&cid)
	if err == nil {
		return &cid, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	if err := q.QueryRow(ctx, `INSERT INTO categories (name) VALUES ($1) RETURNING id::text`, n).Scan(&cid); err != nil {
		return nil, false, err
	}
	return &cid, true, nil
}

func lockProduct(ctx context.Context, q pgx.Tx, productID string) error {
	var id string
	return q.QueryRow(ctx, `SELECT id::text FROM products WHERE id=$1 FOR UPDATE`, productID).Scan(&id)
}

// applyFGItem upserts one finished good by product_variants.erp_slug. It never
// touches an existing variant's size, price, barcode or images, and never deletes.
func applyFGItem(ctx context.Context, q pgx.Tx, fg erpapi.IntegrationFG) (itemOutcome, error) {
	if strings.TrimSpace(fg.Slug) == "" || strings.TrimSpace(fg.Code) == "" || strings.TrimSpace(fg.Name) == "" {
		return itemOutcome{}, itemError("missing slug, code or name")
	}
	active := FGActive(fg)
	out := itemOutcome{tombstoned: fg.DeletedAt != nil}
	name := ProductNameFromFG(fg.Name, fg.Size)

	var variantID, productID, curSKU string
	err := q.QueryRow(ctx, `SELECT id::text, product_id::text, sku FROM product_variants WHERE erp_slug=$1`, fg.Slug).
		Scan(&variantID, &productID, &curSKU)
	known := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if known { // R4: lock the product before touching or size-checking its variants
		if err := lockProduct(ctx, q, productID); err != nil {
			return out, err
		}
	}

	if !known {
		if fg.DeletedAt != nil { // never create a row for a tombstone we have not seen
			return itemOutcome{skipped: true}, nil
		}
		var unlinked bool
		err := q.QueryRow(ctx, `SELECT erp_slug IS NULL FROM product_variants WHERE sku=$1 OR barcode=$1 LIMIT 1`, fg.Code).Scan(&unlinked)
		if err == nil {
			if unlinked {
				return out, itemError(fmt.Sprintf("sku %q belongs to an unlinked variant; map it via the SKU-mapping CSV first", fg.Code))
			}
			return out, itemError(fmt.Sprintf("sku %q is already used by another ERP variant", fg.Code))
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
	} else if curSKU != fg.Code {
		var n int
		if err := q.QueryRow(ctx, `SELECT count(*) FROM product_variants WHERE sku=$1 AND id<>$2`, fg.Code, variantID).Scan(&n); err != nil {
			return out, err
		}
		if n > 0 {
			return out, itemError(fmt.Sprintf("sku %q is already used by another variant", fg.Code))
		}
	}

	changed, catCreated := false, false

	if known {
		ct, err := q.Exec(ctx, `UPDATE product_variants SET is_active=$2, sku=$3
			 WHERE id=$1 AND (is_active IS DISTINCT FROM $2 OR sku IS DISTINCT FROM $3)`, variantID, active, fg.Code)
		if err != nil {
			return out, err
		}
		changed = ct.RowsAffected() > 0
		// erp_synced_at and the stored source values are bookkeeping only: they must not
		// count as a change (no version bump); syncProduct decides whether the product changed.
		if _, err := q.Exec(ctx, `UPDATE product_variants SET erp_synced_at=now() WHERE id=$1`, variantID); err != nil {
			return out, err
		}
		if err := storeSource(ctx, q, variantID, name, fgCategory(fg)); err != nil {
			return out, err
		}
	} else {
		// The FG's own category only matters for grouping a new variant; a known one is
		// re-derived from the stored values by syncProduct.
		catID, created, err := upsertCategory(ctx, q, fg.Category)
		if err != nil {
			return out, err
		}
		catCreated = created
		label := SizeLabel(fg.Size, fg.Unit)
		var clash bool
		if productID, created, err = groupProduct(ctx, q, fg, name, label, catID, active); err != nil {
			return out, err
		}
		changed = created
		if clash, err = hasSize(ctx, q, productID, label); err != nil {
			return out, err
		}
		if clash {
			return out, itemError(fmt.Sprintf("size label %q already exists in the target product", label))
		}
		// price 0 and no stock rows: priced later by the owner; the tablet read hides Rp0 ERP variants.
		if _, err := q.Exec(ctx, `
			INSERT INTO product_variants (product_id, size, price, sku, barcode, erp_slug, erp_synced_at, is_active,
			                              erp_name, erp_category)
			VALUES ($1,$2,0,$3,$3,$4,now(),$5,$6,$7)`, productID, label, fg.Code, fg.Slug, active, name, fgCategory(fg)); err != nil {
			return out, err
		}
		changed = true
	}

	pchanged, pcatCreated, err := syncProduct(ctx, q, productID)
	if err != nil {
		return out, err
	}
	if changed || pchanged {
		out.bump = append(out.bump, "products")
	}
	if catCreated || pcatCreated {
		out.bump = append(out.bump, "categories")
	}
	return out, nil
}

// groupProduct finds (locking) or creates the product a new FG joins: the GroupKey product
// (name minus size). Category only breaks a tie: when that product is filed under another
// category (or none, or the FG has none), the FG goes to its CategoryGroupKey product if one
// exists, or to a new one if the GroupKey product already holds the FG's size label.
// created reports a new row.
func groupProduct(ctx context.Context, q pgx.Tx, fg erpapi.IntegrationFG, name, label string, catID *string, active bool) (string, bool, error) {
	key := GroupKey(fg.Name, fg.Size)
	id, cat, found, err := productByGroupKey(ctx, q, key)
	if err != nil {
		return "", false, err
	}
	if found && !sameCategory(cat, catID) {
		tieKey := CategoryGroupKey(fg.Name, fg.Category, fg.Size)
		tieID, _, tieFound, err := productByGroupKey(ctx, q, tieKey)
		if err != nil {
			return "", false, err
		}
		if tieFound {
			return tieID, false, nil
		}
		clash, err := hasSize(ctx, q, id, label)
		if err != nil {
			return "", false, err
		}
		if clash {
			key, found = tieKey, false
		}
	}
	if found {
		return id, false, nil
	}
	// D20: new ERP products are not sellable until the owner prices and enables them.
	if err := q.QueryRow(ctx, `
		INSERT INTO products (name, brand, category_id, sellable, is_active, erp_group_key)
		VALUES ($1,'',$2::text::uuid,false,$3,$4) RETURNING id::text`,
		name, catID, active, key).Scan(&id); err != nil {
		return "", false, err
	}
	return id, true, nil
}

func sameCategory(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// productByGroupKey locks the product whose erp_group_key is key; cat is its category id.
func productByGroupKey(ctx context.Context, q pgx.Tx, key string) (id string, cat *string, found bool, err error) {
	err = q.QueryRow(ctx, `SELECT id::text, category_id::text FROM products WHERE erp_group_key=$1 FOR UPDATE`, key).Scan(&id, &cat)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, false, nil
	}
	return id, cat, err == nil, err
}

func hasSize(ctx context.Context, q pgx.Tx, productID, label string) (bool, error) {
	var clash bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM product_variants WHERE product_id=$1 AND size=$2)`, productID, label).Scan(&clash)
	return clash, err
}

// applyOutletItem upserts one outlet by outlets.erp_slug. It never writes
// outlets.code, never re-activates a known outlet, and never deletes.
func applyOutletItem(ctx context.Context, q pgx.Tx, o erpapi.IntegrationOutlet) (itemOutcome, error) {
	if strings.TrimSpace(o.Slug) == "" || strings.TrimSpace(o.Code) == "" || strings.TrimSpace(o.Name) == "" {
		return itemOutcome{}, itemError("missing slug, code or name")
	}
	deleted := o.DeletedAt != nil
	out := itemOutcome{tombstoned: deleted}

	var id string
	err := q.QueryRow(ctx, `SELECT id::text FROM outlets WHERE erp_slug=$1`, o.Slug).Scan(&id)
	if err == nil {
		ct, err := q.Exec(ctx, `
			UPDATE outlets SET erp_code=$2, name=$3, address=$4, phone=$5,
			       is_active = CASE WHEN $6::boolean THEN false ELSE is_active END
			 WHERE id=$1
			   AND (erp_code IS DISTINCT FROM $2 OR name IS DISTINCT FROM $3
			     OR address IS DISTINCT FROM $4 OR phone IS DISTINCT FROM $5
			     OR ($6::boolean AND is_active))`,
			id, o.Code, o.Name, o.Address, o.Phone, deleted)
		if err != nil {
			return out, err
		}
		if ct.RowsAffected() > 0 {
			out.bump = []string{"outlets"}
		}
		return out, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if deleted { // a tombstone for an outlet we never had is not created
		return itemOutcome{skipped: true}, nil
	}

	// Link exactly one unlinked outlet whose POS code equals the ERP code (flagged decision).
	rows, err := q.Query(ctx, `SELECT id::text FROM outlets WHERE erp_slug IS NULL AND lower(code)=lower($1) LIMIT 2`, o.Code)
	if err != nil {
		return out, err
	}
	var matches []string
	for rows.Next() {
		var mid string
		if err := rows.Scan(&mid); err != nil {
			rows.Close()
			return out, err
		}
		matches = append(matches, mid)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	switch len(matches) {
	case 1:
		_, err := q.Exec(ctx, `UPDATE outlets SET erp_slug=$2, erp_code=$3, name=$4, address=$5, phone=$6 WHERE id=$1`,
			matches[0], o.Slug, o.Code, o.Name, o.Address, o.Phone)
		out.bump = []string{"outlets"}
		return out, err
	case 0:
		// Inactive, code NULL (admin assigns the POS receipt code), default timezone.
		if err := q.QueryRow(ctx, `
			INSERT INTO outlets (name, address, phone, is_active, erp_slug, erp_code)
			VALUES ($1,$2,$3,false,$4,$5) RETURNING id::text`,
			o.Name, o.Address, o.Phone, o.Slug, o.Code).Scan(&id); err != nil {
			return out, err
		}
		// Baseline content_versions row, as write.CreateOutlet does.
		if _, err := q.Exec(ctx, `INSERT INTO content_versions (outlet_id) VALUES ($1) ON CONFLICT DO NOTHING`, id); err != nil {
			return out, err
		}
		out.bump = []string{"outlets"}
		return out, nil
	}
	return out, itemError(fmt.Sprintf("more than one unlinked outlet has code %q", o.Code))
}
