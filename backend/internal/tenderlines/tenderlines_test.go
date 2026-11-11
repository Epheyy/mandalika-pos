package tenderlines

import (
	"strings"
	"testing"
)

func TestSetLinesIsOneLateralJoin(t *testing.T) {
	got := SetLines("sb", []string{"status", "business_date"})
	if n := strings.Count(got, "LEFT JOIN LATERAL"); n != 1 {
		t.Fatalf("want exactly one LEFT JOIN LATERAL, got %d:\n%s", n, got)
	}
	if strings.Count(got, "order_tenders") != 1 {
		t.Fatalf("order_tenders must be read once:\n%s", got)
	}
	for _, banned := range []string{"NOT EXISTS", "UNION"} {
		if strings.Contains(got, banned) {
			t.Fatalf("%s must not appear:\n%s", banned, got)
		}
	}
	if !strings.Contains(got, "FROM sb o LEFT JOIN LATERAL") {
		t.Fatalf("base must be read once as o:\n%s", got)
	}
	want := "SELECT o.id, o.status, o.business_date,"
	if !strings.HasPrefix(got, want) {
		t.Fatalf("keep columns must follow id in order; want prefix %q:\n%s", want, got)
	}
	if !strings.HasSuffix(got, "ON true") {
		t.Fatalf("unexpected tail:\n%s", got)
	}
}

func TestSetLinesNoKeepColumns(t *testing.T) {
	got := SetLines("(SELECT id, payment_method, total FROM x)", nil)
	if !strings.HasPrefix(got, "SELECT o.id,") {
		t.Fatalf("unexpected head:\n%s", got)
	}
}
