package service

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
)

func sp(s string) *string { return &s }

func TestValidateRefundPayoutMethod(t *testing.T) {
	for _, tc := range []struct {
		name    string
		in      *string
		want    *string
		wantErr error
	}{
		{"absent", nil, nil, nil},
		{"plain", sp("qris"), sp("qris"), nil},
		{"trimmed", sp("  qris "), sp("qris"), nil},
		{"blank", sp(""), nil, ErrRefundPayoutInvalid},
		{"whitespace", sp(" \t"), nil, ErrRefundPayoutInvalid},
		{"split", sp("split"), nil, ErrRefundPayoutInvalid},
		{"split mixed case padded", sp(" SpLiT "), nil, ErrRefundPayoutInvalid},
		{"64 runes ok", sp(strings.Repeat("é", 64)), sp(strings.Repeat("é", 64)), nil},
		{"65 runes", sp(strings.Repeat("a", 65)), nil, ErrRefundPayoutInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateRefundPayoutMethod(tc.in)
			if err != tc.wantErr {
				t.Fatalf("err=%v want %v", err, tc.wantErr)
			}
			if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
	if ErrRefundPayoutInvalid.ErrorCode() != apperr.Rejected {
		t.Fatal("payout error must be Rejected")
	}
}

func TestDefaultPayoutMethod(t *testing.T) {
	cashOnly := func(id string) bool { return normMethod(id) == "cash" }
	qrisIsCash := func(id string) bool { return normMethod(id) == "qris" } // explicit isCash on qris, cash false
	for _, tc := range []struct {
		name   string
		lines  []payoutLine
		isCash func(string) bool
		want   string
	}{
		{"cash line wins over a larger card line", []payoutLine{{"card", 90000, 1}, {"cash", 10000, 2}}, cashOnly, "cash"},
		{"largest non-cash wins", []payoutLine{{"card", 30000, 1}, {"qris", 70000, 2}}, cashOnly, "qris"},
		{"tie goes to lowest seq", []payoutLine{{"card", 50000, 1}, {"qris", 50000, 2}}, cashOnly, "card"},
		{"tie goes to lowest seq regardless of slice order", []payoutLine{{"qris", 50000, 2}, {"card", 50000, 1}}, cashOnly, "card"},
		{"configured method with isCash true counts as cash", []payoutLine{{"card", 90000, 1}, {"qris", 10000, 2}}, qrisIsCash, "qris"},
		{"isCash false on cash id: it is not a cash line", []payoutLine{{"cash", 10000, 1}, {"card", 90000, 2}}, func(string) bool { return false }, "card"},
		{"case-mismatched id is still cash", []payoutLine{{"card", 90000, 1}, {"CASH", 10000, 2}}, cashOnly, "CASH"},
		{"two cash lines: lowest seq", []payoutLine{{"card", 10, 1}, {"tunai", 5, 3}, {"cash", 5, 2}},
			func(id string) bool { n := normMethod(id); return n == "cash" || n == "tunai" }, "cash"},
		{"no lines", nil, cashOnly, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := defaultPayoutMethod(tc.lines, tc.isCash); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestIsSplitOrder(t *testing.T) {
	one := []payoutLine{{"cash", 100, 1}}
	two := []payoutLine{{"cash", 50, 1}, {"qris", 50, 2}}
	for _, tc := range []struct {
		name  string
		sale  string
		lines []payoutLine
		want  bool
	}{
		{"pre-C6 order: no lines", "cash", nil, false},
		{"single line", "cash", one, false},
		{"two lines, two methods", "split", two, true},
		{"two lines same method, case-mismatched", "cash", []payoutLine{{"cash", 1, 1}, {" CASH", 1, 2}}, false},
		{"split sentinel with one line", "split", one, true},
		{"split sentinel without lines stays single", "split", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSplitOrder(tc.sale, tc.lines); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

// payoutTx serves resolveRefundPayout's two reads: order_tenders rows and app_settings.
type payoutTx struct {
	pgx.Tx
	lines          []payoutLine
	paymentMethods []byte
}

func (tx *payoutTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	if !strings.Contains(sql, "FROM order_tenders") {
		panic("unexpected query: " + sql)
	}
	return &payoutRows{lines: tx.lines, i: -1}, nil
}

func (tx *payoutTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if !strings.Contains(sql, "FROM app_settings") {
		panic("unexpected query row: " + sql)
	}
	return inputTestRow(func(d ...any) error {
		*d[0].(*bool) = false
		*d[1].(*float64) = 0
		*d[2].(*bool) = false
		*d[3].(*string) = "none"
		*d[4].(*[]byte) = tx.paymentMethods
		return nil
	})
}

type payoutRows struct {
	pgx.Rows
	lines []payoutLine
	i     int
}

func (r *payoutRows) Next() bool { r.i++; return r.i < len(r.lines) }
func (r *payoutRows) Close()     {}
func (r *payoutRows) Err() error { return nil }
func (r *payoutRows) Scan(d ...any) error {
	l := r.lines[r.i]
	*d[0].(*string), *d[1].(*int64), *d[2].(*int) = l.Method, l.Amount, l.Seq
	return nil
}

func TestResolveRefundPayout(t *testing.T) {
	split := []payoutLine{{"card", 70000, 1}, {"cash", 30000, 2}}
	for _, tc := range []struct {
		name       string
		sale       string
		lines      []payoutLine
		methods    string
		asked      *string
		wantMethod string
		wantSource string
	}{
		{"pre-C6 order ignores payoutMethod", "qris", nil, "", sp("cash"), "qris", "sale"},
		{"single-method lines ignore payoutMethod", "card", []payoutLine{{"card", 100, 1}}, "", sp("cash"), "card", "sale"},
		{"split without payoutMethod: the cash line", "split", split, "", nil, "cash", "default"},
		{"split with payoutMethod: chosen, any method", "split", split, "", sp("transfer"), "transfer", "chosen"},
		{"split default honours isCash:false on the cash id", "split", split,
			`[{"id":"cash","name":"Tunai","isCash":false}]`, nil, "card", "default"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &payoutTx{lines: tc.lines, paymentMethods: []byte(tc.methods)}
			m, s, err := resolveRefundPayout(context.Background(), tx, refundTestOrderID, tc.sale, tc.asked)
			if err != nil {
				t.Fatal(err)
			}
			if m != tc.wantMethod || s != tc.wantSource {
				t.Fatalf("got %q/%q want %q/%q", m, s, tc.wantMethod, tc.wantSource)
			}
		})
	}
}
