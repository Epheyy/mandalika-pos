package read

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestBuildOrderWhereEmptyCrossAll(t *testing.T) {
	where, args := buildOrderWhere(OrderFilter{Scope: Scope{CrossAll: true}})
	if where != "WHERE 1=1" || len(args) != 0 {
		t.Fatalf("where=%q args=%v", where, args)
	}
}

func TestBuildOrderWhereScopesToOutlet(t *testing.T) {
	where, args := buildOrderWhere(OrderFilter{Scope: Scope{OutletID: "out-1"}})
	if !strings.Contains(where, "o.outlet_id=$1") || len(args) != 1 || args[0] != "out-1" {
		t.Fatalf("where=%q args=%v", where, args)
	}
}

// Legacy from/to (POS contract) keep their exact SQL: from is a plain >=, to is
// inclusive of the whole day via ::date + 1 day. Their meaning must not change.
func TestBuildOrderWhereLegacyFromToUnchanged(t *testing.T) {
	where, args := buildOrderWhere(OrderFilter{Scope: Scope{CrossAll: true}, LegacyFrom: "2026-09-21", LegacyTo: "2026-09-22"})
	want := "WHERE 1=1 AND o.created_at >= $1 AND o.created_at < ($2::date + interval '1 day')"
	if where != want || len(args) != 2 || args[0] != "2026-09-21" || args[1] != "2026-09-22" {
		t.Fatalf("where=%q args=%v", where, args)
	}
}

func TestBuildOrderWhereBusinessDayBounds(t *testing.T) {
	where, args := buildOrderWhere(OrderFilter{Scope: Scope{CrossAll: true}, DateFrom: "2026-01-02", DateTo: "2026-01-03"})
	if len(args) != 2 || args[0] != "2026-01-02" || args[1] != "2026-01-03" {
		t.Fatalf("args=%v", args)
	}
	for _, frag := range []string{
		"o.business_date >= $1::text::date",
		"o.business_date <= $2::text::date",
	} {
		if !strings.Contains(where, frag) {
			t.Errorf("missing %q in %q", frag, where)
		}
	}
}

func TestBuildOrderWhereInstantBounds(t *testing.T) {
	from := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	to := from.Add(24 * time.Hour)
	where, args := buildOrderWhere(OrderFilter{Scope: Scope{CrossAll: true}, FromInstant: &from, ToInstant: &to})
	if !strings.Contains(where, "o.created_at >= $1") || !strings.Contains(where, "o.created_at < $2") || len(args) != 2 {
		t.Fatalf("where=%q args=%v", where, args)
	}
}

func TestBuildOrderWhereStatusPaymentAndSearch(t *testing.T) {
	where, args := buildOrderWhere(OrderFilter{Scope: Scope{CrossAll: true}, Status: "refunded", PaymentMethod: " QRIS", Q: "ani"})
	if !strings.Contains(where, "o.status=$1") {
		t.Errorf("status: %q", where)
	}
	if !strings.Contains(where, "lower(btrim(o.payment_method)) = lower(btrim($2))") {
		t.Errorf("payment: %q", where)
	}
	if !strings.Contains(where, "o.cashier_name ILIKE $3") || args[2] != "%ani%" {
		t.Errorf("q must match cashier name: %q %v", where, args)
	}
}

// Every placeholder in the clause must be backed by exactly one arg, in order.
func TestBuildOrderWherePlaceholdersMatchArgs(t *testing.T) {
	from := time.Now()
	where, args := buildOrderWhere(OrderFilter{
		Scope: Scope{OutletID: "o"}, DateFrom: "2026-01-01", DateTo: "2026-01-02",
		Status: "completed", PaymentMethod: "cash", Q: "x", ShiftID: "s", CustomerID: "c",
		LegacyFrom: "2026-01-01", LegacyTo: "2026-01-02", FromInstant: &from, ToInstant: &from,
	})
	for i := 1; i <= len(args); i++ {
		if !strings.Contains(where, fmt.Sprintf("$%d", i)) {
			t.Errorf("arg $%d unused in %q", i, where)
		}
	}
	if strings.Contains(where, fmt.Sprintf("$%d", len(args)+1)) {
		t.Errorf("placeholder beyond args in %q", where)
	}
}
