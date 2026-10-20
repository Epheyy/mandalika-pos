package sync

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/mandalika/pos-backend/internal/service"
)

// A15 Phase B: the stock counter on the wire. Per item it rides ONLY on a fresh,
// successful order whose attributed outlet is the batch caller's outlet; a duplicate,
// a refund, an error or an order attributed elsewhere carries none.

func i64(n int64) *int64 { return &n }

func sellOne(seq *int64, dup bool) func(context.Context, service.CreateOrderInput) (service.CreateOrderResult, error) {
	return func(context.Context, service.CreateOrderInput) (service.CreateOrderResult, error) {
		return service.CreateOrderResult{OrderID: "order-1", Duplicate: dup, StockSeq: seq}, nil
	}
}

func flush(t *testing.T, e *Engine, c Caller, it BatchItem, create func(context.Context, service.CreateOrderInput) (service.CreateOrderResult, error)) BatchResult {
	t.Helper()
	res, err := processBatch(context.Background(), c, []BatchItem{it},
		func(ctx context.Context, c Caller, it BatchItem) ItemResult {
			return e.processOneWithSeq(ctx, c, it,
				func(context.Context, pgx.Tx, service.RefundInput) error { return nil }, create)
		},
		func(context.Context, string) (VersionInfo, error) {
			return VersionInfo{Version: 3, StockSeq: i64(9)}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func legacyOrder(key string) BatchItem {
	return BatchItem{Type: "order", IdempotencyKey: key, Payload: json.RawMessage(`{"paymentMethod":"cash","amountPaid":100,"items":[{"price":100,"quantity":1,"subtotal":100}]}`)}
}

func TestOrderItemCarriesItsOwnStockSeqAndBatchCarriesTheCurrentOne(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{}}
	res := flush(t, e, Caller{OutletID: "o", UserID: "u1"}, legacyOrder("k1"), sellOne(i64(7), false))
	r := res.Results[0]
	if r.Status != "ok" || r.StockSeq == nil || *r.StockSeq != 7 {
		t.Fatalf("item %+v", r)
	}
	if res.StockSeq == nil || *res.StockSeq != 9 {
		t.Fatalf("batch seq %v, want the Version() read (9), not the item's", res.StockSeq)
	}
}

func TestDuplicateOrderCarriesNoStockSeq(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{}}
	// even if a seam wrongly returned a seq with a duplicate, none may reach the wire
	res := flush(t, e, Caller{OutletID: "o", UserID: "u1"}, legacyOrder("k1"), sellOne(i64(7), true))
	if r := res.Results[0]; r.Status != "duplicate" || r.StockSeq != nil {
		t.Fatalf("duplicate must carry no seq: %+v", r)
	}
}

func TestOrderAttributedToAnotherOutletCarriesNoStockSeq(t *testing.T) {
	// enveloped item: attributed to the envelope outlet X (the user's home outlet) while
	// the request's active outlet is "header-outlet": the seq counts X's stock, which the
	// caller's outlet counter cannot explain, so it must not be sent per item.
	e := &Engine{Lookup: &fakeLookup{shifts: map[string]shiftState{}}}
	it := legacyOrder("dev:1")
	it.Envelope = env(nil)
	res := flush(t, e, cashier(), it, sellOne(i64(7), false))
	if r := res.Results[0]; r.Status != "ok" || r.StockSeq != nil {
		t.Fatalf("other-outlet item must carry no seq: %+v", r)
	}
	// same shape, attributed to the caller's own outlet: kept
	c := cashier()
	c.OutletID = "X"
	res = flush(t, e, c, it, sellOne(i64(7), false))
	if r := res.Results[0]; r.StockSeq == nil || *r.StockSeq != 7 {
		t.Fatalf("own-outlet item must carry its seq: %+v", r)
	}
}

func TestOnlyFreshOrdersCarryAnItemStockSeq(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{}}
	c := Caller{OutletID: "o", UserID: "u1", CanRefund: true}
	refund := BatchItem{Type: "refund", IdempotencyKey: "r1", Payload: json.RawMessage(`{"orderId":"o1","reason":"x"}`)}
	if r := flush(t, e, c, refund, sellOne(i64(7), false)).Results[0]; r.StockSeq != nil {
		t.Fatalf("a refund item carries no per-item seq: %+v", r)
	}
	failing := func(context.Context, service.CreateOrderInput) (service.CreateOrderResult, error) {
		return service.CreateOrderResult{}, errors.New("boom")
	}
	if r := flush(t, e, c, legacyOrder("k2"), failing).Results[0]; r.Status != "error" || r.StockSeq != nil {
		t.Fatalf("an error item carries no seq: %+v", r)
	}
}

func TestKillSwitchOmitsEveryItemStockSeq(t *testing.T) {
	e := &Engine{Lookup: &fakeLookup{}, StockSeqOff: true}
	r := flush(t, e, Caller{OutletID: "o", UserID: "u1"}, legacyOrder("k1"), sellOne(i64(7), false)).Results[0]
	if r.Status != "ok" || r.StockSeq != nil {
		t.Fatalf("SYNC_STOCK_SEQ=off must omit the item seq: %+v", r)
	}
}

// A zero counter is a real value (a never-bumped outlet) and must survive omitempty,
// which is why the field is a pointer; nil must vanish from the wire.
func TestStockSeqZeroSurvivesJSONAndNilIsOmitted(t *testing.T) {
	for name, v := range map[string]any{
		"item":    ItemResult{IdempotencyKey: "k", Status: "ok", StockSeq: i64(0)},
		"batch":   BatchResult{Results: []ItemResult{}, StockSeq: i64(0)},
		"version": VersionInfo{Version: 1, StockSeq: i64(0)},
		"pull":    PullBundle{Version: 1, StockSeq: i64(0)},
	} {
		raw, _ := json.Marshal(v)
		if !strings.Contains(string(raw), `"stockSeq":0`) {
			t.Errorf("%s: zero lost: %s", name, raw)
		}
	}
	for name, v := range map[string]any{
		"item":    ItemResult{IdempotencyKey: "k", Status: "ok"},
		"batch":   BatchResult{Results: []ItemResult{}},
		"version": VersionInfo{Version: 1},
		"pull":    PullBundle{Version: 1},
	} {
		raw, _ := json.Marshal(v)
		if strings.Contains(string(raw), "stockSeq") {
			t.Errorf("%s: nil must be omitted: %s", name, raw)
		}
	}
}
