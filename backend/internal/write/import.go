package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/csvimport"
)

// ImportOutcome says how an import request ended.
type ImportOutcome int

const (
	ImportPreview     ImportOutcome = iota // dry run: report only, nothing written
	ImportApplied                          // committed
	ImportReplay                           // same Idempotency-Key and file: stored result returned
	ImportRejected                         // file or row errors: nothing written (HTTP 422)
	ImportStale                            // data (or the file) changed since the preview (HTTP 409)
	ImportKeyConflict                      // same Idempotency-Key, different file (HTTP 409)
)

// ImportRequest is one CSV import call (dry run or commit).
type ImportRequest struct {
	Kind       string
	CSV        string
	FileName   string
	DryRun     bool
	FileSHA256 string // the preview's hash (commit only)
	Expected   *csvimport.Summary
	Key        string // Idempotency-Key (commit only)
	UserID     string
	// stock_count only: the count the file belongs to, the caller's outlet (authorises an
	// outlet count, as for PUT /stock-counts/{id}) and the preview's counters.
	TargetID      string
	OutletID      string
	ExpectedCount *csvimport.StockCountSummary
}

// ImportResult is the outcome plus the report shared by preview, 422 and replay.
type ImportResult struct {
	Outcome ImportOutcome
	Report  csvimport.Report
	Count   *csvimport.StockCountReport // set instead of Report for kind stock_count
}

// importPlan is what the per-kind planner returns: the report and, when the file has no
// errors, the function that writes it inside the caller's transaction.
type importPlan struct {
	report csvimport.Report
	count  *csvimport.StockCountReport // kind stock_count: replaces report
	apply  func(ctx context.Context, tx pgx.Tx) error
}

func (p *importPlan) hasErrors() bool {
	if p.count != nil {
		return p.count.HasErrors()
	}
	return p.report.HasErrors()
}

// matches is true when the commit carries the preview's file hash and counters.
func (p *importPlan) matches(req ImportRequest, sha string) bool {
	if req.FileSHA256 != sha {
		return false
	}
	if p.count != nil {
		return req.ExpectedCount != nil && *req.ExpectedCount == p.count.Summary
	}
	return req.Expected != nil && *req.Expected == p.report.Summary
}

func (p *importPlan) result(o ImportOutcome) ImportResult {
	return ImportResult{Outcome: o, Report: p.report, Count: p.count}
}

// audit is what import_runs keeps: the redacted result, the counters, the delimiter and the row total.
func (p *importPlan) audit() (stored, summary []byte, delimiter string, rows int, err error) {
	if p.count != nil {
		if stored, err = json.Marshal(p.count.Redacted()); err == nil {
			summary, err = json.Marshal(p.count.Summary)
		}
		return stored, summary, p.count.Delimiter, p.count.TotalRows, err
	}
	// result has no runId (the row id, added on replay).
	if stored, err = json.Marshal(p.report.Redacted()); err == nil {
		summary, err = json.Marshal(p.report.Summary)
	}
	return stored, summary, p.report.Delimiter, p.report.TotalRows, err
}

// stamp records the apply time and run id on the live report.
func (p *importPlan) stamp(at, runID string) {
	if p.count != nil {
		p.count.AppliedAt, p.count.RunID = at, runID
		return
	}
	p.report.AppliedAt, p.report.RunID = at, runID
}

func specFor(kind string) (csvimport.Spec, error) {
	switch kind {
	case csvimport.KindCustomers:
		return csvimport.CustomerSpec, nil
	case csvimport.KindProducts:
		return csvimport.ProductSpec, nil
	case csvimport.KindIngredients:
		return csvimport.IngredientSpec, nil
	case csvimport.KindSkuMapping:
		return csvimport.SkuMappingSpec, nil
	case csvimport.KindStockCount:
		return csvimport.StockCountSpec, nil
	}
	return csvimport.Spec{}, fmt.Errorf("unknown import kind %q", kind)
}

// planKind plans one file. commit is true inside the commit transaction (a stock count is then
// planned under its row lock; the read-only preview cannot lock).
func planKind(ctx context.Context, q pgx.Tx, req ImportRequest, t *csvimport.Table, commit bool) (*importPlan, error) {
	kind := req.Kind
	switch kind {
	case csvimport.KindCustomers:
		return planCustomerImport(ctx, q, t)
	case csvimport.KindProducts:
		return planProductImport(ctx, q, t)
	case csvimport.KindIngredients:
		return planIngredientImport(ctx, q, t)
	case csvimport.KindSkuMapping:
		return planSkuMappingImport(ctx, q, t)
	case csvimport.KindStockCount:
		return planStockCountImport(ctx, q, req, t, commit)
	}
	return nil, fmt.Errorf("unknown import kind %q", kind)
}

// RunImport runs one import. A dry run plans inside a read-only snapshot and writes
// nothing. A commit takes a per-kind advisory lock, re-plans against current data, and
// applies all-or-nothing together with one import_runs row. Preview and commit share
// planKind, so what the user saw is what is applied (or the commit is refused as stale).
func (r *Repo) RunImport(ctx context.Context, req ImportRequest) (ImportResult, error) {
	spec, err := specFor(req.Kind)
	if err != nil {
		return ImportResult{}, err
	}
	table := csvimport.Read([]byte(req.CSV), spec)

	if req.DryRun {
		return r.previewImport(ctx, req, table)
	}
	// A deadlock or lock timeout aborts the whole transaction before anything is applied;
	// retry it fresh a couple of times, then surface ErrBusy (the handler answers "sibuk").
	var res ImportResult
	err = retryBusy(ctx, func() error {
		var e error
		res, e = r.commitImport(ctx, req, table)
		return e
	})
	return res, err
}

