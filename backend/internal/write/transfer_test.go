package write

import (
	"fmt"
	"testing"
)

func TestValidLocKind(t *testing.T) {
	for _, tt := range []struct {
		kind string
		want bool
	}{
		{"outlet", true}, {"warehouse", true}, {"", false}, {"shop", false},
	} {
		if got := validLocKind(tt.kind); got != tt.want {
			t.Fatalf("validLocKind(%q)=%v want %v", tt.kind, got, tt.want)
		}
	}
}

func TestSameLoc(t *testing.T) {
	a := TransferLoc{Kind: "outlet", ID: "1"}
	if !sameLoc(a, TransferLoc{Kind: "outlet", ID: "1"}) {
		t.Fatal("expected same")
	}
	if sameLoc(a, TransferLoc{Kind: "warehouse", ID: "1"}) {
		t.Fatal("different kind must not be same")
	}
	if sameLoc(a, TransferLoc{Kind: "outlet", ID: "2"}) {
		t.Fatal("different id must not be same")
	}
}

func TestTransferTransition(t *testing.T) {
	tests := []struct {
		from, action, want string
		wantErr            bool
	}{
		{"draft", "send", "in_transit", false},
		{"in_transit", "receive", "completed", false},
		{"draft", "cancel", "cancelled", false},
		{"in_transit", "cancel", "cancelled", false},
		{"completed", "cancel", "", true},
		{"cancelled", "send", "", true},
		{"in_transit", "send", "", true},
		{"draft", "receive", "", true},
		{"draft", "bogus", "", true},
	}
	for _, tt := range tests {
		got, err := transferTransition(tt.from, tt.action)
		if (err != nil) != tt.wantErr {
			t.Fatalf("transition(%q,%q) err=%v wantErr=%v", tt.from, tt.action, err, tt.wantErr)
		}
		if got != tt.want {
			t.Fatalf("transition(%q,%q)=%q want %q", tt.from, tt.action, got, tt.want)
		}
	}
}

func TestTransferDiff(t *testing.T) {
	if transferDiff(10, 7) != -3 {
		t.Fatal("shortfall should be negative")
	}
	if transferDiff(10, 12) != 2 {
		t.Fatal("surplus should be positive")
	}
	if transferDiff(5, 5) != 0 {
		t.Fatal("equal should be zero")
	}
}

func TestValidateItemsRefusesDuplicateLines(t *testing.T) {
	const p = "00000000-0000-4000-8901-000000000001"
	for _, tt := range []struct {
		name    string
		items   []TransferItemInput
		wantErr bool
	}{
		{"distinct sizes", []TransferItemInput{{p, "M", 2}, {p, "L", 3}}, false},
		{"same product and size", []TransferItemInput{{p, "M", 2}, {p, "M", 3}}, true},
		{"same uuid spelled differently", []TransferItemInput{{p, "M", 2}, {"{" + p + "}", "M", 1}}, true},
		{"same uuid upper case", []TransferItemInput{{"0000000a-0000-4000-8901-00000000000b", "M", 2}, {"0000000A-0000-4000-8901-00000000000B", "M", 1}}, true},
		{"empty", nil, true},
		{"zero qty", []TransferItemInput{{p, "M", 0}}, true},
	} {
		if err := validateItems(tt.items); (err != nil) != tt.wantErr {
			t.Errorf("%s: err=%v wantErr=%v", tt.name, err, tt.wantErr)
		}
	}
}

func TestReceivedPerLine(t *testing.T) {
	ln := func(id, size string, sent int) transferLine {
		return transferLine{id: id, pid: "p", size: size, sent: sent}
	}
	item := func(size string, qty int) TransferReceiveItem {
		return TransferReceiveItem{ProductID: "p", VariantSize: size, ReceivedQty: qty}
	}
	dup := []transferLine{ln("a", "M", 2), ln("b", "M", 3)}
	single := []transferLine{ln("a", "M", 5)}
	for _, tt := range []struct {
		name  string
		lines []transferLine
		items []TransferReceiveItem
		want  []int
	}{
		{"single line omitted = full", single, nil, []int{5}},
		{"single line short", single, []TransferReceiveItem{item("M", 4)}, []int{4}},
		{"single line repeated key keeps the last entry", single, []TransferReceiveItem{item("M", 1), item("M", 4)}, []int{4}},
		{"duplicate lines omitted = full", dup, nil, []int{2, 3}},
		{"duplicate lines itemized entries are summed", dup, []TransferReceiveItem{item("M", 2), item("M", 3)}, []int{2, 3}},
		{"duplicate lines one total fills in order", dup, []TransferReceiveItem{item("M", 4)}, []int{2, 2}},
		{"duplicate lines surplus lands on the last line", dup, []TransferReceiveItem{item("M", 7)}, []int{2, 5}},
		{"duplicate lines zero", dup, []TransferReceiveItem{item("M", 0)}, []int{0, 0}},
		{"other key untouched", []transferLine{ln("a", "M", 2), ln("b", "M", 3), ln("c", "XL", 1)},
			[]TransferReceiveItem{item("M", 1)}, []int{1, 0, 1}},
	} {
		got, err := receivedPerLine(tt.lines, tt.items)
		if err != nil {
			t.Fatalf("%s: %v", tt.name, err)
		}
		if fmt.Sprint(got) != fmt.Sprint(tt.want) {
			t.Errorf("%s: got %v want %v", tt.name, got, tt.want)
		}
	}
	if _, err := receivedPerLine(dup, []TransferReceiveItem{item("M", -1)}); err == nil {
		t.Error("negative received qty must be refused")
	}
}
