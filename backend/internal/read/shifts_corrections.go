package read

import (
	"context"
	"math"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/rules"
)

// correctedBuckets adds a closed shift's per-method corrections to its frozen close snapshot,
// with the same bucket rule as CloseShiftTx: cash method ids first; card, transfer and qris only
// when not cash; a custom non-cash method lands in no bucket but still in the total. The snapshot
// itself is never rewritten.
func correctedBuckets(s api.Shift, byMethod map[string]int64, isCash func(string) bool) (cash, card, transfer, qris, total int64) {
	cash, card, transfer = roundMoney(s.CashSales), roundMoney(s.CardSales), roundMoney(s.TransferSales)
	qris, total = roundMoney(s.QrisSales), roundMoney(s.TotalSales)
	for method, delta := range byMethod {
		total += delta
		switch {
		case isCash(method):
			cash += delta
		case method == "card":
			card += delta
		case method == "transfer":
			transfer += delta
		case method == "qris":
			qris += delta
		}
	}
	return cash, card, transfer, qris, total
}

func roundMoney(v float64) int64 { return int64(math.Round(v)) }

// fillShiftCorrections sets corrections and the corrected* figures on closed shifts that have
// correction rows. Open shifts and shifts without corrections are left as they are.
func (r *Repo) fillShiftCorrections(ctx context.Context, shifts []api.Shift) error {
	var closed []string
	index := map[string]int{}
	for i := range shifts {
		if shifts[i].Status == api.ShiftStatusClosed {
			id := uuid.UUID(shifts[i].Id).String()
			closed = append(closed, id)
			index[id] = i
		}
	}
	if len(closed) == 0 {
		return nil
	}
	rows, err := r.Pool.Query(ctx,
		`SELECT c.shift_id::text, c.void_id::text, c.order_id::text, o.order_number, c.kind, c.method, c.amount::float8, c.created_at
		   FROM shift_corrections c JOIN orders o ON o.id = c.order_id
		  WHERE c.shift_id = ANY($1::uuid[])
		  ORDER BY c.created_at, c.kind DESC, c.method`, closed)
	if err != nil {
		return err
	}
	defer rows.Close()
	type acc struct {
		items    []api.ShiftCorrectionItem
		byMethod map[string]int64
		voids    map[string]bool
		out, in  map[string]bool
	}
	per := map[string]*acc{}
	for rows.Next() {
		var shiftID, voidID, orderID string
		var it api.ShiftCorrectionItem
		if err := rows.Scan(&shiftID, &voidID, &orderID, &it.OrderNumber, &it.Kind, &it.Method, &it.Amount, &it.CreatedAt); err != nil {
			return err
		}
		it.VoidId, it.OrderId = openapi_types.UUID(uuid.MustParse(voidID)), openapi_types.UUID(uuid.MustParse(orderID))
		a := per[shiftID]
		if a == nil {
			a = &acc{byMethod: map[string]int64{}, voids: map[string]bool{}, out: map[string]bool{}, in: map[string]bool{}}
			per[shiftID] = a
		}
		a.items = append(a.items, it)
		a.byMethod[it.Method] += roundMoney(float64(it.Amount))
		a.voids[voidID] = true
		if it.Kind == api.ShiftCorrectionItemKindVoid {
			a.out[orderID] = true
		} else {
			a.in[orderID] = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if len(per) == 0 {
		return nil
	}
	settings, err := r.AppSettings(ctx)
	if err != nil {
		return err
	}
	isCash := func(m string) bool { return rules.IsCashMethod(settings.PaymentMethods, m) }
	for id, a := range per {
		s := &shifts[index[id]]
		by := make(map[string]float64, len(a.byMethod))
		for m, v := range a.byMethod {
			by[m] = float64(v)
		}
		s.Corrections = &api.ShiftCorrections{Count: len(a.voids), ByMethod: by, Items: a.items}
		cash, card, transfer, qris, total := correctedBuckets(*s, a.byMethod, isCash)
		orders := s.TotalOrders - len(a.out) + len(a.in)
		c, cd, tr, q, t := float64(cash), float64(card), float64(transfer), float64(qris), float64(total)
		s.CorrectedCashSales, s.CorrectedCardSales, s.CorrectedTransferSales, s.CorrectedQrisSales, s.CorrectedTotalSales = &c, &cd, &tr, &q, &t
		s.CorrectedTotalOrders = &orders
	}
	return nil
}
