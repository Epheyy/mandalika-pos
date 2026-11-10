package read

import (
	"encoding/base64"
	"regexp"
	"strings"
	"testing"
	"time"
)

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

var overRe = regexp.MustCompile(`(?i)\bover\s*\(`)

// The slice's whole point: no list statement may compute its total with a window function
// over the full filtered set, and every sort must end in a unique id key.
func TestListStatementsHaveNoWindowCount(t *testing.T) {
	orderCases := map[string]OrderFilter{
		"plain":    {},
		"filtered": {DateFrom: "2026-01-01", DateTo: "2026-01-31", Status: "completed"},
		"q":        {Q: "abc"},
		"pay":      {PaymentMethod: "cash"},
		"refund":   {DateBasis: "refund", DateFrom: "2026-01-01"},
	}
	for name, f := range orderCases {
		where, _ := buildOrderWhere(f)
		sql := orderPageSQL(f, where, "", "$1 OFFSET $2", "", f.Q != "" || f.PaymentMethod != "")
		if overRe.MatchString(sql) {
			t.Errorf("orders/%s: window function in list SQL", name)
		}
		if !strings.Contains(sql, "pg.id DESC") {
			t.Errorf("orders/%s: outer ORDER BY must end in pg.id DESC", name)
		}
	}
	for _, sort := range []string{"", "terbaru"} {
		sql, _ := customersPageSQL(1, 50, "budi", sort, "", "")
		if overRe.MatchString(sql) {
			t.Errorf("customers/%q: window function in list SQL", sort)
		}
		if !strings.HasSuffix(sql, "pg.pid DESC") || !strings.Contains(sql, "id DESC OFFSET $1 LIMIT $2") {
			t.Errorf("customers/%q: sorts must end with an id tie-break: %s", sort, sql)
		}
	}
	if sql, args := customersPageSQL(1, 50, "", "", "", ""); strings.Contains(sql, "$3") || len(args) != 2 {
		t.Errorf("empty q must add no $3 clause, got args %v", args)
	}
}

func TestOrderCursorRoundTripKeepsMicroseconds(t *testing.T) {
	c := OrderCursor{
		AsOf:      time.Date(2026, 11, 10, 7, 52, 1, 123456000, time.UTC),
		CreatedAt: time.Date(2026, 11, 10, 7, 50, 0, 1000, time.UTC),
		ID:        "00000000-0000-4000-8603-000000000001",
	}
	got, err := DecodeOrderCursor(EncodeOrderCursor(c))
	if err != nil {
		t.Fatal(err)
	}
	if !got.AsOf.Equal(c.AsOf) || !got.CreatedAt.Equal(c.CreatedAt) || got.ID != c.ID {
		t.Fatalf("round trip lost data: %+v vs %+v", got, c)
	}
}

func TestDecodeOrderCursorRejectsTampered(t *testing.T) {
	good := EncodeOrderCursor(OrderCursor{AsOf: time.Now(), CreatedAt: time.Now(), ID: "00000000-0000-4000-8603-000000000001"})
	for name, s := range map[string]string{
		"empty":     "",
		"not b64":   "!!!",
		"not json":  "bm90IGpzb24",
		"truncated": good[:len(good)-4],
	} {
		if _, err := DecodeOrderCursor(s); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	// well-formed JSON, wrong content
	for name, raw := range map[string]string{
		"bad version": `{"v":2,"a":"2026-01-01T00:00:00Z","c":"2026-01-01T00:00:00Z","i":"00000000-0000-4000-8603-000000000001"}`,
		"bad time":    `{"v":1,"a":"yesterday","c":"2026-01-01T00:00:00Z","i":"00000000-0000-4000-8603-000000000001"}`,
		"bad uuid":    `{"v":1,"a":"2026-01-01T00:00:00Z","c":"2026-01-01T00:00:00Z","i":"1; DROP TABLE orders"}`,
		"unknown key": `{"v":1,"a":"2026-01-01T00:00:00Z","c":"2026-01-01T00:00:00Z","i":"00000000-0000-4000-8603-000000000001","x":1}`,
	} {
		if _, err := DecodeOrderCursor(b64(raw)); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}
