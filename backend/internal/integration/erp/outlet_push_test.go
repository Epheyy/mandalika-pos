package erp

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

type fakePushStore struct {
	cands    []pushCandidate
	candsErr error
	linkErr  error
	linked   []string // "id/slug/code"
	taken    map[string]bool

	linkErrFor map[string]error // by outlet id
}

func (f *fakePushStore) pushCandidates(context.Context) ([]pushCandidate, error) {
	return f.cands, f.candsErr
}

func (f *fakePushStore) linkPushed(_ context.Context, id, slug, code string) (bool, error) {
	if f.linkErr != nil {
		return false, f.linkErr
	}
	if err := f.linkErrFor[id]; err != nil {
		return false, err
	}
	if f.taken[id] {
		return false, nil
	}
	f.linked = append(f.linked, id+"/"+slug+"/"+code)
	return true, nil
}

type pushAnswer struct {
	res     OutletCreateResult
	outcome OutletCreateOutcome
	detail  string
	err     error
}

type fakeCreator struct {
	calls   []OutletCreate
	onCall  func()
	block   bool                  // wait for the call's ctx to end, then report it
	answers map[string]pushAnswer // by code; missing = created with slug = lower(code)
}

func (f *fakeCreator) CreateOutlet(ctx context.Context, in OutletCreate) (OutletCreateResult, OutletCreateOutcome, string, error) {
	f.calls = append(f.calls, in)
	if f.onCall != nil {
		f.onCall()
	}
	if f.block {
		<-ctx.Done()
		return OutletCreateResult{}, OutletUnavailable, "", ctx.Err()
	}
	if a, ok := f.answers[in.Code]; ok {
		return a.res, a.outcome, a.detail, a.err
	}
	return OutletCreateResult{Slug: strings.ToLower(in.Code), Code: in.Code}, OutletCreated, "", nil
}

func cand(code string) pushCandidate {
	return pushCandidate{ID: "id-" + code, Code: code, Name: "Outlet " + code}
}

func pushHarness(cands ...pushCandidate) (*harness, *fakePushStore, *fakeCreator) {
	h := newHarness()
	h.src.outletPages = []Page[erpapi.IntegrationOutlet]{{ServerTime: catT0}}
	h.src.fgPages = []Page[erpapi.IntegrationFG]{fgPage("", catT0, "a")}
	ps := &fakePushStore{cands: cands}
	cr := &fakeCreator{}
	h.syn.pushStore, h.syn.Pusher = ps, cr
	return h, ps, cr
}

func TestPushNilPusherDoesNothing(t *testing.T) {
	h, ps, cr := pushHarness(cand("GANCIT"))
	h.syn.Pusher = nil
	r := mustRun(t, h, ModeFull)
	if r.OutletPush != nil || len(cr.calls) != 0 || len(ps.linked) != 0 {
		t.Fatalf("report %+v calls %v linked %v", r, cr.calls, ps.linked)
	}
}

func TestPushCapsAtTenAndLeavesTheRest(t *testing.T) {
	var cands []pushCandidate
	for i := 0; i < 15; i++ {
		cands = append(cands, cand(fmt.Sprintf("OUT%02d", i)))
	}
	h, ps, cr := pushHarness(cands...)
	p := mustRun(t, h, ModeFull).OutletPush
	if p == nil || p.Attempted != 10 || p.Linked != 10 || p.Status != PushCompleted || len(cr.calls) != 10 || len(ps.linked) != 10 {
		t.Fatalf("push %+v calls %d linked %d", p, len(cr.calls), len(ps.linked))
	}
	if cr.calls[0].Code != "OUT00" || cr.calls[9].Code != "OUT09" {
		t.Fatalf("not oldest first: %v", cr.calls)
	}
}

func TestPushInvalidCodeIsNotedAndNotCountedAgainstTheCap(t *testing.T) {
	cands := []pushCandidate{cand("X"), cand("BAD CODE")}
	for i := 0; i < 10; i++ {
		cands = append(cands, cand(fmt.Sprintf("OUT%02d", i)))
	}
	h, _, cr := pushHarness(cands...)
	p := mustRun(t, h, ModeFull).OutletPush
	if p.Attempted != 10 || len(cr.calls) != 10 || len(p.Notes) != 2 {
		t.Fatalf("push %+v calls %d", p, len(cr.calls))
	}
	for _, c := range cr.calls {
		if c.Code == "X" || c.Code == "BAD CODE" {
			t.Fatalf("invalid code was sent: %+v", c)
		}
	}
}

