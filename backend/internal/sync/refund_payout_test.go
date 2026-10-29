package sync

import (
	"encoding/json"
	"testing"
)

func TestRefundPayloadPayoutMethod(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       *string
	}{
		{"absent", `{"orderId":"x"}`, nil},
		{"null", `{"payoutMethod":null}`, nil},
		{"string", `{"payoutMethod":"qris"}`, strp("qris")},
		{"blank stays blank for the service to reject", `{"payoutMethod":""}`, strp("")},
		{"non-string becomes blank", `{"payoutMethod":5}`, strp("")},
		{"display-only paymentMethod is ignored", `{"paymentMethod":"cash"}`, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var p refundPayload
			if err := json.Unmarshal([]byte(tc.body), &p); err != nil {
				t.Fatal(err)
			}
			got := p.input(Caller{}, "o").PayoutMethod
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func strp(s string) *string { return &s }
