package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Values of order_refunds.payout_source (C6a, D-56).
const (
	payoutSourceSale    = "sale"    // single-method order: the sale's own method
	payoutSourceChosen  = "chosen"  // split order, the cashier named the method
	payoutSourceDefault = "default" // split order, the server picked the default
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
// more than one distinct method, or it carries the split sentinel with lines to choose from.
// Orders without lines (every pre-C6 order) are single-method by definition.
func isSplitOrder(saleMethod string, lines []payoutLine) bool {
	distinct := make(map[string]bool, len(lines))
	for _, l := range lines {
		distinct[normMethod(l.Method)] = true
	}
	return len(distinct) > 1 || (normMethod(saleMethod) == splitMethodID && len(lines) > 0)
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
// default. requested is already validated and trimmed. Runs inside the refund's locked tx.
func resolveRefundPayout(ctx context.Context, tx pgx.Tx, orderID, saleMethod string, requested *string) (method, source string, err error) {
	lines, err := loadPayoutLines(ctx, tx, orderID)
	if err != nil {
		return "", "", err
	}
	if !isSplitOrder(saleMethod, lines) {
		return saleMethod, payoutSourceSale, nil
	}
	if requested != nil {
		return *requested, payoutSourceChosen, nil
	}
	settings, err := loadAppSettings(ctx, tx)
	if err != nil {
		return "", "", fmt.Errorf("load settings for refund payout: %w", err)
	}
	isCash := func(id string) bool { return IsCashMethod(settings.PaymentMethods, id) }
	return defaultPayoutMethod(lines, isCash), payoutSourceDefault, nil
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
