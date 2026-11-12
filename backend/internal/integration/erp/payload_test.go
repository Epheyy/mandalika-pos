package erp

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

var (
	t0      = time.Date(2026, 11, 1, 20, 15, 20, 0, time.UTC)
	created = time.Date(2026, 11, 1, 20, 15, 41, 0, time.UTC)
)

func header(kind string) OutboxHeader {
	return OutboxHeader{
		ID: "o1", DocumentID: "d1", Kind: kind, LocationType: "outlet", LocationID: "loc1",
		RefType: "order", RefID: "ref1", RefNumber: "KMG-1", Part: 0, PartCount: 1, CreatedAt: created,
	}
}

func movement(id string, qty int) MovementRow {
	return MovementRow{
		ID: id, ProductID: "p-" + id, VariantSize: "50ml", Qty: qty, QtyBefore: 10, QtyAfter: 10 + qty,
		OccurredAt: t0, Actor: "kasir-01", DeviceID: "tab-07", FgCode: "FG-" + id, RefLine: "item-" + id,
	}
}

func input(kind string, ms ...MovementRow) BuildInput {
	return BuildInput{Header: header(kind), LocationCode: "KMG", LocationSlug: "kemang", Movements: ms, Brand: "mandalika"}
}

func mustBuild(t *testing.T, in BuildInput) StockDocument {
	t.Helper()
	doc, hold, err := BuildDocument(in)
	if err != nil || hold != "" {
		t.Fatalf("BuildDocument: hold=%q err=%v", hold, err)
	}
	return doc
}

func TestBuildDocumentEveryKind(t *testing.T) {
	for kind := range knownKinds {
		t.Run(kind, func(t *testing.T) {
			doc := mustBuild(t, input(kind, movement("a", -1)))
			if doc.Kind != kind || doc.Lines[0].Reason != kind {
				t.Errorf("kind/reason = %s/%s, want %s", doc.Kind, doc.Lines[0].Reason, kind)
			}
			if doc.Source.System != "pos" || doc.Source.Brand != "mandalika" ||
				doc.Source.DeviceID != "tab-07" || doc.Source.Actor != "kasir-01" {
				t.Errorf("source = %+v", doc.Source)
			}
			if doc.OccurredAt != "2026-11-01T20:15:20Z" || doc.RecordedAt != "2026-11-01T20:15:41Z" {
				t.Errorf("timestamps = %s / %s", doc.OccurredAt, doc.RecordedAt)
			}
			if doc.Location != (DocumentLocation{Type: "outlet", Code: "KMG", Slug: "kemang"}) ||
				doc.Ref.ID != "ref1" || doc.Ref.Number != "KMG-1" {
				t.Errorf("location/ref = %+v / %+v", doc.Location, doc.Ref)
			}
			if doc.Lines[0].Flags == nil {
				t.Error("flags must never be nil")
			}
		})
	}
}

func TestBuildDocumentSaleCarriesPriceAndTender(t *testing.T) {
	in := input("sale", movement("a", -1))
	in.Order = &OrderInfo{PaymentMethod: "qris", Total: 150000, LinePrice: map[string]int64{"item-a": 150000}}
	doc := mustBuild(t, in)
	if doc.Lines[0].UnitPrice == nil || *doc.Lines[0].UnitPrice != 150000 {
		t.Errorf("unit_price = %v", doc.Lines[0].UnitPrice)
	}
	if len(doc.Tenders) != 1 || doc.Tenders[0] != (Tender{Method: "qris", Amount: 150000}) {
		t.Errorf("tenders = %+v", doc.Tenders)
	}
}

func TestBuildDocumentRefundLinksOriginalAndNegatesTender(t *testing.T) {
	m := movement("a", 1)
	m.RefundOfMovementID = "orig-1"
	in := input("refund", m)
	in.Order = &OrderInfo{PaymentMethod: "cash", Total: 90000, LinePrice: map[string]int64{}}
	doc := mustBuild(t, in)
	if doc.Lines[0].RefundOfMovementID != "orig-1" {
		t.Errorf("refund_of_movement_id = %q", doc.Lines[0].RefundOfMovementID)
	}
	if len(doc.Tenders) != 1 || doc.Tenders[0].Amount != -90000 {
		t.Errorf("tenders = %+v", doc.Tenders)
	}
	if doc.Lines[0].UnitPrice != nil {
		t.Error("unit_price must be omitted when the line has no price")
	}
}

