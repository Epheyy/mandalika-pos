package write

import "testing"

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
