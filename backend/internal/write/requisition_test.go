package write

import (
	"testing"

	"github.com/mandalika/pos-backend/internal/apperr"
)

func TestRequisitionTransition(t *testing.T) {
	ok := []struct{ from, action, to string }{
		{"draft", "submit", "submitted"},
		{"draft", "cancel", "cancelled"},
		{"submitted", "cancel", "cancelled"},
		{"submitted", "approve", "approved"},
		{"submitted", "reject", "rejected"},
		{"approved", "fulfil", "fulfilled"},
		{"fulfilled", "fulfil", "fulfilled"}, // re-fulfil: the caller also needs a cancelled transfer
	}
	for _, c := range ok {
		got, err := requisitionTransition(c.from, c.action)
		if err != nil || got != c.to {
			t.Errorf("%s/%s = %q, %v; want %q", c.from, c.action, got, err, c.to)
		}
	}
	statuses := []string{"draft", "submitted", "approved", "rejected", "fulfilled", "cancelled"}
	allowed := map[string]bool{}
	for _, c := range ok {
		allowed[c.from+"/"+c.action] = true
	}
	for _, from := range statuses {
		for _, action := range []string{"submit", "cancel", "approve", "reject", "fulfil", "bogus"} {
			if allowed[from+"/"+action] {
				continue
			}
			_, err := requisitionTransition(from, action)
			if code, _ := apperr.CodeOf(err); code != apperr.Conflict {
				t.Errorf("%s/%s: want a Conflict refusal, got %v", from, action, err)
			}
		}
	}
}

func TestCanRefulfil(t *testing.T) {
	for st, want := range map[string]bool{"cancelled": true, "draft": false, "in_transit": false, "completed": false} {
		if canRefulfil(st) != want {
			t.Errorf("canRefulfil(%q) != %v", st, want)
		}
	}
}

const pidA = "11111111-1111-4111-8111-111111111111"

func TestValidateRequisitionInput(t *testing.T) {
	item := func(pid, size string, q int) RequisitionItemInput {
		return RequisitionItemInput{ProductID: pid, VariantSize: size, RequestedQty: q}
	}
	cases := []struct {
		name string
		in   RequisitionInput
		bad  bool
	}{
		{"ok", RequisitionInput{Items: []RequisitionItemInput{item(pidA, "M", 2)}}, false},
		{"ok with date", RequisitionInput{NeededBy: "2026-11-03", Items: []RequisitionItemInput{item(pidA, "M", 2)}}, false},
		{"no lines", RequisitionInput{}, true},
		{"zero qty", RequisitionInput{Items: []RequisitionItemInput{item(pidA, "M", 0)}}, true},
		{"bad product", RequisitionInput{Items: []RequisitionItemInput{item("x", "M", 1)}}, true},
		{"no size", RequisitionInput{Items: []RequisitionItemInput{item(pidA, " ", 1)}}, true},
		{"bad date", RequisitionInput{NeededBy: "03/11/2026", Items: []RequisitionItemInput{item(pidA, "M", 1)}}, true},
		{"duplicate line", RequisitionInput{Items: []RequisitionItemInput{item(pidA, "M", 1), item("{"+pidA+"}", "M", 2)}}, true},
		{"same product other size", RequisitionInput{Items: []RequisitionItemInput{item(pidA, "M", 1), item(pidA, "L", 2)}}, false},
	}
	for _, c := range cases {
		err := validateRequisitionInput(c.in)
		if (err != nil) != c.bad {
			t.Errorf("%s: err=%v, want bad=%v", c.name, err, c.bad)
		}
		if err != nil {
			if code, _ := apperr.CodeOf(err); code != apperr.Rejected {
				t.Errorf("%s: want Rejected, got %v", c.name, code)
			}
		}
	}
}

func TestResolveApproval(t *testing.T) {
	l1 := "22222222-2222-4222-8222-222222222222"
	l2 := "33333333-3333-4333-8333-333333333333"
	lines := []reqLine{{id: l1, requested: 5}, {id: l2, requested: 3}}
	cases := []struct {
		name  string
		items []RequisitionApproveItem
		bad   bool
	}{
		{"full", []RequisitionApproveItem{{l1, 5}, {l2, 3}}, false},
		{"partial and zero", []RequisitionApproveItem{{l1, 2}, {l2, 0}}, false},
		{"all zero", []RequisitionApproveItem{{l1, 0}, {l2, 0}}, true},
		{"above requested", []RequisitionApproveItem{{l1, 6}, {l2, 3}}, true},
		{"negative", []RequisitionApproveItem{{l1, -1}, {l2, 3}}, true},
		{"missing line", []RequisitionApproveItem{{l1, 5}}, true},
		{"duplicate line", []RequisitionApproveItem{{l1, 5}, {l1, 4}}, true},
		{"unknown line", []RequisitionApproveItem{{l1, 5}, {"44444444-4444-4444-8444-444444444444", 1}}, true},
	}
	for _, c := range cases {
		_, err := resolveApproval(lines, c.items)
		if (err != nil) != c.bad {
			t.Errorf("%s: err=%v, want bad=%v", c.name, err, c.bad)
		}
	}
}

func TestApprovedTransferItemsSkipsZero(t *testing.T) {
	two, zero := 2, 0
	got := approvedTransferItems([]reqLine{
		{pid: "p1", size: "M", requested: 5, approved: &two},
		{pid: "p2", size: "M", requested: 5, approved: &zero},
		{pid: "p3", size: "M", requested: 5},
	})
	if len(got) != 1 || got[0].ProductID != "p1" || got[0].Qty != 2 {
		t.Fatalf("got %+v, want only p1 x2", got)
	}
}
