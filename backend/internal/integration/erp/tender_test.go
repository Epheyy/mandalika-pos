package erp

import (
	"testing"

	oanull "github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/rules"
)

func TestErpTenderMethod(t *testing.T) {
	flag := func(id string, v bool) api.PaymentMethodConfig {
		return api.PaymentMethodConfig{Id: id, IsCash: oanull.NewNullableWithValue(v)}
	}
	cases := []struct {
		name    string
		methods []api.PaymentMethodConfig
		id      string
		want    string
	}{
		{"tunai is cash", nil, "tunai", "cash"},
		{"CASH is cash", nil, "CASH", "cash"},
		{"card as is", nil, "card", "card"},
		{"transfer as is", nil, "transfer", "transfer"},
		{"padded QRIS lowercased", nil, " QRIS ", "qris"},
		{"edc custom omitted", nil, "edc", ""},
		{"custom flagged cash goes out as cash", []api.PaymentMethodConfig{flag("kas_kecil", true)}, "kas_kecil", "cash"},
		// rules.IsCashMethod is followed literally: an explicit isCash=false beats the id
		// default, so "tunai" is no longer cash and is not a contract non-cash method: omitted.
		{"explicit isCash=false on tunai is omitted", []api.PaymentMethodConfig{flag("tunai", false)}, "tunai", ""},
		{"explicit isCash=false on qris stays qris", []api.PaymentMethodConfig{flag("qris", false)}, "qris", "qris"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := erpTenderMethod(c.id, rules.IsCashMethod(c.methods, c.id)); got != c.want {
				t.Fatalf("erpTenderMethod(%q) = %q, want %q", c.id, got, c.want)
			}
		})
	}
}

func saleOrder(total int64, lines ...OrderTender) *OrderInfo {
	return &OrderInfo{PaymentMethod: "split", Total: total, Tenders: lines, LinePrice: map[string]int64{}}
}

func TestBuildTendersSplitSale(t *testing.T) {
	in := input("sale", movement("a", -1))
	in.Order = saleOrder(150000, OrderTender{"qris", 100000}, OrderTender{"tunai", 50000})
	doc := mustBuild(t, in)
	want := []Tender{{Method: "qris", Amount: 100000}, {Method: "cash", Amount: 50000}}
	if len(doc.Tenders) != 2 || doc.Tenders[0] != want[0] || doc.Tenders[1] != want[1] {
		t.Fatalf("tenders = %+v, want %+v", doc.Tenders, want)
	}
}

func TestBuildTendersRemainderOnLastLineAndZeroDropped(t *testing.T) {
	in := input("sale", movement("a", -1))
	// Lines sum to 99999 against round(total)=100000; the zero line is dropped and the
	// last kept line absorbs the 1 rupiah remainder.
	in.Order = saleOrder(100000,
		OrderTender{"qris", 33333}, OrderTender{"card", 0}, OrderTender{"transfer", 33333}, OrderTender{"tunai", 33333})
	doc := mustBuild(t, in)
	var sum int64
	for _, tn := range doc.Tenders {
		sum += tn.Amount
	}
	if len(doc.Tenders) != 3 || sum != 100000 {
		t.Fatalf("tenders = %+v sum=%d, want 3 lines summing to 100000", doc.Tenders, sum)
	}
	if last := doc.Tenders[2]; last != (Tender{Method: "cash", Amount: 33334}) {
		t.Errorf("last = %+v, want cash 33334", last)
	}
}

func TestBuildTendersCustomLineOmitted(t *testing.T) {
	in := input("sale", movement("a", -1))
	in.Order = saleOrder(100, OrderTender{"bca", 40}, OrderTender{"qris", 60})
	doc := mustBuild(t, in)
	if len(doc.Tenders) != 1 || doc.Tenders[0] != (Tender{Method: "qris", Amount: 60}) {
		t.Errorf("tenders = %+v, want only qris 60", doc.Tenders)
	}
}

func TestBuildTendersLiveTunaiIsCash(t *testing.T) {
	in := input("sale", movement("a", -1))
	in.Order = &OrderInfo{PaymentMethod: "tunai", Total: 90000, LinePrice: map[string]int64{}}
	doc := mustBuild(t, in)
	if len(doc.Tenders) != 1 || doc.Tenders[0] != (Tender{Method: "cash", Amount: 90000}) {
		t.Errorf("tenders = %+v, want cash 90000", doc.Tenders)
	}
}

func TestBuildTendersRefundUsesPayoutMethod(t *testing.T) {
	in := input("refund", movement("a", 1))
	amt := int64(25000)
	in.Order = &OrderInfo{PaymentMethod: "split", Total: 90000, LinePrice: map[string]int64{},
		RefundAmount: &amt, RefundMethod: "tunai"}
	doc := mustBuild(t, in)
	if len(doc.Tenders) != 1 || doc.Tenders[0] != (Tender{Method: "cash", Amount: -25000}) {
		t.Errorf("tenders = %+v, want cash -25000", doc.Tenders)
	}
}

func TestBuildTendersPartTwoCarriesNone(t *testing.T) {
	in := input("sale", movement("a", -1))
	in.Header.Part, in.Header.PartCount = 2, 2
	in.Order = saleOrder(100, OrderTender{"qris", 100})
	if doc := mustBuild(t, in); len(doc.Tenders) != 0 {
		t.Errorf("part 2 tenders = %+v, want none", doc.Tenders)
	}
}
