package read

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTrigramUsable(t *testing.T) {
	for q, want := range map[string]bool{
		"MND-361872": true, "Budi": true, "081": true, "abc": true,
		"12": false, "ab": false, "a_b%c": false, "Bu di": false, "": false, "--": false,
	} {
		if got := trigramUsable(q); got != want {
			t.Errorf("trigramUsable(%q) = %v, want %v", q, got, want)
		}
	}
}

func TestUseSearchIndexGate(t *testing.T) {
	base := OrderFilter{Scope: Scope{CrossAll: true}, Q: "Budi"}
	if !useSearchIndex(base) {
		t.Fatal("a trigram-usable q must use the index form")
	}
	for name, f := range map[string]OrderFilter{
		"no q":     {Scope: Scope{CrossAll: true}},
		"short q":  {Q: "ab"},
		"shift":    {Q: "Budi", ShiftID: "s1"},
		"customer": {Q: "Budi", CustomerID: "c1"},
	} {
		if useSearchIndex(f) {
			t.Errorf("%s: must keep today's form", name)
		}
	}
	forced := OrderFilter{Q: "ab"}
	ForceSearchForm(&forced, true)
	if !useSearchIndex(forced) {
		t.Error("seam must force the indexed form")
	}
	ForceSearchForm(&forced, false)
	if useSearchIndex(forced) {
		t.Error("seam must force the legacy form")
	}
}

var placeholderRe = regexp.MustCompile(`\$(\d+)`)

func maxPlaceholder(t *testing.T, sql string) int {
	t.Helper()
	max := 0
	for _, m := range placeholderRe.FindAllStringSubmatch(sql, -1) {
		n, _ := strconv.Atoi(m[1])
		if n > max {
			max = n
		}
	}
	return max
}

func TestOrderSearchSetPlaceholders(t *testing.T) {
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	cases := map[string]OrderFilter{
		"customer-search": {Scope: Scope{OutletID: "o1"}, Q: "Budi", CustomerSearch: true, DateFrom: "2026-01-01", Status: "completed", PaymentMethod: "cash"},
		"restricted":      {Scope: Scope{CrossAll: true}, Q: "Budi"},
		"phone":           {Scope: Scope{OutletID: "o1"}, Q: "0812000111", FromInstant: &from},
		"refund-basis":    {Scope: Scope{CrossAll: true}, Q: "Budi", CustomerSearch: true, DateBasis: "refund", DateFrom: "2026-01-01"},
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			body, args := orderSearchSet(f, orderSetCols(f), " AND o.created_at <= $1::timestamptz", []any{from})
			if got := maxPlaceholder(t, body); got != len(args) {
				t.Fatalf("highest placeholder $%d, %d args", got, len(args))
			}
			found := false
			for _, a := range args {
				if a == qPattern(f.Q) {
					found = true
				}
			}
			if !found {
				t.Fatalf("pattern arg %q missing from %v", qPattern(f.Q), args)
			}
			hasCustomers := strings.Contains(body, "UNION\n")
			switch name {
			case "restricted":
				if hasCustomers || strings.Contains(body, "customers") {
					t.Fatalf("restricted form without a phone must have no customers arm:\n%s", body)
				}
			case "phone":
				if !strings.Contains(body, "merged_into IS NULL") || !strings.Contains(body, "merged_into IS NOT NULL") {
					t.Fatalf("phone form needs both merged_into halves:\n%s", body)
				}
			case "customer-search", "refund-basis":
				if !hasCustomers || !strings.Contains(body, "c.phone ILIKE") {
					t.Fatalf("customer-search form needs the customers arm:\n%s", body)
				}
			}
			if strings.Count(body, "o.created_at <= $1::timestamptz") != strings.Count(body, "FROM orders o") {
				t.Fatalf("asOf bound must sit inside every arm:\n%s", body)
			}
		})
	}
}

func TestRestrictedShortTermHidesIndex(t *testing.T) {
	for q, hidden := range map[string]bool{"ab": true, "12": true, "a_": true, "Budi": false, "MND-12": false} {
		where, _ := buildOrderWhere(OrderFilter{Scope: Scope{CrossAll: true}, Q: q})
		if got := strings.Contains(where, "|| ''"); got != hidden {
			t.Errorf("q=%q: || '' present = %v, want %v\n%s", q, got, hidden, where)
		}
	}
	// POS cashier / CustomerDetail searches keep today's plan (shift or customer index), so the
	// wrap also applies to a trigram-usable term when a shift or customer filter is present.
	for name, f := range map[string]OrderFilter{
		"shift":    {Scope: Scope{CrossAll: true}, Q: "Budi", ShiftID: "s1"},
		"customer": {Scope: Scope{CrossAll: true}, Q: "Budi", CustomerID: "c1"},
	} {
		if where, _ := buildOrderWhere(f); !strings.Contains(where, "(o.order_number || '')") || !strings.Contains(where, "(o.cashier_name || '')") {
			t.Errorf("%s + q=Budi must hide the trigram indexes:\n%s", name, where)
		}
	}
	where, _ := buildOrderWhere(OrderFilter{Scope: Scope{CrossAll: true}, Q: "ab", CustomerSearch: true})
	if strings.Contains(where, "|| ''") {
		t.Error("the CustomerSearch clause must be unchanged")
	}
}

func TestOrderSearchStatementsHaveNoWindowCount(t *testing.T) {
	for _, refund := range []bool{false, true} {
		f := OrderFilter{Scope: Scope{CrossAll: true}, Q: "Budi", CustomerSearch: true}
		if refund {
			f.DateBasis = "refund"
		}
		body, _ := orderSearchSet(f, orderSetCols(f), "", nil)
		sql := orderPageSQLFromSet(f, body, "", fmt.Sprintf("$%d OFFSET $%d", 3, 4), "")
		if strings.Contains(sql, "OVER(") || strings.Contains(sql, "OVER (") {
			t.Fatalf("window count in search statement:\n%s", sql)
		}
		if !strings.HasSuffix(strings.TrimSpace(sql), "pg.id DESC") {
			t.Fatalf("statement must end ordered by pg.id DESC:\n%s", sql)
		}
		if !strings.Contains(sql, "f AS MATERIALIZED") {
			t.Fatal("search set must be MATERIALIZED")
		}
	}
}
