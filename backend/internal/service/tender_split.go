package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"
)

// C6 split tender. Pure allocation and structural parsing; no database. A sale with
// one payment line (the legacy scalar payload or a one-line tenders array) always goes
// through evaluateTender unchanged, so the A09 behaviour is byte-identical.
const (
	TenderShort          = "tender_short"       // captured money does not cover the due total
	TenderNoncashOverpay = "noncash_overpay"    // non-cash lines exceed the due total
	TenderCashMerged     = "tender_cash_merged" // batch only: several cash lines merged into one
	splitMethodID        = "split"              // reserved orders.payment_method sentinel
	maxTenderLines       = 4                    // D-51
	maxTenderMethodLen   = 64                   // runes
	maxTenderReferenceLn = 64                   // runes
)

type tenderMode int

const (
	tenderOnline tenderMode = iota // direct POST /orders: judged strictly
	tenderBatch                    // sync batch: always accept and flag
)

// TenderLine is one captured payment line. Amount is what the line captured: the cash
// handed over, or the amount charged to a non-cash method.
type TenderLine struct {
	Method    string
	Amount    float64
	Reference string
}

// tenderRow is one order_tenders row to insert. Amount is applied to the bill (rows sum
// to the due total); Tendered is the captured amount, verbatim.
type tenderRow struct {
	Seq       int
	Method    string
	Amount    float64
	Tendered  float64
	Change    float64
	Reference string
}

// tenderSettlement is the judged outcome: rows plus the orders summary columns.
type tenderSettlement struct {
	Rows          []tenderRow
	PaymentMethod string  // the shared method, or splitMethodID
	AmountPaid    float64 // Σ tendered
	Change        float64 // the cash line's change
	Reason        string  // "" when acceptable
}

func toCents(v float64) int64   { return int64(math.Round(v * 100)) }
func fromCents(c int64) float64 { return float64(c) / 100 }

// tenderReasonPriority picks the single stored reason: tender_short > noncash_overpay >
// tender_cash_merged. Empty reasons are ignored.
func tenderReasonPriority(reasons ...string) string {
	for _, want := range []string{TenderShort, TenderCashShort, TenderNoncashOverpay, TenderNoncashMismatch, TenderCashMerged} {
		for _, r := range reasons {
			if r == want {
				return r
			}
		}
	}
	return ""
}

// singleTender is the one-line adapter: evaluateTender unchanged, shaped as one
// order_tenders row (amount = due, tendered = captured, change). Online, a cash
// shortfall is rejected exactly as before.
func singleTender(line TenderLine, due float64, isCash func(string) bool, mode tenderMode) (tenderSettlement, error) {
	amountPaid, change, reason := evaluateTender(isCash(line.Method), line.Amount, due)
	if reason == TenderCashShort && mode == tenderOnline {
		return tenderSettlement{}, tenderRejectedError(line.Amount, due)
	}
	return tenderSettlement{
		Rows:          []tenderRow{{Seq: 1, Method: line.Method, Amount: due, Tendered: amountPaid, Change: change, Reference: line.Reference}},
		PaymentMethod: line.Method,
		AmountPaid:    amountPaid,
		Change:        change,
		Reason:        reason,
	}, nil
}

// settleTenders judges a sale's payment lines against the due total (after points).
// One line takes the legacy path; two or more are allocated.
func settleTenders(due float64, lines []TenderLine, isCash func(string) bool, mode tenderMode) (tenderSettlement, error) {
	if len(lines) == 1 {
		return singleTender(lines[0], due, isCash, mode)
	}
	return allocateTenders(due, lines, isCash, mode)
}

// mergeCashLines enforces at most one cash line (D-52). Online, a second cash line is
// rejected; in a batch the cash lines are merged (Σ tendered, first line's method,
// reference and position) and merged reports true.
func mergeCashLines(lines []TenderLine, isCash func(string) bool, mode tenderMode) (out []TenderLine, merged bool, err error) {
	firstCash := -1
	for _, l := range lines {
		if !isCash(l.Method) {
			out = append(out, l)
			continue
		}
		if firstCash < 0 {
			firstCash = len(out)
			out = append(out, l)
			continue
		}
		if mode == tenderOnline {
			return nil, false, errTenderMultiCash
		}
		out[firstCash].Amount = fromCents(toCents(out[firstCash].Amount) + toCents(l.Amount))
		merged = true
	}
	return out, merged, nil
}

