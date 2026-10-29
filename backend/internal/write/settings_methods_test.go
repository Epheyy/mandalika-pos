package write

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidatePaymentMethodsRejectsReservedSplitID(t *testing.T) {
	for _, id := range []string{"split", "SPLIT", " Split "} {
		raw := json.RawMessage(`[{"id":"` + id + `","label":"Split","isEnabled":true}]`)
		err := validatePaymentMethods(raw)
		if err == nil {
			t.Fatalf("id %q: expected rejection", id)
		}
		if !strings.Contains(err.Error(), "dicadangkan") {
			t.Fatalf("id %q: unexpected message %q", id, err)
		}
	}
}

func TestValidatePaymentMethodsAcceptsOrdinaryIDs(t *testing.T) {
	raw := json.RawMessage(`[{"id":"tunai","label":"Tunai","isEnabled":true},{"id":"splitwise","label":"X","isEnabled":true}]`)
	if err := validatePaymentMethods(raw); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
