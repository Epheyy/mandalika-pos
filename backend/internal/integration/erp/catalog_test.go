package erp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// ---- fakes -----------------------------------------------------------------

type fakeSource struct {
	fgPages     []Page[erpapi.IntegrationFG]
	outletPages []Page[erpapi.IntegrationOutlet]
	fgErrAt     int // 1-based call index that errors; 0 = never
	fgReqs      []PageRequest
	outletReqs  []PageRequest
	onFGCall    func() // e.g. advance the fake clock
}

func (f *fakeSource) FinishedGoodsPage(_ context.Context, r PageRequest) (Page[erpapi.IntegrationFG], error) {
	f.fgReqs = append(f.fgReqs, r)
	n := len(f.fgReqs)
	if f.onFGCall != nil {
		f.onFGCall()
	}
	if n == f.fgErrAt {
		return Page[erpapi.IntegrationFG]{}, errors.New("boom: ERP 500")
	}
	return f.fgPages[n-1], nil
}

func (f *fakeSource) OutletsPage(_ context.Context, r PageRequest) (Page[erpapi.IntegrationOutlet], error) {
	f.outletReqs = append(f.outletReqs, r)
	n := len(f.outletReqs)
	if n > len(f.outletPages) {
		return Page[erpapi.IntegrationOutlet]{ServerTime: catT0}, nil
	}
	return f.outletPages[n-1], nil
}

type fakeStore struct {
	states      map[string]watermarkState
	started     []string // "resource/mode"
	completions []completion
	aborts      []abortInfo
	fgApplied   [][]erpapi.IntegrationFG
	applyFG     func(items []erpapi.IntegrationFG) (pageApply, error)
	completeErr error
	deactivated int
	refused     string
}

func newFakeStore() *fakeStore { return &fakeStore{states: map[string]watermarkState{}} }

func (s *fakeStore) LoadState(_ context.Context, res string) (watermarkState, error) {
	return s.states[res], nil
}
func (s *fakeStore) StartRun(_ context.Context, res string, m Mode) (string, error) {
	s.started = append(s.started, res+"/"+string(m))
	return fmt.Sprintf("run-%d", len(s.started)), nil
}
func (s *fakeStore) ApplyFG(_ context.Context, items []erpapi.IntegrationFG) (pageApply, error) {
	s.fgApplied = append(s.fgApplied, items)
	if s.applyFG != nil {
		return s.applyFG(items)
	}
	return pageApply{Upserted: len(items)}, nil
}
func (s *fakeStore) ApplyOutlets(_ context.Context, items []erpapi.IntegrationOutlet) (pageApply, error) {
	return pageApply{Upserted: len(items)}, nil
}
func (s *fakeStore) Complete(_ context.Context, c completion) (int, string, error) {
	if s.completeErr != nil {
		return 0, "", s.completeErr
	}
	s.completions = append(s.completions, c)
	return s.deactivated, s.refused, nil
}
func (s *fakeStore) Abort(_ context.Context, a abortInfo) error {
	s.aborts = append(s.aborts, a)
	return nil
}

type fakeLocker struct {
	busy     bool
	err      error
	acquired int
	released int
}

func (l *fakeLocker) TryLock(context.Context) (func(context.Context) error, bool, error) {
	if l.err != nil {
		return nil, false, l.err
	}
	if l.busy {
		return nil, false, nil
	}
	l.acquired++
	return func(context.Context) error { l.released++; return nil }, true, nil
}

var catT0 = time.Date(2026, 10, 22, 8, 0, 0, 0, time.UTC)

type harness struct {
	syn   *Syncer
	src   *fakeSource
	st    *fakeStore
	lk    *fakeLocker
	clock *time.Time
}

func newHarness() *harness {
	clock := catT0
	h := &harness{src: &fakeSource{}, st: newFakeStore(), lk: &fakeLocker{}, clock: &clock}
	h.syn = &Syncer{
		Source: h.src, Now: func() time.Time { return clock }, Budget: time.Minute,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		store:  h.st, locker: h.lk,
	}
	return h
}

