package service

// refundLine is one order_items row as RefundLinesTx loads it under the order row lock.
type refundLine struct {
	ID       string
	LineNo   *int   // NULL on orders created before migration 0077
	Net      *int64 // allocated net share (whole rupiah); NULL before 0077
	Subtotal int64  // gross line subtotal, the informational fallback amount of a legacy line
	Group    string // order_items.refund_group, "" = none
	Qty      int64
	Prior    int64 // units already refunded: sum(order_refund_items.quantity)
	// Stock facts (A44), used by the caller, not by the plan.
	ProductID, VariantSize             string
	IsBundle, SaleSkipped, VariantLive bool
}

// refundPick is the part of a line that one refund returns.
type refundPick struct {
	Index  int   // index into the loaded lines
	Qty    int64 // units returned now
	Amount int64 // allocated value of those units (RefundAmountForUnits)
}

// planRefund turns a request into the picks of one refund, applying every per-line rule of
// the C4a design under the order row lock the caller holds. items == nil is the legacy
// whole-order shape (every unit, caller has already checked the order is completed with no
// refund rows). It never touches the database so the rules are unit-testable.
//
// Error precedence: unknown line, then quantity over what is left, then split group.
func planRefund(lines []refundLine, items []RefundItemInput) (picks []refundPick, completes bool, err error) {
	if items == nil {
		for i, l := range lines {
			if l.Prior > 0 {
				return nil, false, ErrRefundPartialNeedsNewApp // defensive: legacy shape never refunds a remainder
			}
			if l.Qty <= 0 {
				continue
			}
			amt := max(l.Subtotal, 0) // CHECK(amount >= 0): an import artefact may be negative
			if l.Net != nil {
				amt = RefundAmountForUnits(*l.Net, l.Qty, 0, l.Qty)
			}
			picks = append(picks, refundPick{Index: i, Qty: l.Qty, Amount: amt})
		}
		return picks, true, nil
	}

	// Per-line refunds need the sale-time identity and net share on EVERY row (D-33): an order
	// created before 0077 can only be refunded whole.
	byLineNo := make(map[int]int, len(lines))
	for i, l := range lines {
		if l.LineNo == nil || l.Net == nil {
			return nil, false, ErrRefundLegacyWholeOnly
		}
		byLineNo[*l.LineNo] = i
	}
	requested := make(map[int]int64, len(items)) // line index -> units
	for _, it := range items {
		i, ok := byLineNo[it.LineNo]
		if !ok || it.Quantity <= 0 {
			return nil, false, ErrRefundLineUnknown
		}
		if _, dup := requested[i]; dup {
			return nil, false, ErrRefundLineUnknown
		}
		requested[i] = int64(it.Quantity)
	}
	for i, k := range requested {
		if k > lines[i].Qty-lines[i].Prior {
			return nil, false, ErrRefundQtyExceeded
		}
	}
	// Bundle / BXGY groups are all-or-nothing: touching any member needs every member (that
	// has units) requested for its full remaining quantity, and none refunded before.
	touched := make(map[string]bool)
	for i := range requested {
		if g := lines[i].Group; g != "" {
			touched[g] = true
		}
	}
	for i, l := range lines {
		if l.Group == "" || !touched[l.Group] || l.Qty <= 0 {
			continue
		}
		if l.Prior > 0 || requested[i] != l.Qty {
			return nil, false, ErrRefundGroupSplit
		}
	}

	completes = true
	for i, l := range lines {
		if l.Qty <= 0 {
			continue
		}
		k := requested[i]
		if l.Prior+k != l.Qty {
			completes = false
		}
		if k > 0 {
			picks = append(picks, refundPick{Index: i, Qty: k, Amount: RefundAmountForUnits(*l.Net, l.Qty, l.Prior, k)})
		}
	}
	if len(picks) == 0 {
		return nil, false, ErrRefundLineUnknown
	}
	return picks, completes, nil
}

// refundComputedAmount is the computed_amount of a refund. For an ordinary partial refund it
// is the sum of the picked line amounts. The refund that completes the order instead takes
// orders.total minus the sum of every earlier refund's computed_amount, so the computed
// amounts of all refunds of an order add up to the total exactly: any drift (a legacy or
// hand-written earlier row whose computed amount is not the line share, rounding in the
// allocation) is absorbed by the last refund and never left over or double counted. Floored at 0.
func refundComputedAmount(picks []refundPick, completes bool, orderTotal, priorComputed int64) int64 {
	if completes {
		if r := orderTotal - priorComputed; r > 0 {
			return r
		}
		return 0
	}
	var sum int64
	for _, p := range picks {
		sum += p.Amount
	}
	return sum
}

// refundScope is the order_refunds.scope: "full" is one refund that returns the whole order
// (either payload shape, no earlier refund); every other items-shape refund, the last one of a
// series included, is "partial". ("legacy_full" is only written by the 0077 backfill/trigger.)
func refundScope(completes bool, priorRefundCount int) string {
	if completes && priorRefundCount == 0 {
		return "full"
	}
	return "partial"
}
