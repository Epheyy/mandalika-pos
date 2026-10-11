package sync

import (
	"context"
	"testing"
)

func retryableResult(key string) ItemResult {
	f := true
	return ItemResult{IdempotencyKey: key, Status: "error", Code: "busy", Retryable: &f, Error: "busy"}
}

func permanentResult(key string) ItemResult {
	f := false
	return ItemResult{IdempotencyKey: key, Status: "error", Code: "rejected", Retryable: &f, Error: "no"}
}

// runHoldBatch runs processBatch with a scripted per-key outcome and reports which
// keys the process func was actually called for.
func runHoldBatch(t *testing.T, items []BatchItem, outcome map[string]ItemResult) (BatchResult, []string) {
	t.Helper()
	var called []string
	res, err := processBatch(context.Background(), Caller{OutletID: "o"}, items,
		func(_ context.Context, _ Caller, it BatchItem) ItemResult {
			called = append(called, it.IdempotencyKey)
			if r, ok := outcome[it.IdempotencyKey]; ok {
				return r
			}
			return ItemResult{IdempotencyKey: it.IdempotencyKey, Status: "ok"}
		},
		func(context.Context, string) (VersionInfo, error) { return VersionInfo{}, nil })
	if err != nil {
		t.Fatal(err)
	}
	return res, called
}

func TestShiftCloseHeldAfterEarlierRetryableFailure(t *testing.T) {
	items := []BatchItem{{Type: "refund", IdempotencyKey: "r1"}, {Type: "shift_close", IdempotencyKey: "c1"}}
	res, called := runHoldBatch(t, items, map[string]ItemResult{"r1": retryableResult("r1")})
	for _, k := range called {
		if k == "c1" {
			t.Fatalf("shift_close must not run: called=%v", called)
		}
	}
	got := res.Results[1]
	if got.IdempotencyKey != "c1" || got.Status != "error" || got.Retryable == nil || !*got.Retryable || got.Code != "busy" {
		t.Fatalf("held close must be a retryable busy error: %+v", got)
	}
	if got.Error != closeHeldMessage {
		t.Fatalf("message: %q", got.Error)
	}
	if res.Processed != 0 {
		t.Fatalf("processed=%d", res.Processed)
	}
}

func TestShiftCloseRunsAfterPermanentFailureOrSuccess(t *testing.T) {
	for name, first := range map[string]ItemResult{
		"permanent": permanentResult("r1"),
		"ok":        {IdempotencyKey: "r1", Status: "ok"},
		"duplicate": {IdempotencyKey: "r1", Status: "duplicate"},
	} {
		t.Run(name, func(t *testing.T) {
			items := []BatchItem{{Type: "refund", IdempotencyKey: "r1"}, {Type: "shift_close", IdempotencyKey: "c1"}}
			res, called := runHoldBatch(t, items, map[string]ItemResult{"r1": first})
			if len(called) != 2 || res.Results[1].Status != "ok" {
				t.Fatalf("close must run: called=%v res=%+v", called, res.Results)
			}
		})
	}
}

func TestOnlyShiftCloseIsHeldAndOnlyByEarlierItems(t *testing.T) {
	// A later retryable failure does not hold an earlier close; other types are never held.
	items := []BatchItem{
		{Type: "shift_close", IdempotencyKey: "c0"},
		{Type: "order", IdempotencyKey: "o1"},
		{Type: "order", IdempotencyKey: "o2"},
		{Type: "cash_flow", IdempotencyKey: "f1"},
	}
	res, called := runHoldBatch(t, items, map[string]ItemResult{"o1": retryableResult("o1")})
	if len(called) != 4 || res.Results[0].Status != "ok" || res.Results[2].Status != "ok" || res.Results[3].Status != "ok" {
		t.Fatalf("called=%v res=%+v", called, res.Results)
	}
}

func TestShiftOpenHeldWithCloseAfterEarlierRetryableFailure(t *testing.T) {
	items := []BatchItem{{Type: "refund", IdempotencyKey: "r1"}, {Type: "shift_close", IdempotencyKey: "c1"},
		{Type: "shift_open", IdempotencyKey: "n1"}, {Type: "order", IdempotencyKey: "o1"}}
	res, called := runHoldBatch(t, items, map[string]ItemResult{"r1": retryableResult("r1")})
	if len(called) != 2 || called[0] != "r1" || called[1] != "o1" {
		t.Fatalf("only the refund and the sale may run: called=%v", called)
	}
	for i, want := range map[int]string{1: closeHeldMessage, 2: openHeldMessage} {
		got := res.Results[i]
		if got.Status != "error" || got.Retryable == nil || !*got.Retryable || got.Code != "busy" || got.Error != want {
			t.Fatalf("item %d must be held: %+v", i, got)
		}
	}
	if res.Results[3].Status != "ok" {
		t.Fatalf("sales are never held: %+v", res.Results[3])
	}
}

func TestShiftOpenRunsWithoutEarlierRetryableFailure(t *testing.T) {
	items := []BatchItem{{Type: "refund", IdempotencyKey: "r1"}, {Type: "shift_open", IdempotencyKey: "n1"}}
	res, called := runHoldBatch(t, items, map[string]ItemResult{"r1": permanentResult("r1")})
	if len(called) != 2 || res.Results[1].Status != "ok" {
		t.Fatalf("open must run: called=%v res=%+v", called, res.Results)
	}
}