// errImportStale marks an apply that found the data different from what the plan saw
// (a concurrent edit between plan and apply); the transaction rolls back.
var errImportStale = errors.New("import: data changed since the plan")

func (r *Repo) previewImport(ctx context.Context, req ImportRequest, table *csvimport.Table) (ImportResult, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback(ctx)
	p, err := planKind(ctx, tx, req, table, false)
	if err != nil {
		return ImportResult{}, err
	}
	return p.result(ImportPreview), nil
}

func (r *Repo) commitImport(ctx context.Context, req ImportRequest, table *csvimport.Table) (ImportResult, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback(ctx)
	// One import of a kind at a time; the key re-check below runs AFTER the lock so a
	// concurrent retry of the same key replays instead of double-writing.
	// A stock count import locks per count (the count's own row lock then serialises its saves).
	lockName := "csv-import:" + req.Kind + ":" + req.TargetID
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, lockName); err != nil {
		return ImportResult{}, err
	}
	if res, found, err := replayImport(ctx, tx, req, table); err != nil {
		return ImportResult{}, err
	} else if found {
		return res, nil
	}

	p, err := planKind(ctx, tx, req, table, true)
	if err != nil {
		return ImportResult{}, err
	}
	if !p.matches(req, table.SHA256) {
		return p.result(ImportStale), nil
	}
	if p.hasErrors() {
		return p.result(ImportRejected), nil
	}
	if err = p.apply(ctx, tx); err != nil {
		if errors.Is(err, errImportStale) {
			return p.result(ImportStale), nil
		}
		var pg *pgconn.PgError
		if errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "23503") {
			// Something outside imports changed the same rows between plan and apply.
			slog.Warn("csv import apply conflict", "kind", req.Kind, "code", pg.Code, "constraint", pg.ConstraintName)
			return p.result(ImportStale), nil
		}
		return ImportResult{}, err
	}

	// The STORED copy carries no personal values (see Report.Redacted); the live response
	// the user is looking at stays unredacted.
	appliedAt := time.Now().UTC().Format(time.RFC3339)
	p.stamp(appliedAt, "")
	stored, summary, delimiter, totalRows, err := p.audit()
	if err != nil {
		return ImportResult{}, err
	}
	var runID string
	if err = tx.QueryRow(ctx, `
		INSERT INTO import_runs (kind, idempotency_key, user_id, file_name, file_sha256, delimiter, total_rows, summary, result, target_id)
		VALUES ($1,$2,NULLIF($3,'')::uuid,NULLIF($4,''),$5,$6,$7,$8,$9,NULLIF($10,'')::uuid) RETURNING id::text`,
		req.Kind, req.Key, req.UserID, req.FileName, table.SHA256, delimiter, totalRows, summary, stored, req.TargetID).Scan(&runID); err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			// The same key was recorded by another kind's import that raced past the
			// per-kind advisory lock: this one rolls back and reports the key conflict.
			return ImportResult{Outcome: ImportKeyConflict}, nil
		}
		return ImportResult{}, fmt.Errorf("record import run: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return ImportResult{}, err
	}
	p.stamp(appliedAt, runID)
	slog.Info("csv import applied", "kind", req.Kind, "runId", runID, "user", req.UserID, "rows", totalRows,
		"create", p.report.Summary.Create, "update", p.report.Summary.Update,
		"skip", p.report.Summary.Skip, "warnings", p.report.Summary.Warning)
	return p.result(ImportApplied), nil
}

// replayImport returns the stored result for a key that already applied: the same file
// replays it, a different file (or kind) is a key conflict.
func replayImport(ctx context.Context, tx pgx.Tx, req ImportRequest, table *csvimport.Table) (ImportResult, bool, error) {
	var id, kind, sha, target string
	var result []byte
	err := tx.QueryRow(ctx,
		`SELECT id::text, kind, file_sha256, COALESCE(target_id::text,''), result FROM import_runs WHERE idempotency_key=$1`, req.Key).
		Scan(&id, &kind, &sha, &target, &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return ImportResult{}, false, nil
	}
	if err != nil {
		return ImportResult{}, false, err
	}
	// A stock count key replays only for the same count (target is "" for every other kind).
	if kind != req.Kind || sha != table.SHA256 || target != req.TargetID {
		return ImportResult{Outcome: ImportKeyConflict}, true, nil
	}
	if kind == csvimport.KindStockCount {
		var cr csvimport.StockCountReport
		if err := json.Unmarshal(result, &cr); err != nil {
			return ImportResult{}, false, fmt.Errorf("stored import result: %w", err)
		}
		cr.RunID = id
		return ImportResult{Outcome: ImportReplay, Count: &cr}, true, nil
	}
	var report csvimport.Report
	if err := json.Unmarshal(result, &report); err != nil {
		return ImportResult{}, false, fmt.Errorf("stored import result: %w", err)
	}
	report.RunID = id
	return ImportResult{Outcome: ImportReplay, Report: report}, true, nil
}
