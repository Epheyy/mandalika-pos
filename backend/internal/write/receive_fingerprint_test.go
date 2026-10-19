package write

import "testing"

func TestReceiveFingerprint(t *testing.T) {
	a := []TransferReceiveItem{{ProductID: "p2", VariantSize: "50", ReceivedQty: 3}, {ProductID: "p1", VariantSize: "30", ReceivedQty: 5}}
	b := []TransferReceiveItem{{ProductID: "p1", VariantSize: "30", ReceivedQty: 5}, {ProductID: "p2", VariantSize: "50", ReceivedQty: 3}}
	base := ReceiveFingerprint("t1", a, "rusak")
	if base == "" || base != ReceiveFingerprint("t1", b, "rusak") {
		t.Fatal("item order must not matter")
	}
	if base != ReceiveFingerprint("t1", a, "  rusak \n") {
		t.Fatal("reason is trimmed")
	}
	if base == ReceiveFingerprint("t2", a, "rusak") {
		t.Fatal("transfer id matters")
	}
	if base == ReceiveFingerprint("t1", a, "hilang") {
		t.Fatal("reason matters")
	}
	c := append([]TransferReceiveItem(nil), a...)
	c[0].ReceivedQty = 4
	if base == ReceiveFingerprint("t1", c, "rusak") {
		t.Fatal("qty change must alter the fingerprint")
	}
	// Input must not be reordered in place.
	if a[0].ProductID != "p2" {
		t.Fatal("input mutated")
	}
	// Delimiter smuggling must not collide.
	x := ReceiveFingerprint("t1", []TransferReceiveItem{{ProductID: "a|b", VariantSize: "c", ReceivedQty: 1}}, "")
	y := ReceiveFingerprint("t1", []TransferReceiveItem{{ProductID: "a", VariantSize: "b|c", ReceivedQty: 1}}, "")
	if x == y {
		t.Fatal("collision")
	}
}

func TestApproverAllowedAndScope(t *testing.T) {
	if !ApproverAllowed("admin", nil) || ApproverAllowed("cashier", nil) || !ApproverAllowed("manager", []string{"manager"}) {
		t.Fatal("approver role rule")
	}
	if ReceiveScope("o1", "", "admin", "") == "" || ReceiveScope("o1", "o2", "admin", "") == "" {
		t.Fatal("dest must be the caller's outlet")
	}
	if ReceiveScope("o1", "o1", "admin", "") != "" || ReceiveScope("o1", "o1", "manager", "o1") != "" {
		t.Fatal("ok cases")
	}
	if ReceiveScope("o1", "o1", "manager", "o2") == "" {
		t.Fatal("non-admin approver must belong to the outlet")
	}
}
