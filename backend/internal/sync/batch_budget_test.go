package sync

import (
	"context"
	"testing"
	"time"
)

// fakeClock advances by step on every read, so a batch "spends" step per clock read.
type fakeClock struct {
	t    time.Time
	step time.Duration
}

func (c *fakeClock) now() time.Time {
	v := c.t
	c.t = c.t.Add(c.step)
	return v
}

func budgetItems(types ...string) []BatchItem {
	out := make([]BatchItem, len(types))
	for i, ty := range types {
		out[i] = BatchItem{Type: ty, IdempotencyKey: string(rune('a' + i))}
	}
	return out
}

// runBudget runs processBatchBudget with a fake process that records calls.
func runBudget(t *testing.T, ctx context.Context, items []BatchItem, budget time.Duration, clk *fakeClock) (BatchResult, []string, int) {
	t.Helper()
	var called []string
	versionCalls := 0
	res, err := processBatchBudget(ctx, Caller{OutletID: "o"}, items,
		func(_ context.Context, _ Caller, it BatchItem) ItemResult {
			called = append(called, it.IdempotencyKey)
			return ItemResult{IdempotencyKey: it.IdempotencyKey, Status: "ok"}
		},
		func(context.Context, string) (VersionInfo, error) {
			versionCalls++
			return VersionInfo{Version: 7}, nil
		}, budget, clk.now)
	if err != nil {
		t.Fatal(err)
	}
	return res, called, versionCalls
}

func assertDeferred(t *testing.T, r ItemResult, key string) {
	t.Helper()
	if r.IdempotencyKey != key || r.Status != "error" || r.Code != "busy" || r.Retryable == nil || !*r.Retryable || r.Error != budgetDeferredMessage {
		t.Fatalf("want deferred busy/retryable for %q, got %+v", key, r)
	}
}

func TestBudgetDefersItemsAfterBudgetAndNeverProcessesThem(t *testing.T) {
	// Each clock read advances 11 s, budget 10 s: the start read is t=0, the first item is
	// never checked, and the check before item b reads 11 s, which is already over budget.
	clk := &fakeClock{t: time.Unix(0, 0), step: 11 * time.Second}
	res, called, _ := runBudget(t, context.Background(), budgetItems("sale", "sale", "sale", "sale"), 10*time.Second, clk)
	if len(called) != 1 || called[0] != "a" {
		t.Fatalf("only the first item may run, called=%v", called)
	}
	if res.Results[0].Status != "ok" || res.Processed != 1 {
		t.Fatalf("first: %+v processed=%d", res.Results[0], res.Processed)
	}
	if len(res.Results) != 4 {
		t.Fatalf("results %d", len(res.Results))
	}
	for i, k := range []string{"b", "c", "d"} {
		assertDeferred(t, res.Results[i+1], k)
	}
}

func TestBudgetFirstItemAlwaysRuns(t *testing.T) {
	clk := &fakeClock{t: time.Unix(0, 0), step: time.Hour}
	res, called, _ := runBudget(t, context.Background(), budgetItems("sale", "sale"), time.Nanosecond, clk)
	if len(called) != 1 || called[0] != "a" || res.Results[0].Status != "ok" {
		t.Fatalf("called=%v first=%+v", called, res.Results[0])
	}
	assertDeferred(t, res.Results[1], "b")
}

func TestBudgetDeferredBatchStillReturnsVersion(t *testing.T) {
	clk := &fakeClock{t: time.Unix(0, 0), step: time.Hour}
	res, _, versionCalls := runBudget(t, context.Background(), budgetItems("sale", "sale"), time.Second, clk)
	if res.Version != 7 || versionCalls != 1 {
		t.Fatalf("version=%d calls=%d", res.Version, versionCalls)
	}
}