func fg(slug string) erpapi.IntegrationFG {
	return erpapi.IntegrationFG{Slug: slug, Code: strings.ToUpper(slug), Name: slug, Status: erpapi.ACTIVE}
}

func fgPage(next string, st time.Time, slugs ...string) Page[erpapi.IntegrationFG] {
	p := Page[erpapi.IntegrationFG]{ServerTime: st}
	for _, s := range slugs {
		p.Items = append(p.Items, fg(s))
	}
	if next != "" {
		p.NextCursor = &next
	}
	return p
}

func (h *harness) fgRes(t *testing.T, r CatalogReport) ResourceResult {
	t.Helper()
	for _, x := range r.Resources {
		if x.Resource == ResourceFinishedGoods {
			return x
		}
	}
	t.Fatalf("no finished_goods result in %+v", r)
	return ResourceResult{}
}

func mustRun(t *testing.T, h *harness, m Mode) CatalogReport {
	t.Helper()
	r, err := h.syn.Run(context.Background(), m)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return r
}

// ---- tests -----------------------------------------------------------------

func TestParseMode(t *testing.T) {
	for in, want := range map[string]Mode{"full": ModeFull, "Incremental": ModeIncremental, " AUTO ": ModeAuto, "": ModeAuto} {
		got, err := ParseMode(in)
		if err != nil || got != want {
			t.Errorf("ParseMode(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := ParseMode("weekly"); err == nil {
		t.Error("ParseMode(weekly) must fail")
	}
	if _, err := newHarness().syn.Run(context.Background(), Mode("bogus")); err == nil {
		t.Error("Run with an invalid mode must fail")
	}
}

func TestResolveMode(t *testing.T) {
	wm := catT0.Add(-time.Hour)
	recent := catT0.Add(-2 * time.Hour)
	old := catT0.Add(-25 * time.Hour)
	tests := []struct {
		name string
		want Mode
		st   watermarkState
		out  Mode
	}{
		{"full stays full", ModeFull, watermarkState{Watermark: &wm, LastFullSyncAt: &recent}, ModeFull},
		{"incremental without watermark runs full", ModeIncremental, watermarkState{}, ModeFull},
		{"incremental with watermark", ModeIncremental, watermarkState{Watermark: &wm}, ModeIncremental},
		{"auto without last full", ModeAuto, watermarkState{Watermark: &wm}, ModeFull},
		{"auto with stale last full", ModeAuto, watermarkState{Watermark: &wm, LastFullSyncAt: &old}, ModeFull},
		{"auto with recent last full", ModeAuto, watermarkState{Watermark: &wm, LastFullSyncAt: &recent}, ModeIncremental},
		{"auto first ever", ModeAuto, watermarkState{}, ModeFull},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveMode(tc.want, tc.st, catT0); got != tc.out {
				t.Fatalf("resolveMode = %q, want %q", got, tc.out)
			}
		})
	}
}

func TestIncrementalRepeatsSinceOnEveryPageAndAdvancesCursor(t *testing.T) {
	h := newHarness()
	// A watermark carrying a non-UTC zone must still be sent as UTC, minus 5 minutes.
	wm := time.Date(2026, 10, 22, 7, 0, 0, 0, time.FixedZone("WIB", 7*3600))
	h.st.states[ResourceFinishedGoods] = watermarkState{Watermark: &wm}
	h.src.fgPages = []Page[erpapi.IntegrationFG]{
		fgPage("c1", catT0, "a"), fgPage("c2", catT0.Add(time.Second), "b"), fgPage("", catT0.Add(2*time.Second), "c"),
	}

	r := mustRun(t, h, ModeIncremental)

	wantSince := wm.Add(-5 * time.Minute).UTC()
	if len(h.src.fgReqs) != 3 {
		t.Fatalf("requests = %d, want 3", len(h.src.fgReqs))
	}
	var cursors []string
	for i, q := range h.src.fgReqs {
		if q.UpdatedSince == nil || !q.UpdatedSince.Equal(wantSince) || q.UpdatedSince.Location() != time.UTC {
			t.Fatalf("page %d UpdatedSince = %v, want %v in UTC", i+1, q.UpdatedSince, wantSince)
		}
		if q.Take != MaxTake {
			t.Fatalf("page %d Take = %d", i+1, q.Take)
		}
		if q.Cursor == nil {
			cursors = append(cursors, "")
		} else {
			cursors = append(cursors, *q.Cursor)
		}
	}
	if !reflect.DeepEqual(cursors, []string{"", "c1", "c2"}) {
		t.Fatalf("cursor progression = %v", cursors)
	}
	res := h.fgRes(t, r)
	if res.Mode != ModeIncremental || res.Pages != 3 || res.Upserted != 3 || res.Status != StatusCompleted {
		t.Fatalf("result = %+v", res)
	}
	if len(h.st.completions) != 2 || h.st.completions[1].Reconcile || len(h.st.completions[1].SeenSlugs) != 0 {
		t.Fatalf("incremental must not reconcile or collect slugs: %+v", h.st.completions)
	}
}