// C4a: a part refund's tender is the refund row's amount, not the order total.
func TestBuildDocumentRefundTenderUsesRefundRowAmount(t *testing.T) {
	m := movement("a", 1)
	in := input("refund", m)
	amt := int64(25000)
	in.Order = &OrderInfo{PaymentMethod: "cash", Total: 90000, LinePrice: map[string]int64{}, RefundAmount: &amt}
	doc := mustBuild(t, in)
	if len(doc.Tenders) != 1 || doc.Tenders[0] != (Tender{Method: "cash", Amount: -25000}) {
		t.Errorf("tenders = %+v, want -25000", doc.Tenders)
	}
	if doc.Lines[0].Qty != 1 {
		t.Errorf("line qty = %d, want the refunded quantity 1", doc.Lines[0].Qty)
	}
}

func TestBuildDocumentTransferPairing(t *testing.T) {
	out := input("transfer_out", movement("a", -10))
	out.Header.RefType, out.Header.RefID, out.Header.DocumentID = "transfer", "tr-1", "d-out"
	out.Header.LocationID, out.LocationCode, out.LocationSlug = "loc2", "SNY", "senayan"

	m := movement("b", 9)
	m.Flags = []string{"variance", "sent:10"}
	in := input("transfer_in", m)
	in.Header.RefType, in.Header.RefID, in.Header.DocumentID = "transfer", "tr-1", "d-in"

	a, b := mustBuild(t, out), mustBuild(t, in)
	if a.Ref.ID != b.Ref.ID || a.DocumentID == b.DocumentID || a.Location.Code == b.Location.Code {
		t.Errorf("pairing broken: %+v / %+v", a, b)
	}
	if got := b.Lines[0].ExpectedQty; got == nil || *got != 10 {
		t.Errorf("expected_qty = %v, want 10", got)
	}
	if fmt.Sprint(b.Lines[0].Flags) != "[variance]" {
		t.Errorf("flags = %v, want [variance] (sent: stripped)", b.Lines[0].Flags)
	}
	if a.Lines[0].ExpectedQty != nil {
		t.Error("only transfer_in carries expected_qty")
	}
}

func TestBuildDocumentTransferInExpectedQtyDefaultsToQty(t *testing.T) {
	doc := mustBuild(t, input("transfer_in", movement("a", 7)))
	if got := doc.Lines[0].ExpectedQty; got == nil || *got != 7 {
		t.Errorf("expected_qty = %v, want 7", got)
	}
}

func TestBuildDocumentKeepsShortageFlag(t *testing.T) {
	m := movement("a", -2)
	m.Flags = []string{"shortage"}
	doc := mustBuild(t, input("sale", m))
	if fmt.Sprint(doc.Lines[0].Flags) != "[shortage]" {
		t.Errorf("flags = %v", doc.Lines[0].Flags)
	}
}

func TestBuildDocumentParts(t *testing.T) {
	order := &OrderInfo{PaymentMethod: "cash", Total: 100, LinePrice: map[string]int64{}}

	in := input("sale", movement("a", -1))
	in.Header.Part, in.Header.PartCount, in.Order = 2, 3, order
	doc := mustBuild(t, in)
	if doc.Part == nil || *doc.Part != (DocumentPart{Index: 2, Count: 3}) {
		t.Errorf("part = %+v", doc.Part)
	}
	if len(doc.Tenders) != 0 {
		t.Errorf("part 2 must carry no tenders, got %+v", doc.Tenders)
	}

	in.Header.Part = 1
	if doc := mustBuild(t, in); len(doc.Tenders) != 1 {
		t.Errorf("part 1 must carry the tender, got %+v", doc.Tenders)
	}

	in.Header.Part, in.Header.PartCount = 0, 1
	out, _ := json.Marshal(mustBuild(t, in))
	if strings.Contains(string(out), `"part"`) {
		t.Errorf("unsplit document must have no part key: %s", out)
	}
}

