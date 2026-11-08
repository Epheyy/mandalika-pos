package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

// Values of order_refunds.payout_source (C6a, D-56).
const (
	payoutSourceSale    = "sale"    // single-method order: the sale's own method
	payoutSourceChosen  = "chosen"  // split order, the cashier named the method
	payoutSourceDefault = "default" // split order, the cashier did not pick: the server default (incl. a POS default chip kept, payoutPicked=false, that equals it)
)

// payoutLine is one tender line as the payout rule sees it: Amount is the applied amount in
// cents, Seq the line order.
type payoutLine struct {
	Method string
	Amount int64
	Seq    int
}

func normMethod(m string) string { return strings.ToLower(strings.TrimSpace(m)) }

// isSplitOrder reports whether an order needs the split payout rule: its tender lines name
// more than one distinct method, or it carries the split sentinel (the SQL trigger keys on the
// sentinel alone, so a sentinel order without lines is split too). Orders without lines and
// without the sentinel (every pre-C6 order) are single-method by definition.
func isSplitOrder(saleMethod string, lines []payoutLine) bool {
	distinct := make(map[string]bool, len(lines))
	for _, l := range lines {
		distinct[normMethod(l.Method)] = true
	}
	return len(distinct) > 1 || normMethod(saleMethod) == splitMethodID
}

// canonicalPayoutMethod stores a chosen payout method under the configured payment-method id
// when one matches (case-insensitive, trimmed): the shift buckets and cash ids compare ids
// case-sensitively, so "Tunai" must be recorded as "tunai". An unconfigured id is kept trimmed.
func canonicalPayoutMethod(methods []api.PaymentMethodConfig, requested string) string {
	want := strings.TrimSpace(requested)
	for _, m := range methods {
		if strings.EqualFold(strings.TrimSpace(m.Id), want) {
			return strings.TrimSpace(m.Id)
		}
	}
	return want
}

// defaultPayoutMethod is the D-56 default of a split order, and must agree with the SQL
// function order_default_payout_method (migration 0079): the cash line's method when the sale
// had a cash line (lowest seq), otherwise the line with the largest applied amount (ties:
// lowest seq). Returns the stored method id verbatim, "" for no lines.
func defaultPayoutMethod(lines []payoutLine, isCash func(string) bool) string {
	best := -1
	for i, l := range lines {
		if best < 0 || payoutLineBefore(l, lines[best], isCash) {
			best = i
		}
	}
	if best < 0 {
		return ""
	}
	return lines[best].Method
}

// payoutLineBefore orders lines like the SQL: cash first (lowest seq), then larger amount,
// then lower seq.
func payoutLineBefore(a, b payoutLine, isCash func(string) bool) bool {
	ac, bc := isCash(a.Method), isCash(b.Method)
	if ac != bc {
		return ac
	}
	if !ac && a.Amount != b.Amount {
		return a.Amount > b.Amount
	}
	return a.Seq < b.Seq
}

// resolveRefundPayout picks the method and payout_source a refund row records. A
// single-method order pays out in orders.payment_method and ignores any requested method
// (byte-identical to pre-C6a). A split order uses the requested method (chosen) or the
// default. picked (sync audit flag, nil = absent) only relabels a requested method: payout_source
// is default only when picked is false AND the requested method is the server's own default for the
// order; any other case stays chosen. The method and amounts are never changed. requested is the raw request value: it is validated here, only for a split order,
// because a single-method order ignores it entirely (a malformed value is not an error
// there). Runs inside the refund's locked tx.
func resolveRefundPayout(ctx context.Context, tx pgx.Tx, orderID, saleMethod string, requested *string, picked *bool) (method, source string, err error) {
	lines, err := loadPayoutLines(ctx, tx, orderID)
	if err != nil {
		return "", "", err
	}
	if !isSplitOrder(saleMethod, lines) {
		return saleMethod, payoutSourceSale, nil
	}
	asked, err := ValidateRefundPayoutMethod(requested)
	if err != nil {
		return "", "", err
	}
	settings, err := loadAppSettings(ctx, tx)
	if err != nil {
		return "", "", fmt.Errorf("load settings for refund payout: %w", err)
	}
	isCash := func(id string) bool { return IsCashMethod(settings.PaymentMethods, id) }
	serverDefault := serverDefaultPayout(saleMethod, lines, isCash)
	if asked != nil {
		method := canonicalPayoutMethod(settings.PaymentMethods, *asked)
		return method, askedPayoutSource(picked, method, serverDefault), nil
	}
	return serverDefault, payoutSourceDefault, nil
}

// serverDefaultPayout is the D-56 default of a split order: the default line's method, or the sale
// method for a sentinel order without lines (SQL's synthetic line).
func serverDefaultPayout(saleMethod string, lines []payoutLine, isCash func(string) bool) string {
	if m := defaultPayoutMethod(lines, isCash); m != "" {
		return m
	}
	return saleMethod
}

// askedPayoutSource is the payout_source of a split refund that named a method: 'chosen', unless the
// POS said it only kept the preselected default (picked == false) AND the method it sent really is the
// server's default for the order (same id, case-insensitive) -> 'default'. A client claim never
// relabels a method the server would not have picked. Audit only.
func askedPayoutSource(picked *bool, method, serverDefault string) string {
	if picked != nil && !*picked && normMethod(method) == normMethod(serverDefault) {
		return payoutSourceDefault
	}
	return payoutSourceChosen
}

func loadPayoutLines(ctx context.Context, tx pgx.Tx, orderID string) ([]payoutLine, error) {
	rows, err := tx.Query(ctx,
		`SELECT method, round(amount*100)::bigint, seq FROM order_tenders WHERE order_id=$1 ORDER BY seq`, orderID)
	if err != nil {
		return nil, fmt.Errorf("load order tenders for refund: %w", err)
	}
	defer rows.Close()
	var lines []payoutLine
	for rows.Next() {
		var l payoutLine
		if err := rows.Scan(&l.Method, &l.Amount, &l.Seq); err != nil {
			return nil, err
		}
		lines = append(lines, l)
	}
	return lines, rows.Err()
}