// allocateTenders splits the due total across the captured lines (plan 2.3). Non-cash
// lines apply what was charged; the single cash line takes the rest and gives the
// change; any remaining difference lands on the last line (excess is taken off from the
// last line backwards, never below 0) and the sale is flagged. The applied amounts
// always sum to due; tendered is always verbatim. Online, any shortfall is rejected.
func allocateTenders(due float64, lines []TenderLine, isCash func(string) bool, mode tenderMode) (tenderSettlement, error) {
	lines, merged, err := mergeCashLines(lines, isCash, mode)
	if err != nil {
		return tenderSettlement{}, err
	}
	if len(lines) == 1 { // batch: every line was cash and collapsed into one
		s, err := singleTender(lines[0], due, isCash, mode)
		s.Reason = tenderReasonPriority(s.Reason, mergedReason(merged))
		return s, err
	}
	dueC := toCents(due)
	rows, reason := applyLines(dueC, lines, isCash)
	if reason == TenderShort && mode == tenderOnline {
		return tenderSettlement{}, tenderRejectedError(sumTendered(rows), due)
	}
	return summarize(rows, tenderReasonPriority(reason, mergedReason(merged))), nil
}

func mergedReason(merged bool) string {
	if merged {
		return TenderCashMerged
	}
	return ""
}

func sumTendered(rows []tenderRow) float64 {
	var c int64
	for _, r := range rows {
		c += toCents(r.Tendered)
	}
	return fromCents(c)
}

// applyLines runs allocation steps 1-3 in whole cents and returns the rows plus the
// shortfall/overpay reason ("" when within the Rp1 tolerance).
func applyLines(dueC int64, lines []TenderLine, isCash func(string) bool) ([]tenderRow, string) {
	amounts := make([]int64, len(lines))
	changes := make([]int64, len(lines))
	var nonCash int64
	cashIdx := -1
	for i, l := range lines {
		if isCash(l.Method) {
			cashIdx = i
			continue
		}
		amounts[i] = toCents(l.Amount)
		nonCash += amounts[i]
	}
	reason := ""
	if cashIdx >= 0 {
		tendered := toCents(lines[cashIdx].Amount)
		amounts[cashIdx] = max(0, dueC-nonCash)
		changes[cashIdx] = max(0, tendered-amounts[cashIdx])
		if tendered < amounts[cashIdx]-tenderToleranceCents {
			reason = TenderShort
		}
	}
	var sum int64
	for _, a := range amounts {
		sum += a
	}
	if diff := dueC - sum; diff > 0 {
		amounts[len(amounts)-1] += diff
		if diff > tenderToleranceCents {
			reason = TenderShort
		}
	} else if diff < 0 {
		excess := -diff
		for i := len(amounts) - 1; i >= 0 && excess > 0; i-- {
			take := min(amounts[i], excess)
			amounts[i] -= take
			excess -= take
		}
		if -diff > tenderToleranceCents {
			reason = tenderReasonPriority(reason, TenderNoncashOverpay)
		}
	}
	rows := make([]tenderRow, len(lines))
	for i, l := range lines {
		rows[i] = tenderRow{Seq: i + 1, Method: l.Method, Amount: fromCents(amounts[i]),
			Tendered: fromCents(toCents(l.Amount)), Change: fromCents(changes[i]), Reference: l.Reference}
	}
	return rows, reason
}

// summarize derives the orders summary columns from the rows.
func summarize(rows []tenderRow, reason string) tenderSettlement {
	s := tenderSettlement{Rows: rows, PaymentMethod: rows[0].Method, Reason: reason}
	var paid, change int64
	for _, r := range rows {
		paid += toCents(r.Tendered)
		change += toCents(r.Change)
		if !strings.EqualFold(strings.TrimSpace(r.Method), strings.TrimSpace(rows[0].Method)) {
			s.PaymentMethod = splitMethodID
		}
	}
	s.AmountPaid, s.Change = fromCents(paid), fromCents(change)
	return s
}