func TestBudgetShiftCloseAfterDeferredItemIsHeld(t *testing.T) {
	clk := &fakeClock{t: time.Unix(0, 0), step: time.Hour}
	res, called, _ := runBudget(t, context.Background(), budgetItems("sale", "sale", "shift_close"), time.Second, clk)
	if len(called) != 1 {
		t.Fatalf("called=%v", called)
	}
	got := res.Results[2]
	if got.Status != "error" || got.Code != "busy" || got.Retryable == nil || !*got.Retryable {
		t.Fatalf("close after a deferred item must be held: %+v", got)
	}
}

func TestBudgetKeepsExistingCloseHoldWhenBudgetNotExpired(t *testing.T) {
	clk := &fakeClock{t: time.Unix(0, 0), step: time.Millisecond}
	var called []string
	res, err := processBatchBudget(context.Background(), Caller{OutletID: "o"}, budgetItems("refund", "shift_close"),
		func(_ context.Context, _ Caller, it BatchItem) ItemResult {
			called = append(called, it.IdempotencyKey)
			return retryableResult(it.IdempotencyKey)
		},
		func(context.Context, string) (VersionInfo, error) { return VersionInfo{}, nil },
		time.Minute, clk.now)
	if err != nil {
		t.Fatal(err)
	}
	if len(called) != 1 || res.Results[1].Error != closeHeldMessage {
		t.Fatalf("called=%v close=%+v", called, res.Results[1])
	}
}

func TestBudgetPreservesResultOrder(t *testing.T) {
	clk := &fakeClock{t: time.Unix(0, 0), step: 6 * time.Second}
	res, _, _ := runBudget(t, context.Background(), budgetItems("sale", "refund", "sale", "shift_close"), 10*time.Second, clk)
	for i, k := range []string{"a", "b", "c", "d"} {
		if res.Results[i].IdempotencyKey != k {
			t.Fatalf("result %d is %q want %q", i, res.Results[i].IdempotencyKey, k)
		}
	}
}

func TestBudgetZeroMeansDefault(t *testing.T) {
	if DefaultWorkBudget != 20*time.Second {
		t.Fatalf("default %v", DefaultWorkBudget)
	}
	e := &Engine{}
	if e.workBudget() != DefaultWorkBudget {
		t.Fatalf("zero WorkBudget must mean the default, got %v", e.workBudget())
	}
	e.WorkBudget = 3 * time.Second
	if e.workBudget() != 3*time.Second {
		t.Fatalf("got %v", e.workBudget())
	}
	// Budget 0 passed to processBatchBudget also means the default: a 9 s spend per read stays under 20 s for item b.
	clk := &fakeClock{t: time.Unix(0, 0), step: 9 * time.Second}
	_, called, _ := runBudget(t, context.Background(), budgetItems("sale", "sale"), 0, clk)
	if len(called) != 2 {
		t.Fatalf("9 s and 18 s are under the default 20 s, both must run: %v", called)
	}
}

func TestBudgetDefersRemainingItemsOnceContextIsDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var called []string
	clk := &fakeClock{t: time.Unix(0, 0), step: time.Millisecond}
	res, err := processBatchBudget(ctx, Caller{OutletID: "o"}, budgetItems("sale", "sale", "sale"),
		func(_ context.Context, _ Caller, it BatchItem) ItemResult {
			called = append(called, it.IdempotencyKey)
			cancel() // the batch deadline fires during the first item
			return ItemResult{IdempotencyKey: it.IdempotencyKey, Status: "ok"}
		},
		func(vctx context.Context, _ string) (VersionInfo, error) {
			if vctx.Err() != nil {
				t.Errorf("version must run on a fresh context, got %v", vctx.Err())
			}
			return VersionInfo{Version: 9}, nil
		}, time.Minute, clk.now)
	if err != nil {
		t.Fatal(err)
	}
	if len(called) != 1 {
		t.Fatalf("called=%v", called)
	}
	assertDeferred(t, res.Results[1], "b")
	assertDeferred(t, res.Results[2], "c")
	if res.Version != 9 {
		t.Fatalf("version %d", res.Version)
	}
}