func TestPushCreatedIsLinkedWithErpSlugAndCode(t *testing.T) {
	h, ps, cr := pushHarness(cand("GANCIT"))
	cr.answers = map[string]pushAnswer{"GANCIT": {res: OutletCreateResult{Slug: "gancit-2", Code: "GANCIT"}, outcome: OutletCreated}}
	p := mustRun(t, h, ModeFull).OutletPush
	if p.Linked != 1 || !reflect.DeepEqual(ps.linked, []string{"id-GANCIT/gancit-2/GANCIT"}) {
		t.Fatalf("push %+v linked %v", p, ps.linked)
	}
	if got := cr.calls[0]; got.ExternalID != "id-GANCIT" || got.Name != "Outlet GANCIT" {
		t.Fatalf("call %+v", got)
	}
}

func TestPushLinkedElsewhereIsNotCounted(t *testing.T) {
	h, ps, _ := pushHarness(cand("GANCIT"))
	ps.taken = map[string]bool{"id-GANCIT": true}
	p := mustRun(t, h, ModeFull).OutletPush
	if p.Attempted != 1 || p.Linked != 0 || p.Status != PushCompleted || len(p.Notes) != 1 || !strings.Contains(p.Notes[0], "gancit") {
		t.Fatalf("push %+v", p)
	}
}

func TestPushCodeTakenNotesAndDoesNotLink(t *testing.T) {
	h, ps, cr := pushHarness(cand("GANCIT"))
	cr.answers = map[string]pushAnswer{"GANCIT": {outcome: OutletCodeTaken, detail: "code taken by x"}}
	p := mustRun(t, h, ModeFull).OutletPush
	want := []string{"outlet GANCIT not created in ERP: code taken by x"}
	if !reflect.DeepEqual(p.Notes, want) || len(ps.linked) != 0 || p.Status != PushCompleted {
		t.Fatalf("push %+v linked %v", p, ps.linked)
	}
}

func TestPushRejectedNotesAndContinues(t *testing.T) {
	h, ps, cr := pushHarness(cand("AAA"), cand("BBB"))
	cr.answers = map[string]pushAnswer{"AAA": {outcome: OutletRejected, detail: "HTTP 422 VALIDATION_ERROR bad"}}
	p := mustRun(t, h, ModeFull).OutletPush
	if len(cr.calls) != 2 || p.Linked != 1 || len(p.Notes) != 1 || len(ps.linked) != 1 || p.Status != PushCompleted {
		t.Fatalf("push %+v calls %d", p, len(cr.calls))
	}
}

func TestPushStopsOnMissingEndpointOrUnavailableAndFinishedGoodsStillRun(t *testing.T) {
	for _, tc := range []struct {
		name    string
		outcome OutletCreateOutcome
	}{{"endpoint missing", OutletEndpointMissing}, {"unavailable", OutletUnavailable}} {
		t.Run(tc.name, func(t *testing.T) {
			h, ps, cr := pushHarness(cand("AAA"), cand("BBB"))
			cr.answers = map[string]pushAnswer{"AAA": {outcome: tc.outcome, detail: "HTTP 404"}}
			r := mustRun(t, h, ModeFull)
			p := r.OutletPush
			if p.Status != PushStopped || len(cr.calls) != 1 || len(p.Notes) != 1 || len(ps.linked) != 0 {
				t.Fatalf("push %+v calls %d", p, len(cr.calls))
			}
			if r.Status != StatusCompleted || len(r.Resources) != 2 || r.Resources[1].Resource != ResourceFinishedGoods {
				t.Fatalf("finished goods did not run: %+v", r)
			}
		})
	}
}

func TestPushContextErrorStops(t *testing.T) {
	h, _, cr := pushHarness(cand("AAA"), cand("BBB"))
	cr.answers = map[string]pushAnswer{"AAA": {outcome: OutletUnavailable, err: context.Canceled}}
	p := mustRun(t, h, ModeFull).OutletPush
	if p.Status != PushStopped || len(cr.calls) != 1 {
		t.Fatalf("push %+v calls %d", p, len(cr.calls))
	}
}