// tenderWire decodes one payment line; pointers tell a missing amount from zero.
type tenderWire struct {
	Method    string   `json:"method"`
	Amount    *float64 `json:"amount"`
	Reference *string  `json:"reference"`
}

// isSplitID reports whether a method id is the reserved split sentinel. It folds exactly like
// Postgres lower() (which maps U+0130 to i, unlike strings.EqualFold), so the order_tenders
// CHECK can never trip inside the transaction on a value validation let through.
func isSplitID(m string) bool { return strings.ToLower(strings.TrimSpace(m)) == splitMethodID }

// hasNonPrintable reports a NUL or any other non-printable rune; Postgres rejects NUL in text
// (22021) inside the transaction, which would be a 500 and an endless batch retry.
func hasNonPrintable(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool { return !unicode.IsPrint(r) }) >= 0
}

func tenderInputError(reason string) error { return saleInputError("tenders", reason) }

// parseTenders decodes and structurally validates the raw tenders value. present is
// false when the key was absent (the legacy path). null, [] and a non-array are
// structural rejects, as are >4 lines, a negative/non-finite/oversize line, a zero line
// among two or more, a blank/oversize/`split` method, a reference over 64 printable
// runes and a Σ tendered over the money cap. One line keeps the legacy zero rule.
func parseTenders(raw json.RawMessage) (lines []TenderLine, present bool, err error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false, nil
	}
	var wire []tenderWire
	if bytes.Equal(trimmed, []byte("null")) || json.Unmarshal(trimmed, &wire) != nil {
		return nil, true, tenderInputError("harus berupa daftar pembayaran")
	}
	if len(wire) == 0 || len(wire) > maxTenderLines {
		return nil, true, tenderInputError(fmt.Sprintf("harus berisi 1 sampai %d baris pembayaran", maxTenderLines))
	}
	var sumC int64
	for i, w := range wire {
		l, e := validateTenderLine(i, w, len(wire) > 1)
		if e != nil {
			return nil, true, e
		}
		sumC += toCents(l.Amount)
		lines = append(lines, l)
	}
	if e := saleMoney("tenders.sum", fromCents(sumC)); e != nil {
		return nil, true, e
	}
	return lines, true, nil
}

func validateTenderLine(i int, w tenderWire, multi bool) (TenderLine, error) {
	field := fmt.Sprintf("tenders[%d]", i)
	method := strings.TrimSpace(w.Method)
	switch {
	case method == "":
		return TenderLine{}, saleInputError(field+".method", "wajib diisi")
	case utf8.RuneCountInString(method) > maxTenderMethodLen:
		return TenderLine{}, saleInputError(field+".method", "terlalu panjang")
	case hasNonPrintable(method):
		return TenderLine{}, saleInputError(field+".method", "tidak valid")
	case isSplitID(method):
		return TenderLine{}, saleInputError(field+".method", "memakai id yang dicadangkan")
	case w.Amount == nil:
		return TenderLine{}, saleInputError(field+".amount", "wajib berupa angka")
	}
	if err := saleMoney(field+".amount", *w.Amount); err != nil {
		return TenderLine{}, err
	}
	if multi && toCents(*w.Amount) == 0 {
		return TenderLine{}, saleInputError(field+".amount", "harus lebih dari nol")
	}
	ref := ""
	if w.Reference != nil {
		ref = *w.Reference
	}
	if utf8.RuneCountInString(ref) > maxTenderReferenceLn || hasNonPrintable(ref) {
		return TenderLine{}, saleInputError(field+".reference", "tidak valid")
	}
	return TenderLine{Method: w.Method, Amount: *w.Amount, Reference: ref}, nil
}

// settleSale judges a sale's tender after finalTotal: the tenders lines when present,
// else the legacy scalar as one line. The structure was validated by ValidateSaleInput.
func settleSale(in CreateOrderInput, due float64, isCash func(string) bool) (tenderSettlement, error) {
	mode := tenderOnline
	if in.Offline {
		mode = tenderBatch
	}
	lines, present, err := parseTenders(in.Tenders)
	if err != nil {
		return tenderSettlement{}, err
	}
	if !present {
		lines = []TenderLine{{Method: in.PaymentMethod, Amount: in.AmountPaid}}
	}
	return settleTenders(due, lines, isCash, mode)
}
