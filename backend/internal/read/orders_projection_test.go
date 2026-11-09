package read

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/api"
)

// F26: the order read projection carries when the tablet recorded the sale next to the
// server receive time, so no screen has to call created_at "the sale time".
func TestOrderProjectionCarriesClientCreatedAt(t *testing.T) {
	if !strings.Contains(orderObj, "'clientCreatedAt',o.client_created_at") {
		t.Fatal("orderObj must project o.client_created_at as clientCreatedAt")
	}
	if !strings.Contains(orderObj, "'createdAt',o.created_at") {
		t.Fatal("orderObj must keep createdAt (server receive time)")
	}
}

func TestOrderClientCreatedAtDecodesAndIsNullForOldRows(t *testing.T) {
	base := `{"id":"00000000-0000-4000-8000-000000000001","orderNumber":"A1","outletId":"00000000-0000-4000-8000-000000000002",` +
		`"cashierId":"c","cashierName":"C","items":[],"subtotal":1,"discountAmount":0,"taxAmount":0,"total":1,` +
		`"paymentMethod":"cash","amountPaid":1,"change":0,"status":"completed","createdAt":"2026-11-09T08:46:00Z"`
	var withClient, oldRow api.Order
	if err := json.Unmarshal([]byte(base+`,"clientCreatedAt":"2026-11-09T01:31:00Z"}`), &withClient); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(base+`,"clientCreatedAt":null}`), &oldRow); err != nil {
		t.Fatal(err)
	}
	got, err := withClient.ClientCreatedAt.Get()
	if err != nil || got.UTC().Format("2006-01-02T15:04:05Z") != "2026-11-09T01:31:00Z" {
		t.Fatalf("clientCreatedAt not decoded: %v %v", got, err)
	}
	if !oldRow.ClientCreatedAt.IsNull() {
		t.Fatal("a null client_created_at must decode as null")
	}
}
