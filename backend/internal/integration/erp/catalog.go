package erp

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// Catalog pull (step 4): the ERP is the catalog master; this file is the run
// state machine (lock, mode, paging, budget, watermark). All SQL is in
// catalog_store.go behind runStore so the machine is unit-tested without a DB.

// Pulled resources, in run order (outlets first so later stock work can resolve codes).
const (
	ResourceOutlets       = "outlets"
	ResourceFinishedGoods = "finished_goods"
)

// Mode selects a full or an incremental pull. ModeAuto lets the syncer pick.
type Mode string

const (
	ModeFull        Mode = "full"
	ModeIncremental Mode = "incremental"
	ModeAuto        Mode = "auto"
)

// ParseMode accepts "full", "incremental" or "auto" (case-insensitive). The
// empty string means auto.
func ParseMode(s string) (Mode, error) {
	switch m := Mode(strings.ToLower(strings.TrimSpace(s))); m {
	case "", ModeAuto:
		return ModeAuto, nil
	case ModeFull, ModeIncremental:
		return m, nil
	}
	return "", fmt.Errorf("erp: unknown sync mode %q (want full, incremental or auto)", s)
}

// Run and resource statuses.
const (
	StatusCompleted     = "completed"
	StatusPartial       = "partial"
	StatusFailed        = "failed"
	StatusSkippedLocked = "skipped_locked"
)

const (
	defaultBudget      = 25 * time.Second // under the 30 s write timeout
	incrementalOverlap = 5 * time.Minute  // updated_since = watermark - overlap
	fullSyncMaxAge     = 24 * time.Hour   // auto picks full when the last full is older
	maxErrorMessages   = 10               // item-error messages kept per run
	maxErrorText       = 2000
	catalogLockName    = "erp-catalog-pull"
	runGrace           = 5 * time.Second // run ctx deadline = budget + runGrace
)

// Source is the read side of the ERP client the syncer needs. *Client satisfies it.
type Source interface {
	FinishedGoodsPage(ctx context.Context, r PageRequest) (Page[erpapi.IntegrationFG], error)
	OutletsPage(ctx context.Context, r PageRequest) (Page[erpapi.IntegrationOutlet], error)
}

var _ Source = (*Client)(nil)

// ResourceResult is the outcome of one resource within a run.
type ResourceResult struct {
	Resource    string
	Mode        Mode // mode actually used (full or incremental)
	RunID       string
	Status      string
	Pages       int
	Upserted    int
	Tombstoned  int
	Deactivated int // reconcile: linked rows absent from a complete full run
	ItemErrors  int
	Error       string     // fatal error, or a summary of item errors on a completed run
	Watermark   *time.Time // set only when the run completed and committed it
}

// CatalogReport is the outcome of Syncer.Run. Status is the worst resource status
// (failed > partial > completed), or skipped_locked when another run held the lock.
type CatalogReport struct {
	Status    string
	Resources []ResourceResult
}

// Syncer pulls the ERP catalog into the POS tables.
type Syncer struct {
	Pool     *pgxpool.Pool
	Source   Source
	Now      func() time.Time // default time.Now
	Budget   time.Duration    // total wall-clock budget across both resources; default 25s
	Logger   *slog.Logger     // optional
	PageSize int              // catalog page size; default MaxTake

	// test seams; nil means the pgx implementations over Pool
	store  runStore
	locker locker
}

type watermarkState struct {
	Watermark      *time.Time
	LastFullSyncAt *time.Time
}

type runStats struct {
	Pages, Upserted, Tombstoned, ItemErrors int
	ErrorMsgs                               []string // first maxErrorMessages item errors
}

// pageApply is what applying one page did. Errors are per-item messages.
type pageApply struct {
	Upserted, Tombstoned int
	Errors               []string
}

type completion struct {
	Resource, RunID string
	Mode            Mode
	Watermark, Now  time.Time
	Reconcile       bool
	SeenSlugs       []string
	Stats           runStats
	Note            string // item-error summary, "" when none
}

type abortInfo struct {
	Resource, RunID, Status, Err string
	Now                          time.Time
	Stats                        runStats
}

// runStore is the persistence side of a run. Each Apply* is one transaction.
type runStore interface {
	LoadState(ctx context.Context, resource string) (watermarkState, error)
	StartRun(ctx context.Context, resource string, mode Mode) (string, error)
	ApplyFG(ctx context.Context, items []erpapi.IntegrationFG) (pageApply, error)
	ApplyOutlets(ctx context.Context, items []erpapi.IntegrationOutlet) (pageApply, error)
	// Complete reconciles (when asked), commits the watermark and finishes the run row in one tx.
	// refused is non-empty when the reconcile cap (R8) skipped the deactivation; it is already
	// part of the stored last_error and the run row.
	Complete(ctx context.Context, c completion) (deactivated int, refused string, err error)
	// Abort records a partial/failed run; it never moves the watermark.
	Abort(ctx context.Context, a abortInfo) error
}

