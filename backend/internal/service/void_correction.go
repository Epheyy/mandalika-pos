package service

import "sort"

// tenderAmount is one payment method's total on a sale.
type tenderAmount struct {
	Method string
	Amount int64
}

// shiftCorrection is one append-only correction row for a closed shift: kind 'void' carries the
// negative of an original sale's money per method, kind 'replacement' the positive of its
// replacement's.
type shiftCorrection struct {
	Kind, OrderID, Method string
	Amount                int64
}

// shiftCorrectionRows turns the original's and the replacement's tenders into correction rows:
// void rows (−sum per method, ordered by method) then replacement rows (+sum per method). Zero sums
// are dropped. A caller passes only the side whose delta rule holds (voidCountedInClose /
// replacementNeedsDelta), so either side may be nil.
func shiftCorrectionRows(origID string, orig []tenderAmount, replID string, repl []tenderAmount) []shiftCorrection {
	rows := sideRows("void", origID, orig, -1)
	return append(rows, sideRows("replacement", replID, repl, 1)...)
}

func sideRows(kind, orderID string, tenders []tenderAmount, sign int64) []shiftCorrection {
	sums := map[string]int64{}
	for _, t := range tenders {
		sums[t.Method] += t.Amount
	}
	methods := make([]string, 0, len(sums))
	for m, sum := range sums {
		if sum != 0 {
			methods = append(methods, m)
		}
	}
	sort.Strings(methods)
	rows := make([]shiftCorrection, 0, len(methods))
	for _, m := range methods {
		rows = append(rows, shiftCorrection{Kind: kind, OrderID: orderID, Method: m, Amount: sign * sums[m]})
	}
	return rows
}

// correctionAmount is the signed "Penyesuaian koreksi": the corrected price minus what the cart
// priced to. Negative means the store received less than the corrected price.
func correctionAmount(target, priced int64) int64 { return target - priced }