func TestCandidateWatermarkIsFirstPageServerTime(t *testing.T) {
	h := newHarness()
	first := catT0.Add(-90 * time.Second)
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("c1", first, "a"), fgPage("", catT0.Add(time.Minute), "b")}

	r := mustRun(t, h, ModeFull)

	c := h.st.completions[len(h.st.completions)-1]
	if c.Resource != ResourceFinishedGoods || !c.Watermark.Equal(first) {
		t.Fatalf("watermark = %v, want first page server time %v", c.Watermark, first)
	}
	if res := h.fgRes(t, r); res.Watermark == nil || !res.Watermark.Equal(first) {
		t.Fatalf("result watermark = %v", res.Watermark)
	}
}

func TestFullRunHasNoSinceAndReconcilesWithAllSeenSlugs(t *testing.T) {
	h := newHarness()
	h.st.deactivated = 4
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("c1", catT0, "a", "b"), fgPage("", catT0, "c")}

	r := mustRun(t, h, ModeFull)

	for i, q := range h.src.fgReqs {
		if q.UpdatedSince != nil {
			t.Fatalf("full page %d sent updated_since %v", i+1, q.UpdatedSince)
		}
	}
	c := h.st.completions[len(h.st.completions)-1]
	if !c.Reconcile || c.Mode != ModeFull || !reflect.DeepEqual(c.SeenSlugs, []string{"a", "b", "c"}) {
		t.Fatalf("completion = %+v", c)
	}
	if res := h.fgRes(t, r); res.Deactivated != 4 {
		t.Fatalf("Deactivated = %d, want 4", res.Deactivated)
	}
}

func TestEmptyCompleteRunStillAdvancesWatermark(t *testing.T) {
	h := newHarness()
	wm := catT0.Add(-time.Hour)
	h.st.states[ResourceFinishedGoods] = watermarkState{Watermark: &wm}
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0)} // no items, no next

	r := mustRun(t, h, ModeIncremental)

	if res := h.fgRes(t, r); res.Status != StatusCompleted || res.Watermark == nil || !res.Watermark.Equal(catT0) {
		t.Fatalf("empty run result = %+v", res)
	}
	if c := h.st.completions[len(h.st.completions)-1]; !c.Watermark.Equal(catT0) {
		t.Fatalf("committed watermark = %v", c.Watermark)
	}
}

func TestBudgetExhaustionIsPartialAndNeverMovesWatermark(t *testing.T) {
	h := newHarness()
	h.syn.Budget = 10 * time.Second
	h.src.fgPages = []Page[erpapi.IntegrationFG]{
		fgPage("c1", catT0, "a"), fgPage("c2", catT0, "b"), fgPage("", catT0, "c"),
	}
	h.src.onFGCall = func() { *h.clock = h.clock.Add(6 * time.Second) } // 6 s per page

	r := mustRun(t, h, ModeFull)

	if r.Status != StatusPartial {
		t.Fatalf("report status = %q", r.Status)
	}
	if len(h.src.fgReqs) != 2 {
		t.Fatalf("fetched %d pages, want 2 (stops before the third fetch)", len(h.src.fgReqs))
	}
	res := h.fgRes(t, r)
	if res.Status != StatusPartial || res.Pages != 2 || res.Watermark != nil {
		t.Fatalf("result = %+v", res)
	}
	for _, c := range h.st.completions {
		if c.Resource == ResourceFinishedGoods {
			t.Fatalf("partial run must not complete/reconcile: %+v", c)
		}
	}
	if n := len(h.st.aborts); n != 1 || h.st.aborts[0].Status != StatusPartial || h.st.aborts[0].Stats.Pages != 2 {
		t.Fatalf("aborts = %+v", h.st.aborts)
	}
}

