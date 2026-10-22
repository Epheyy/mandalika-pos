package erp

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The literals below are the Sale and CountPart examples of
// docs/integration/stock-documents.v1.yaml, minus fields the POS never emits
// (discount, customer_ref) and with the always-emitted ones the yaml omits
// (flags, recorded_at on CountPart) filled in.
const saleExample = `{
 "document_id": "d0000000-0000-4000-8000-000000000002", "kind": "sale",
 "source": {"system": "pos", "brand": "mandalika", "device_id": "tab-07", "actor": "kasir-01"},
 "location": {"type": "outlet", "slug": "kemang"},
 "occurred_at": "2026-11-02T03:15:20+07:00", "recorded_at": "2026-11-01T20:15:41Z",
 "ref": {"type": "order", "id": "5b1f0c2e-9a77-4d3e-8f10-2c6a1e9b0a01", "number": "KMG-AB0004"},
 "lines": [{"movement_id": "b0000000-0000-4000-8000-000000000002", "fg_code": "FG-001",
   "qty": -1, "qty_before": 42, "qty_after": 41, "unit_price": 150000, "reason": "sale", "flags": []}],
 "tenders": [{"method": "qris", "amount": 150000}]}`

const countPartExample = `{
 "document_id": "d0000000-0000-4000-8000-000000000032", "kind": "count",
 "part": {"index": 2, "count": 3},
 "source": {"system": "pos", "brand": "mandalika"},
 "location": {"type": "outlet", "slug": "kemang"},
 "occurred_at": "2026-11-01T21:00:00+07:00", "recorded_at": "2026-11-01T14:00:05Z",
 "ref": {"type": "stock_count", "id": "7c3a9e10-2b44-4f6d-9e21-0d5b8a6f3c02", "number": "SO-2026-11-01"},
 "lines": [{"movement_id": "b0000000-0000-4000-8000-000000000201", "fg_code": "FG-001",
   "qty": -2, "qty_before": 50, "qty_after": 48, "reason": "count", "flags": []}]}`

func TestStockDocumentContractExamplesRoundTrip(t *testing.T) {
	for name, src := range map[string]string{"sale": saleExample, "countPart": countPartExample} {
		var doc StockDocument
		if err := json.Unmarshal([]byte(src), &doc); err != nil {
			t.Fatalf("%s: unmarshal: %v", name, err)
		}
		out, err := json.Marshal(doc)
		if err != nil {
			t.Fatalf("%s: marshal: %v", name, err)
		}
		var want, got map[string]any
		_ = json.Unmarshal([]byte(src), &want)
		_ = json.Unmarshal(out, &got)
		if !reflect.DeepEqual(want, got) {
			t.Errorf("%s: round trip differs\nwant %v\n got %v", name, want, got)
		}
	}
}

func TestStockDocumentEmitsEmptyFlagsAndOmitsNilPart(t *testing.T) {
	doc := StockDocument{Lines: []StockLine{{Flags: []string{}}}}
	out, _ := json.Marshal(doc)
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if _, ok := m["part"]; ok {
		t.Error("part must be omitted when nil")
	}
	line := m["lines"].([]any)[0].(map[string]any)
	if flags, ok := line["flags"].([]any); !ok || len(flags) != 0 {
		t.Errorf("flags = %v, want []", line["flags"])
	}
	for _, k := range []string{"qty", "qty_before", "qty_after"} {
		if _, ok := line[k]; !ok {
			t.Errorf("%s must always be emitted", k)
		}
	}
}
