package sync

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestShiftDecodeRejectsBeforeService(t *testing.T) {
	// A nil real OrderService would panic on mutation. The actual dispatch must
	// reject these before reaching it; no mutation mock substitutes the decoder.
	for _, op := range []string{"shift_open", "shift_close"} {
		for _, raw := range []string{`{`, `{}`, `null`, `[]`, `{"startingCash":null,"closingCash":null}`, `{"startingCash":0,"StartingCash":1,"closingCash":0,"ClosingCash":1}`, `{"startingCash":"0","closingCash":"0"}`, `{"startingCash":0,"closingCash":0} {}`} {
			item := BatchItem{Type: op, IdempotencyKey: "original-key", Payload: json.RawMessage(raw)}
			before := append([]byte(nil), item.Payload...)
			r := (&Engine{}).processOne(context.Background(), Caller{OutletID: "synthetic"}, item)
			if r.Status != "error" || r.IdempotencyKey != "original-key" || r.Error == "" || !reflect.DeepEqual(before, []byte(item.Payload)) {
				t.Fatalf("%+v", r)
			}
		}
	}
}