func TestFetchErrorFailsRunWithoutCompleting(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("c1", catT0, "a"), {}}
	h.src.fgErrAt = 2

	r := mustRun(t, h, ModeFull)

	res := h.fgRes(t, r)
	if r.Status != StatusFailed || res.Status != StatusFailed || !strings.Contains(res.Error, "ERP 500") || res.Pages != 1 {
		t.Fatalf("report %q result %+v", r.Status, res)
	}
	if len(h.st.aborts) != 1 || h.st.aborts[0].Status != StatusFailed {
		t.Fatalf("aborts = %+v", h.st.aborts)
	}
	for _, c := range h.st.completions {
		if c.Resource == ResourceFinishedGoods {
			t.Fatal("failed run committed a watermark")
		}
	}
}

func TestApplyErrorFailsRun(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0, "a")}
	h.st.applyFG = func([]erpapi.IntegrationFG) (pageApply, error) { return pageApply{}, errors.New("db down") }

	r := mustRun(t, h, ModeFull)

	if res := h.fgRes(t, r); res.Status != StatusFailed || !strings.Contains(res.Error, "db down") {
		t.Fatalf("result = %+v", res)
	}
	if len(h.st.aborts) != 1 {
		t.Fatalf("aborts = %+v", h.st.aborts)
	}
}

func TestCommitFailureFailsRunAndRecordsAbort(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0, "a")}
	h.st.completeErr = errors.New("tx rolled back")

	r := mustRun(t, h, ModeFull)

	// Outlets also fail on Complete, so the run stops at the first resource.
	if r.Status != StatusFailed || len(h.st.aborts) != 1 || !strings.Contains(h.st.aborts[0].Err, "tx rolled back") {
		t.Fatalf("report %+v aborts %+v", r, h.st.aborts)
	}
	if r.Resources[0].Watermark != nil {
		t.Fatal("a failed commit must not report a watermark")
	}
}

func TestStuckCursorFails(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("c1", catT0, "a"), fgPage("c1", catT0, "b")}

	r := mustRun(t, h, ModeFull)

	if res := h.fgRes(t, r); res.Status != StatusFailed || !strings.Contains(res.Error, "cursor") {
		t.Fatalf("result = %+v", res)
	}
}

func TestItemErrorsAreCountedCappedAndRunStillCompletes(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("c1", catT0, "a"), fgPage("", catT0, "b")}
	h.st.applyFG = func(items []erpapi.IntegrationFG) (pageApply, error) {
		var errs []string
		for i := 0; i < 8; i++ {
			errs = append(errs, fmt.Sprintf("fg %s-%d: conflict", items[0].Slug, i))
		}
		return pageApply{Upserted: len(items), Tombstoned: 1, Errors: errs}, nil
	}

	r := mustRun(t, h, ModeFull)

	res := h.fgRes(t, r)
	if res.Status != StatusCompleted || res.ItemErrors != 16 || res.Tombstoned != 2 || res.Watermark == nil {
		t.Fatalf("result = %+v", res)
	}
	if !strings.HasPrefix(res.Error, "16 item error(s):") || strings.Count(res.Error, "conflict") != maxErrorMessages {
		t.Fatalf("error summary = %q", res.Error)
	}
	if c := h.st.completions[len(h.st.completions)-1]; c.Note != res.Error {
		t.Fatalf("completion note %q != %q", c.Note, res.Error)
	}
}