func TestBuildDocumentCustomPaymentMethodHasNoTender(t *testing.T) {
	in := input("sale", movement("a", -1))
	in.Order = &OrderInfo{PaymentMethod: "bca", Total: 100, LinePrice: map[string]int64{}}
	if doc := mustBuild(t, in); len(doc.Tenders) != 0 {
		t.Errorf("tenders = %+v, want none", doc.Tenders)
	}
}

func TestBuildDocumentHoldReasons(t *testing.T) {
	t.Run("outlet without an ERP code", func(t *testing.T) {
		in := input("sale", movement("a", -1))
		in.LocationCode = "" // a linked slug alone is not enough: the ERP keys on the code
		_, hold, err := BuildDocument(in)
		if err != nil || hold != "outlet loc1 belum terhubung ke ERP (erp_code kosong)" {
			t.Errorf("hold=%q err=%v", hold, err)
		}
	})
	t.Run("warehouse is held even when mapped", func(t *testing.T) {
		for _, kind := range []string{"receipt", "transfer_out", "adjust"} {
			in := input(kind, movement("a", -1))
			in.Header.LocationType, in.Header.LocationID = "warehouse", "w1"
			_, hold, err := BuildDocument(in)
			if err != nil || hold != "gudang w1: ERP belum menerima dokumen gudang (hanya outlet)" {
				t.Errorf("%s: hold=%q err=%v", kind, hold, err)
			}
		}
	})
	t.Run("location is checked before variants", func(t *testing.T) {
		m := movement("a", -1)
		m.FgCode = ""
		in := input("sale", m)
		in.LocationCode = ""
		if _, hold, _ := BuildDocument(in); !strings.HasPrefix(hold, "outlet loc1 ") {
			t.Errorf("hold = %q", hold)
		}
	})
	t.Run("variants", func(t *testing.T) {
		m := movement("a", -1)
		m.FgCode = ""
		_, hold, err := BuildDocument(input("sale", m, m))
		if err != nil || hold != "varian belum dipetakan ke ERP: p-a 50ml" {
			t.Errorf("hold=%q err=%v (duplicates must be listed once)", hold, err)
		}
	})
	t.Run("more than five variants", func(t *testing.T) {
		var ms []MovementRow
		for i := 0; i < 8; i++ {
			m := movement(fmt.Sprint(i), -1)
			m.FgCode = ""
			ms = append(ms, m)
		}
		_, hold, _ := BuildDocument(input("sale", ms...))
		if !strings.HasSuffix(hold, ", +3 lainnya") || strings.Count(hold, "50ml") != 5 {
			t.Errorf("hold = %q", hold)
		}
	})
}

