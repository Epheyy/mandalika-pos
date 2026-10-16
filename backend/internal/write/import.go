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
}

// ImportResult is the outcome plus the report shared by preview, 422 and replay.
type ImportResult struct {
	Outcome ImportOutcome
	Report  csvimport.Report
}

// importPlan is what the per-kind planner returns: the report and, when the file has no
// errors, the function that writes it inside the caller's transaction.
type importPlan struct {
	report csvimport.Report
	apply  func(ctx context.Context, tx pgx.Tx) error
}

func specFor(kind string) (csvimport.Spec, error) {
	switch kind {
	case csvimport.KindCustomers:
		return csvimport.CustomerSpec, nil
	case csvimport.KindProducts:
		return csvimport.ProductSpec, nil
	case csvimport.KindIngredients:
		return csvimport.IngredientSpec, nil
	}
	return csvimport.Spec{}, fmt.Errorf("unknown import kind %q", kind)
}

func planKind(ctx context.Context, q pgx.Tx, kind string, t *csvimport.Table) (*importPlan, error) {
	switch kind {
	case csvimport.KindCustomers:
		return planCustomerImport(ctx, q, t)
	case csvimport.KindProducts:
		return planProductImport(ctx, q, t)
	case csvimport.KindIngredients:
		return planIngredientImport(ctx, q, t)
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
		return r.previewImport(ctx, req.Kind, table)
	}
	return r.commitImport(ctx, req, table)
}

func (r *Repo) previewImport(ctx context.Context, kind string, table *csvimport.Table) (ImportResult, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback(ctx)
	p, err := planKind(ctx, tx, kind, table)
	if err != nil {
		return ImportResult{}, err
	}
	return ImportResult{Outcome: ImportPreview, Report: p.report}, nil
}

func (r *Repo) commitImport(ctx context.Context, req ImportRequest, table *csvimport.Table) (ImportResult, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return ImportResult{}, err
	}
	defer tx.Rollback(ctx)
	// One import of a kind at a time; the key re-check below runs AFTER the lock so a
	// concurrent retry of the same key replays instead of double-writing.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "csv-import:"+req.Kind); err != nil {
		return ImportResult{}, err
	}
	if res, found, err := replayImport(ctx, tx, req, table); err != nil {
		return ImportResult{}, err
	} else if found {
		return res, nil
	}

	p, err := planKind(ctx, tx, req.Kind, table)
	if err != nil {
		return ImportResult{}, err
	}
	if req.FileSHA256 != table.SHA256 || req.Expected == nil || *req.Expected != p.report.Summary {
		return ImportResult{Outcome: ImportStale, Report: p.report}, nil
	}
	if p.report.HasErrors() {
		return ImportResult{Outcome: ImportRejected, Report: p.report}, nil
	}
	if err = p.apply(ctx, tx); err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "23503") {
			// Something outside imports changed the same rows between plan and apply.
			slog.Warn("csv import apply conflict", "kind", req.Kind, "code", pg.Code, "constraint", pg.ConstraintName)
			return ImportResult{Outcome: ImportStale, Report: p.report}, nil
		}
		return ImportResult{}, err
	}

	report := p.report
	report.AppliedAt = time.Now().UTC().Format(time.RFC3339)
	var runID string
	// result is stored without runId (it is the row's own id and is added on replay).
	stored, err := json.Marshal(report)
	if err != nil {
		return ImportResult{}, err
	}
	summary, _ := json.Marshal(report.Summary)
	if err = tx.QueryRow(ctx, `
		INSERT INTO import_runs (kind, idempotency_key, user_id, file_name, file_sha256, delimiter, total_rows, summary, result)
		VALUES ($1,$2,NULLIF($3,'')::uuid,NULLIF($4,''),$5,$6,$7,$8,$9) RETURNING id::text`,
		req.Kind, req.Key, req.UserID, req.FileName, table.SHA256, report.Delimiter, report.TotalRows, summary, stored).Scan(&runID); err != nil {
		return ImportResult{}, fmt.Errorf("record import run: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return ImportResult{}, err
	}
	report.RunID = runID
	slog.Info("csv import applied", "kind", req.Kind, "runId", runID, "user", req.UserID,
		"rows", report.TotalRows, "create", report.Summary.Create, "update", report.Summary.Update,
		"skip", report.Summary.Skip, "warnings", report.Summary.Warning)
	return ImportResult{Outcome: ImportApplied, Report: report}, nil
}

// replayImport returns the stored result for a key that already applied: the same file
// replays it, a different file (or kind) is a key conflict.
func replayImport(ctx context.Context, tx pgx.Tx, req ImportRequest, table *csvimport.Table) (ImportResult, bool, error) {
	var id, kind, sha string
	var result []byte
	err := tx.QueryRow(ctx,
		`SELECT id::text, kind, file_sha256, result FROM import_runs WHERE idempotency_key=$1`, req.Key).
		Scan(&id, &kind, &sha, &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return ImportResult{}, false, nil
	}
	if err != nil {
		return ImportResult{}, false, err
	}
	if kind != req.Kind || sha != table.SHA256 {
		return ImportResult{Outcome: ImportKeyConflict}, true, nil
	}
	var report csvimport.Report
	if err := json.Unmarshal(result, &report); err != nil {
		return ImportResult{}, false, fmt.Errorf("stored import result: %w", err)
	}
	report.RunID = id
	return ImportResult{Outcome: ImportReplay, Report: report}, true, nil
}