// locker holds the single-flight lock for the whole run. release must be called once.
type locker interface {
	TryLock(ctx context.Context) (release func(context.Context) error, ok bool, err error)
}

// pageResult is one fetched-and-applied page.
type pageResult struct {
	Next       *string
	ServerTime time.Time
	Slugs      []string
	Apply      pageApply
}

type stepFn func(ctx context.Context, st runStore, req PageRequest) (pageResult, error)

func (s *Syncer) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Syncer) pageSize() int {
	if s.PageSize > 0 && s.PageSize < MaxTake {
		return s.PageSize
	}
	return MaxTake
}

func (s *Syncer) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

func (s *Syncer) deps() (runStore, locker, error) {
	if s.Source == nil {
		return nil, nil, errors.New("erp: syncer has no Source")
	}
	st, lk := s.store, s.locker
	if st == nil || lk == nil {
		if s.Pool == nil {
			return nil, nil, errors.New("erp: syncer has no Pool")
		}
		if st == nil {
			st = &pgStore{Pool: s.Pool}
		}
		if lk == nil {
			lk = pgLocker{Pool: s.Pool}
		}
	}
	return st, lk, nil
}

// Run pulls outlets then finished goods under the single-flight advisory lock.
// A busy lock is not an error: the report says skipped_locked and nothing is
// written. A failed or partial resource stops the run (later resources are not
// attempted). The returned error is only for infrastructure failures before any
// resource ran (bad config, lock acquisition); resource failures are in the report.
func (s *Syncer) Run(ctx context.Context, mode Mode) (CatalogReport, error) {
	if mode != ModeFull && mode != ModeIncremental && mode != ModeAuto {
		return CatalogReport{}, fmt.Errorf("erp: invalid sync mode %q", mode)
	}
	st, lk, err := s.deps()
	if err != nil {
		return CatalogReport{}, err
	}
	release, ok, err := lk.TryLock(ctx)
	if err != nil {
		return CatalogReport{Status: StatusFailed}, fmt.Errorf("erp: acquire catalog lock: %w", err)
	}
	if !ok {
		return CatalogReport{Status: StatusSkippedLocked}, nil
	}
	defer func() {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if rerr := release(rctx); rerr != nil {
			s.log().Warn("erp catalog lock release failed", "error", rerr)
		}
	}()

	budget := s.Budget
	if budget <= 0 {
		budget = defaultBudget
	}
	deadline := s.now().Add(budget)
	// R7: the budget is only checked between pages, so bound the whole run (a hung page or
	// commit) at budget + 5 s. The lock release below uses its own context.
	ctx, cancelRun := context.WithTimeout(ctx, budget+runGrace)
	defer cancelRun()

	steps := []struct {
		resource string
		step     stepFn
	}{
		{ResourceOutlets, s.outletsStep},
		{ResourceFinishedGoods, s.fgStep},
	}
	report := CatalogReport{Status: StatusCompleted}
	for _, x := range steps {
		r := s.runResource(ctx, st, x.resource, mode, x.step, deadline)
		report.Resources = append(report.Resources, r)
		s.log().Info("erp catalog pull", "resource", r.Resource, "mode", r.Mode, "status", r.Status,
			"pages", r.Pages, "upserted", r.Upserted, "tombstoned", r.Tombstoned,
			"deactivated", r.Deactivated, "item_errors", r.ItemErrors)
		if r.Status != StatusCompleted {
			report.Status = r.Status
			break
		}
	}
	return report, nil
}

// resolveMode turns the requested mode into full or incremental. Incremental
// with no watermark runs as full; auto is full when the last full sync is
// missing or older than 24 h.
func resolveMode(want Mode, st watermarkState, now time.Time) Mode {
	switch want {
	case ModeFull:
		return ModeFull
	case ModeIncremental:
		if st.Watermark == nil {
			return ModeFull
		}
		return ModeIncremental
	default:
		if st.Watermark == nil || st.LastFullSyncAt == nil || now.Sub(*st.LastFullSyncAt) > fullSyncMaxAge {
			return ModeFull
		}
		return ModeIncremental
	}
}