// D: a batch whose server deadline fires mid-way is still a normal result (the HTTP
// layer answers 200): earlier items ok, later items busy/retryable, never an error return.
func TestBatchDeadlineMidWayReturnsPerItemResultsNotAnError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	clk := &fakeClock{t: time.Unix(0, 0), step: time.Millisecond}
	res, err := processBatchBudget(ctx, Caller{OutletID: "o"}, budgetItems("sale", "sale", "sale"),
		func(c context.Context, _ Caller, it BatchItem) ItemResult {
			if it.IdempotencyKey == "a" {
				return ItemResult{IdempotencyKey: "a", Status: "ok"}
			}
			<-c.Done() // the second item is the one in flight when the deadline fires
			return retryableResult(it.IdempotencyKey)
		},
		func(context.Context, string) (VersionInfo, error) { return VersionInfo{Version: 1}, nil },
		time.Minute, clk.now)
	if err != nil {
		t.Fatalf("a deadline mid-batch must not fail the whole batch: %v", err)
	}
	if res.Results[0].Status != "ok" {
		t.Fatalf("earlier item: %+v", res.Results[0])
	}
	for _, r := range res.Results[1:] {
		if r.Status != "error" || r.Retryable == nil || !*r.Retryable {
			t.Fatalf("later items must be retryable errors: %+v", r)
		}
	}
	assertDeferred(t, res.Results[2], "c")
}

// A near request deadline shrinks the budget: deadline headroom+2 s out -> 2 s budget,
// so with 1 s per clock read the third item is deferred even though WorkBudget is 20 s.
func TestBudgetShrinksToNearRequestDeadline(t *testing.T) {
	clk := &fakeClock{t: time.Now(), step: time.Second}
	ctx, cancel := context.WithDeadline(context.Background(), clk.t.Add(deadlineHeadroom+2*time.Second))
	defer cancel()
	res, called, _ := runBudget(t, ctx, budgetItems("sale", "sale", "sale", "sale"), 20*time.Second, clk)
	if len(called) != 2 {
		t.Fatalf("budget must shrink to deadline - headroom (2 s): called=%v", called)
	}
	assertDeferred(t, res.Results[2], "c")
}

func TestEffectiveBudget(t *testing.T) {
	start := time.Unix(0, 0)
	if got := effectiveBudget(20*time.Second, start, time.Time{}, false); got != 20*time.Second {
		t.Fatalf("no deadline: %v", got)
	}
	if got := effectiveBudget(20*time.Second, start, start.Add(28*time.Second), true); got != 20*time.Second {
		t.Fatalf("far deadline keeps the budget: %v", got)
	}
	if got := effectiveBudget(20*time.Second, start, start.Add(10*time.Second), true); got != 10*time.Second-deadlineHeadroom {
		t.Fatalf("near deadline: %v", got)
	}
	if got := effectiveBudget(20*time.Second, start, start.Add(time.Second), true); got <= 0 {
		t.Fatalf("budget must stay positive: %v", got)
	}
	if versionReadTimeout > 2*time.Second || deadlineHeadroom < versionReadTimeout {
		t.Fatalf("version %v headroom %v", versionReadTimeout, deadlineHeadroom)
	}
}

// ProcessBatch itself must apply Engine.WorkBudget (reverting it to the default-budget
// wrapper would let every item run).
func TestEngineProcessBatchAppliesWorkBudget(t *testing.T) {
	var called []string
	e := &Engine{
		WorkBudget: time.Nanosecond,
		testProcess: func(_ context.Context, _ Caller, it BatchItem) ItemResult {
			called = append(called, it.IdempotencyKey)
			time.Sleep(3 * time.Millisecond)
			return ItemResult{IdempotencyKey: it.IdempotencyKey, Status: "ok"}
		},
		testVersion: func(context.Context, string) (VersionInfo, error) { return VersionInfo{Version: 4}, nil },
	}
	res, err := e.ProcessBatch(context.Background(), Caller{OutletID: "o"}, budgetItems("sale", "sale", "sale"))
	if err != nil {
		t.Fatal(err)
	}
	if len(called) != 1 || res.Version != 4 {
		t.Fatalf("called=%v version=%d", called, res.Version)
	}
	assertDeferred(t, res.Results[1], "b")
}