func TestPushStoreErrorsStop(t *testing.T) {
	h, ps, cr := pushHarness(cand("AAA"))
	ps.candsErr = errors.New("db down")
	if p := mustRun(t, h, ModeFull).OutletPush; p.Status != PushStopped || len(cr.calls) != 0 {
		t.Fatalf("candidates error: %+v", p)
	}
	h2, ps2, _ := pushHarness(cand("AAA"))
	ps2.linkErr = errors.New("db down")
	if p := mustRun(t, h2, ModeFull).OutletPush; p.Status != PushStopped || p.Linked != 0 {
		t.Fatalf("link error: %+v", p)
	}
}

func TestPushDoesNotRunWhenOutletsDidNotComplete(t *testing.T) {
	h, _, cr := pushHarness(cand("AAA"))
	h.st.completeErr = errors.New("nope")
	r := mustRun(t, h, ModeFull)
	if r.Status != StatusFailed || r.OutletPush != nil || len(cr.calls) != 0 {
		t.Fatalf("report %+v calls %d", r, len(cr.calls))
	}
}

func TestPushStopsWhenTheBudgetReserveIsReachedAndFinishedGoodsStillRun(t *testing.T) {
	h, ps, cr := pushHarness(cand("AAA"), cand("BBB"), cand("CCC"))
	cr.onCall = func() { *h.clock = h.clock.Add(31 * time.Second) } // budget is 1 min, reserve 30 s
	r := mustRun(t, h, ModeFull)
	p := r.OutletPush
	if p.Status != PushStopped || len(cr.calls) != 1 || len(ps.linked) != 1 || len(p.Notes) != 1 || p.Notes[0] != "outlet push stopped: run budget" {
		t.Fatalf("push %+v calls %d", p, len(cr.calls))
	}
	if r.Status != StatusCompleted || len(r.Resources) != 2 || r.Resources[1].Status != StatusCompleted {
		t.Fatalf("finished goods did not complete: %+v", r)
	}
}

func TestPushUnauthorizedStopsAfterTheFirstCall(t *testing.T) {
	h, _, cr := pushHarness(cand("AAA"), cand("BBB"))
	cr.answers = map[string]pushAnswer{"AAA": {outcome: OutletUnauthorized, detail: "HTTP 403"}}
	p := mustRun(t, h, ModeFull).OutletPush
	if p.Status != PushStopped || len(cr.calls) != 1 || len(p.Notes) != 1 || !strings.Contains(p.Notes[0], "integration:outlet:write") {
		t.Fatalf("push %+v calls %d", p, len(cr.calls))
	}
}

func TestPushSlugUniqueViolationIsNotedAndContinues(t *testing.T) {
	h, ps, cr := pushHarness(cand("AAA"), cand("BBB"))
	ps.linkErrFor = map[string]error{"id-AAA": &pgconn.PgError{Code: "23505"}}
	p := mustRun(t, h, ModeFull).OutletPush
	if p.Status != PushCompleted || len(cr.calls) != 2 || p.Linked != 1 || len(p.Notes) != 1 || !strings.Contains(p.Notes[0], "aaa") {
		t.Fatalf("push %+v calls %d", p, len(cr.calls))
	}
}

func TestPushCallIsCutOffAtTheReserveAndFinishedGoodsStillRun(t *testing.T) {
	h, ps, cr := pushHarness(cand("AAA"), cand("BBB"))
	h.syn.Budget = 100 * time.Millisecond // reserve 50 ms of real time for the call
	cr.block = true
	r := mustRun(t, h, ModeFull)
	p := r.OutletPush
	if p.Status != PushStopped || len(cr.calls) != 1 || len(ps.linked) != 0 || len(p.Notes) != 1 || p.Notes[0] != "outlet push stopped: run budget" {
		t.Fatalf("push %+v calls %d", p, len(cr.calls))
	}
	if r.Status != StatusCompleted || len(r.Resources) != 2 || r.Resources[1].Status != StatusCompleted {
		t.Fatalf("finished goods did not complete: %+v", r)
	}
}

func TestPushParentCancellationIsNotABudgetStop(t *testing.T) {
	cr := &fakeCreator{block: true}
	s := &Syncer{Pusher: cr}
	ctx, cancel := context.WithCancel(context.Background())
	cr.onCall = cancel
	p := s.pushOutlets(ctx, &fakePushStore{cands: []pushCandidate{cand("AAA")}}, time.Now().Add(time.Minute))
	if p.Status != PushStopped || len(p.Notes) != 1 || strings.Contains(p.Notes[0], "run budget") {
		t.Fatalf("push %+v", p)
	}
}