// runResource is the per-resource state machine: resolve mode, open the run
// row, page until the cursor ends (or the budget/an error stops it), then
// commit (complete) or record (abort). The watermark only moves on complete.
func (s *Syncer) runResource(ctx context.Context, st runStore, resource string, want Mode, step stepFn, deadline time.Time) ResourceResult {
	out := ResourceResult{Resource: resource}
	fail := func(err error) ResourceResult {
		out.Status, out.Error = StatusFailed, clip(err.Error())
		return out
	}

	state, err := st.LoadState(ctx, resource)
	if err != nil {
		return fail(fmt.Errorf("load watermark: %w", err))
	}
	mode := resolveMode(want, state, s.now())
	out.Mode = mode
	runID, err := st.StartRun(ctx, resource, mode)
	if err != nil {
		return fail(fmt.Errorf("start run: %w", err))
	}
	out.RunID = runID

	var since *time.Time
	if mode == ModeIncremental {
		t := state.Watermark.Add(-incrementalOverlap).UTC()
		since = &t
	}

	var (
		stats     runStats
		cursor    *string
		candidate *time.Time
		seen      []string
		stop      string // "" = ran to the end
		stopErr   string
	)
	for {
		if !s.now().Before(deadline) {
			stop, stopErr = StatusPartial, "time budget exhausted before the catalog was fully pulled"
			break
		}
		// updated_since is repeated on every page of an incremental run.
		pr, err := step(ctx, st, PageRequest{UpdatedSince: since, Cursor: cursor, Take: s.pageSize()})
		if err != nil {
			stop, stopErr = StatusFailed, clip(err.Error())
			break
		}
		stats.Pages++
		stats.Upserted += pr.Apply.Upserted
		stats.Tombstoned += pr.Apply.Tombstoned
		stats.ItemErrors += len(pr.Apply.Errors)
		for _, m := range pr.Apply.Errors {
			if len(stats.ErrorMsgs) < maxErrorMessages {
				stats.ErrorMsgs = append(stats.ErrorMsgs, m)
			}
		}
		if candidate == nil {
			w := pr.ServerTime.UTC()
			candidate = &w
		}
		if mode == ModeFull {
			seen = append(seen, pr.Slugs...)
		}
		if pr.Next == nil {
			break
		}
		if cursor != nil && *pr.Next == *cursor {
			stop, stopErr = StatusFailed, "ERP cursor did not advance"
			break
		}
		cursor = pr.Next
	}
	out.Pages, out.Upserted, out.Tombstoned, out.ItemErrors = stats.Pages, stats.Upserted, stats.Tombstoned, stats.ItemErrors

	if stop == "" {
		note := itemErrorNote(stats)
		deact, refused, cerr := st.Complete(ctx, completion{
			Resource: resource, RunID: runID, Mode: mode, Watermark: *candidate, Now: s.now(),
			Reconcile: mode == ModeFull, SeenSlugs: seen, Stats: stats, Note: note,
		})
		if cerr == nil {
			out.Status, out.Error, out.Deactivated = StatusCompleted, joinNotes(note, refused), deact
			w := *candidate
			out.Watermark = &w
			return out
		}
		stop, stopErr = StatusFailed, clip("commit run: "+cerr.Error())
	}
	out.Status, out.Error = stop, stopErr
	if aerr := st.Abort(ctx, abortInfo{Resource: resource, RunID: runID, Status: stop, Err: stopErr, Now: s.now(), Stats: stats}); aerr != nil {
		s.log().Error("erp catalog abort record failed", "resource", resource, "error", aerr)
	}
	return out
}

func joinNotes(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	}
	return clip(a + "; " + b)
}

func itemErrorNote(st runStats) string {
	if st.ItemErrors == 0 {
		return ""
	}
	return clip(fmt.Sprintf("%d item error(s): %s", st.ItemErrors, strings.Join(st.ErrorMsgs, "; ")))
}

func clip(s string) string {
	if len(s) > maxErrorText {
		return s[:maxErrorText]
	}
	return s
}

func (s *Syncer) fgStep(ctx context.Context, st runStore, req PageRequest) (pageResult, error) {
	pg, err := s.Source.FinishedGoodsPage(ctx, req)
	if err != nil {
		return pageResult{}, fmt.Errorf("fetch finished goods: %w", err)
	}
	if pg.ServerTime.IsZero() { // R9: a missing server_time would poison the watermark
		return pageResult{}, errors.New("ERP finished-goods page has no server_time")
	}
	slugs := make([]string, len(pg.Items))
	for i, it := range pg.Items {
		slugs[i] = it.Slug
	}
	pa, err := st.ApplyFG(ctx, pg.Items)
	if err != nil {
		return pageResult{}, fmt.Errorf("apply finished goods page: %w", err)
	}
	return pageResult{Next: pg.NextCursor, ServerTime: pg.ServerTime, Slugs: slugs, Apply: pa}, nil
}

func (s *Syncer) outletsStep(ctx context.Context, st runStore, req PageRequest) (pageResult, error) {
	pg, err := s.Source.OutletsPage(ctx, req)
	if err != nil {
		return pageResult{}, fmt.Errorf("fetch outlets: %w", err)
	}
	if pg.ServerTime.IsZero() { // R9
		return pageResult{}, errors.New("ERP outlets page has no server_time")
	}
	slugs := make([]string, len(pg.Items))
	for i, it := range pg.Items {
		slugs[i] = it.Slug
	}
	pa, err := st.ApplyOutlets(ctx, pg.Items)
	if err != nil {
		return pageResult{}, fmt.Errorf("apply outlets page: %w", err)
	}
	return pageResult{Next: pg.NextCursor, ServerTime: pg.ServerTime, Slugs: slugs, Apply: pa}, nil
}