func TestOutletsRunFirstAndFailureStopsFinishedGoods(t *testing.T) {
	h := newHarness()
	h.src.outletPages = []Page[erpapi.IntegrationOutlet]{{ServerTime: catT0}}
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0, "a")}

	r := mustRun(t, h, ModeFull)
	if r.Status != StatusCompleted || len(r.Resources) != 2 || r.Resources[0].Resource != ResourceOutlets || r.Resources[1].Resource != ResourceFinishedGoods {
		t.Fatalf("report = %+v", r)
	}
	if !reflect.DeepEqual(h.st.started, []string{"outlets/full", "finished_goods/full"}) {
		t.Fatalf("started = %v", h.st.started)
	}

	// Outlets failing (commit error) must not attempt finished goods.
	h2 := newHarness()
	h2.st.completeErr = errors.New("nope")
	r2 := mustRun(t, h2, ModeFull)
	if r2.Status != StatusFailed || len(r2.Resources) != 1 || len(h2.src.fgReqs) != 0 {
		t.Fatalf("report = %+v, fg requests %d", r2, len(h2.src.fgReqs))
	}
}

func TestAutoModePicksFullWhenLastFullIsStale(t *testing.T) {
	h := newHarness()
	wm, old := catT0.Add(-time.Hour), catT0.Add(-30*time.Hour)
	h.st.states[ResourceOutlets] = watermarkState{Watermark: &wm, LastFullSyncAt: &old}
	h.st.states[ResourceFinishedGoods] = watermarkState{Watermark: &wm, LastFullSyncAt: &old}
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0)}

	r := mustRun(t, h, ModeAuto)

	if r.Resources[0].Mode != ModeFull || h.fgRes(t, r).Mode != ModeFull {
		t.Fatalf("auto with a 30h-old full sync must run full: %+v", r.Resources)
	}
	if h.src.fgReqs[0].UpdatedSince != nil {
		t.Fatal("full run sent updated_since")
	}
}

func TestLockBusySkipsWithoutTouchingStoreOrSource(t *testing.T) {
	h := newHarness()
	h.lk.busy = true

	r, err := h.syn.Run(context.Background(), ModeFull)

	if err != nil || r.Status != StatusSkippedLocked || len(r.Resources) != 0 {
		t.Fatalf("report %+v err %v", r, err)
	}
	if len(h.st.started) != 0 || len(h.src.fgReqs) != 0 || len(h.src.outletReqs) != 0 || len(h.st.aborts) != 0 {
		t.Fatal("a skipped run must write and fetch nothing")
	}
}

func TestLockIsReleasedAfterSuccessAndAfterFailure(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0)}
	mustRun(t, h, ModeFull)
	if h.lk.acquired != 1 || h.lk.released != 1 {
		t.Fatalf("after success acquired=%d released=%d", h.lk.acquired, h.lk.released)
	}

	h2 := newHarness()
	h2.st.completeErr = errors.New("x")
	mustRun(t, h2, ModeFull)
	if h2.lk.acquired != 1 || h2.lk.released != 1 {
		t.Fatalf("after failure acquired=%d released=%d", h2.lk.acquired, h2.lk.released)
	}
}

func TestLockAcquisitionErrorIsReturned(t *testing.T) {
	h := newHarness()
	h.lk.err = errors.New("pool exhausted")
	r, err := h.syn.Run(context.Background(), ModeFull)
	if err == nil || r.Status != StatusFailed || len(h.st.started) != 0 {
		t.Fatalf("report %+v err %v", r, err)
	}
}

func TestRunRequiresSourceAndPool(t *testing.T) {
	if _, err := (&Syncer{}).Run(context.Background(), ModeFull); err == nil {
		t.Error("no Source must fail")
	}
	if _, err := (&Syncer{Source: &fakeSource{}}).Run(context.Background(), ModeFull); err == nil {
		t.Error("no Pool and no injected store must fail")
	}
}