func TestBuildDocumentLocationCarriesCodeAndOptionalSlug(t *testing.T) {
	in := input("sale", movement("a", -1))
	in.LocationSlug = "" // the slug is a deprecated extra: a missing one never holds the document
	body, err := json.Marshal(mustBuild(t, in))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"location":{"type":"outlet","code":"KMG"}`) {
		t.Errorf("location = %s, want code only", body)
	}
	body, _ = json.Marshal(mustBuild(t, input("sale", movement("a", -1))))
	if !strings.Contains(string(body), `"location":{"type":"outlet","code":"KMG","slug":"kemang"}`) {
		t.Errorf("location = %s, want code and slug", body)
	}
}

func TestBuildDocumentErrors(t *testing.T) {
	if _, _, err := BuildDocument(input("sale")); !errors.Is(err, ErrNoMovements) {
		t.Errorf("err = %v, want ErrNoMovements", err)
	}
	if _, _, err := BuildDocument(input("bogus", movement("a", 1))); !errors.Is(err, ErrUnknownKind) {
		t.Errorf("err = %v, want ErrUnknownKind", err)
	}
}

func TestBuildDocumentGiveawayLineIsZeroPricedSaleLineWithoutFlag(t *testing.T) {
	sold := movement("a", -1)
	give := movement("b", -1)
	give.RefLine = ""
	give.DedupeKey = "giveaway:ord1"
	in := input("sale", sold, give)
	in.Order = &OrderInfo{PaymentMethod: "cash", Total: 150000, LinePrice: map[string]int64{"item-a": 150000}}
	doc := mustBuild(t, in)
	if doc.Lines[0].UnitPrice == nil || *doc.Lines[0].UnitPrice != 150000 {
		t.Errorf("sold line price = %v", doc.Lines[0].UnitPrice)
	}
	g := doc.Lines[1]
	if g.UnitPrice == nil || *g.UnitPrice != 0 {
		t.Errorf("giveaway unit_price = %v, want 0", g.UnitPrice)
	}
	if g.Reason != "sale" || len(g.Flags) != 0 {
		t.Errorf("giveaway reason=%q flags=%v, want sale and no flags", g.Reason, g.Flags)
	}
	// still Rp0 when the order row is gone, and a shortage flag is kept as stored
	give.Flags = []string{"shortage"}
	doc = mustBuild(t, input("sale", give))
	if doc.Lines[0].UnitPrice == nil || *doc.Lines[0].UnitPrice != 0 || fmt.Sprint(doc.Lines[0].Flags) != "[shortage]" {
		t.Errorf("no-order giveaway line = %+v", doc.Lines[0])
	}
}

func TestBuildDocumentGiveawayKeyOnlyAffectsSaleKind(t *testing.T) {
	m := movement("a", -1)
	m.DedupeKey = "giveaway:ord1"
	in := input("refund", m)
	in.Order = &OrderInfo{PaymentMethod: "cash", Total: 1, LinePrice: map[string]int64{"item-a": 5}}
	if p := mustBuild(t, in).Lines[0].UnitPrice; p == nil || *p != 5 {
		t.Errorf("refund price = %v, want the order price", p)
	}
}

// C4a: only the legacy whole-order key may fall back to the order total; a per-refund key
// without its row must error (retryable) instead of freezing a wrong tender.
func TestLegacyRefundKeyOnlyForWholeOrderKey(t *testing.T) {
	if !legacyRefundKey("refund:ord-1", "ord-1") {
		t.Error("refund:<orderId> is the legacy key")
	}
	if legacyRefundKey("refund:7f3e-refund-id", "ord-1") || legacyRefundKey("", "ord-1") {
		t.Error("a per-refund or empty key must not fall back to the order total")
	}
	if !errors.Is(fmt.Errorf("%w: x", ErrRefundRowMissing), ErrRefundRowMissing) {
		t.Error("ErrRefundRowMissing must be wrappable")
	}
}

// A bundle is three ordinary sale lines whose order line prices are the pieces' shares. The ERP
// payload needs no bundle logic: the three unit prices add up to the bundle net and none is 0.
func TestBuildDocumentBundlePiecesSumToBundleNet(t *testing.T) {
	large, atomizer, vial := movement("L", -1), movement("A", -1), movement("V", -1)
	in := input("sale", large, atomizer, vial)
	in.Order = &OrderInfo{PaymentMethod: "cash", Total: 850000, LinePrice: map[string]int64{
		"item-L": 675498, "item-A": 140728, "item-V": 33774,
	}}
	doc := mustBuild(t, in)
	if len(doc.Lines) != 3 {
		t.Fatalf("lines = %d, want 3", len(doc.Lines))
	}
	var sum int64
	for _, l := range doc.Lines {
		if l.Qty != 1 && l.Qty != -1 {
			t.Errorf("line qty = %d", l.Qty)
		}
		if l.UnitPrice == nil || *l.UnitPrice <= 0 {
			t.Fatalf("a bundle piece reached the ERP at no price: %+v", l)
		}
		sum += *l.UnitPrice
	}
	if sum != 850000 {
		t.Fatalf("unit prices add up to %d, want 850000", sum)
	}
}