func TestZeroServerTimeFailsTheRunAndNeverAppliesThePage(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", time.Time{}, "a")}

	r := mustRun(t, h, ModeFull)

	res := h.fgRes(t, r)
	if res.Status != StatusFailed || !strings.Contains(res.Error, "server_time") || res.Watermark != nil {
		t.Fatalf("result = %+v", res)
	}
	if len(h.st.fgApplied) != 0 {
		t.Fatal("a page without server_time must not be applied")
	}
	for _, c := range h.st.completions {
		if c.Resource == ResourceFinishedGoods {
			t.Fatal("a failed finished-goods run must not complete")
		}
	}
}

func TestReconcileRefusalIsReportedOnACompletedRun(t *testing.T) {
	h := newHarness()
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0, "a")}
	h.st.refused = "reconcile refused: 9 of 10 linked rows missing from the ERP catalog"

	r := mustRun(t, h, ModeFull)

	res := h.fgRes(t, r)
	if res.Status != StatusCompleted || res.Watermark == nil || !strings.Contains(res.Error, "reconcile refused") || res.Deactivated != 0 {
		t.Fatalf("result = %+v", res)
	}
}

func TestOverCapAllowsSmallGapsAndTwentyPercent(t *testing.T) {
	cases := []struct {
		missing, linked int
		want            bool
	}{
		{5, 5, false}, {6, 6, true}, {5, 10, false}, {20, 100, false}, {21, 100, true}, {100, 1000, false}, {201, 1000, true},
	}
	for _, c := range cases {
		if got := overCap(c.missing, c.linked); got != c.want {
			t.Errorf("overCap(%d,%d)=%v want %v", c.missing, c.linked, got, c.want)
		}
	}
}

func TestUnchangedFGMirrorsTheItemApply(t *testing.T) {
	sp := func(v string) *string { return &v }
	base := fgSnap{sku: "A", productName: "a", active: true, productActive: true, hasActive: true,
		category: sp("edp"), erpName: sp("a"), erpCategory: sp("EDP"), srcName: sp("a"), srcCategory: sp("edp")}
	f := fg("a")
	f.Code, f.Name, f.Category = "A", "a", sp("EDP")
	if !unchangedFG(f, base) {
		t.Fatal("identical state must be skipped")
	}
	f.Category = sp("  EDP ")
	if !unchangedFG(f, base) {
		t.Fatal("the stored category is compared with spaces collapsed")
	}
	f.Category = sp("Parfum")
	if unchangedFG(f, base) {
		t.Fatal("a changed FG category must be stored, not skipped")
	}
	f.Category = sp("EDP")
	f.Name = "a prime"
	if unchangedFG(f, base) {
		t.Fatal("a changed FG name must be stored, not skipped")
	}
	f.Name = "a"
	legacy := base
	legacy.erpName, legacy.erpCategory = nil, nil
	if unchangedFG(f, legacy) {
		t.Fatal("a row without stored source values (before migration 0068) must be written once")
	}
	drift := base
	drift.srcName = sp("a prime")
	if unchangedFG(f, drift) {
		t.Fatal("a product not showing its source name must be re-synced")
	}
	drift = base
	drift.srcCategory = sp("parfum")
	if unchangedFG(f, drift) {
		t.Fatal("a product not showing its source category must be re-synced")
	}
	drift = base
	drift.category = nil
	if unchangedFG(f, drift) {
		t.Fatal("a product without a category must take its source category")
	}
	noSrc := base // a higher-ranked size was never stored: the product keeps what it has
	noSrc.srcName, noSrc.srcCategory, noSrc.productName, noSrc.category = nil, nil, "legacy", nil
	if !unchangedFG(f, noSrc) {
		t.Fatal("no source values: the product keeps what it has")
	}
	f.Status = erpapi.DISCONTINUE
	if unchangedFG(f, base) {
		t.Fatal("status change must not be skipped")
	}
	f.Status = erpapi.ACTIVE
	stale := base
	stale.hasActive = false
	if unchangedFG(f, stale) {
		t.Fatal("an active product without an active variant must be cleared, not skipped")
	}
	f.Name = ""
	if unchangedFG(f, base) {
		t.Fatal("an invalid item must go through the item path to be reported")
	}
}
