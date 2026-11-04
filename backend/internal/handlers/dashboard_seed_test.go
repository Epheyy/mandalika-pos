package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The Ringkasan parity fixture lives in tests/fixtures/dashboard-parity and is shared with the
// backoffice vitest suite (see docs/plans/2026-11-04-ringkasan-dashboard-aggregate.md).

type dpOutlet struct{ Key, ID, Name, Timezone string }
type dpCashier struct{ Key, ID, Name, Outlet string }
type dpCustomer struct{ Key, ID, Name, Phone string }
type dpItem struct {
	ID, ProductID, ProductName, VariantSize string
	Quantity                                int
	Price, Subtotal                         float64
}
type dpTender struct {
	Method           string
	Amount, Tendered float64
}
type dpRefundItem struct {
	Line, Qty int
	Amount    float64
}
type dpRefund struct {
	ID, Scope, Method, At, Day string
	Seq                        int
	Amount                     float64
	Items                      []dpRefundItem
}
type dpLegacy struct{ At, Day string }
type dpOrder struct {
	N                                       int
	ID, OrderNumber, Outlet, Cashier        string
	Customer                                *string
	CreatedAt, BusinessDate, Status, Method string
	Subtotal, DiscountAmount, Total         float64
	DiscountLabel                           *string
	BreakdownJSON                           *string `json:"breakdownJson"`
	Items                                   []dpItem
	Tenders                                 []dpTender
	Refunds                                 []dpRefund
	Legacy                                  *dpLegacy
}
type dpSeed struct {
	Outlets    []dpOutlet
	Cashiers   []dpCashier
	Customers  []dpCustomer
	Promotions []string
	Orders     []dpOrder
}
type dpScenario struct {
	Name, Now, Period, Scope string
	Params                   map[string]any
	OrdersWindow             map[string]string
}

func dpFixtureDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the fixture directory")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "tests", "fixtures", "dashboard-parity")
}

func dpLoad(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dpFixtureDir(t), name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

// dpSeedDB writes the fixture the way production rows look: an order is inserted as a completed
// sale, its refund rows follow, and only then does its status flip (a row inserted already
// `refunded` would trigger the legacy full-refund row and the business-date stamping).
func dpSeedDB(ctx context.Context, t *testing.T, pool *pgxpool.Pool, s dpSeed) {
	t.Helper()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	outletID, cashierName, cashierID := map[string]string{}, map[string]string{}, map[string]string{}
	custID, custName := map[string]string{}, map[string]string{}
	for _, o := range s.Outlets {
		exec(`INSERT INTO outlets(id,name,timezone) VALUES($1,$2,$3)`, o.ID, o.Name, o.Timezone)
		outletID[o.Key] = o.ID
	}
	for _, c := range s.Cashiers {
		cashierID[c.Key], cashierName[c.Key] = c.ID, c.Name
	}
	for _, c := range s.Customers {
		exec(`INSERT INTO customers(id,name,phone) VALUES($1,$2,$3)`, c.ID, c.Name, c.Phone)
		custID[c.Key], custName[c.Key] = c.ID, c.Name
	}
	for _, name := range s.Promotions {
		exec(`INSERT INTO promotions(name,type,value) VALUES($1,'percentage',10)`, name)
	}
	for _, o := range s.Orders {
		insertStatus := "completed"
		if o.Status == "cancelled" {
			insertStatus = "cancelled"
		}
		var cust, custNm *string
		if o.Customer != nil {
			id, nm := custID[*o.Customer], custName[*o.Customer]
			cust, custNm = &id, &nm
		}
		exec(`INSERT INTO orders(id,order_number,order_uuid,idempotency_key,outlet_id,cashier_id,cashier_name,customer_id,customer_name,
		        subtotal,discount_amount,discount_label,discount_breakdown,total,payment_method,amount_paid,status,created_at,business_date)
		      VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$13,$15,$16,$17::text::date)`,
			o.ID, o.OrderNumber, "dp:"+o.OrderNumber, outletID[o.Outlet], cashierID[o.Cashier], cashierName[o.Cashier], cust, custNm,
			o.Subtotal, o.DiscountAmount, o.DiscountLabel, o.BreakdownJSON, o.Total, o.Method, insertStatus, o.CreatedAt, o.BusinessDate)
		for i, it := range o.Items {
			exec(`INSERT INTO order_items(id,order_id,product_id,product_name,variant_size,price,quantity,subtotal,line_no,net_amount)
			      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`, it.ID, o.ID, it.ProductID, it.ProductName, it.VariantSize, it.Price, it.Quantity, it.Subtotal, i+1)
		}
		for i, tn := range o.Tenders {
			exec(`INSERT INTO order_tenders(order_id,seq,method,amount,tendered) VALUES($1,$2,$3,$4,$5)`, o.ID, i+1, tn.Method, tn.Amount, tn.Tendered)
		}
		for _, r := range o.Refunds {
			exec(`INSERT INTO order_refunds(id,order_id,outlet_id,seq,scope,amount,computed_amount,payment_method,reason,ledger_document_key,refunded_at,refund_business_date)
			      VALUES($1,$2,$3,$4,$5,$6,$6,$7,'fixture',$10,$8,$9::text::date)`,
				r.ID, o.ID, outletID[o.Outlet], r.Seq, r.Scope, r.Amount, r.Method, r.At, r.Day, "refund:"+r.ID)
			for _, ri := range r.Items {
				exec(`INSERT INTO order_refund_items(refund_id,order_item_id,quantity,amount,restocked) VALUES($1,$2,$3,$4,false)`,
					r.ID, o.Items[ri.Line].ID, ri.Qty, ri.Amount)
			}
		}
		if o.Legacy != nil {
			// What the catch-up trigger would add (scope legacy_full, every line), with a fixed id so the order dumps are stable.
			rid := fmt.Sprintf("00000000-0000-4000-8e06-%012d", o.N*10)
			exec(`INSERT INTO order_refunds(id,order_id,outlet_id,seq,scope,amount,computed_amount,payment_method,reason,ledger_document_key,refunded_at,refund_business_date)
			      VALUES($1,$2,$3,1,'legacy_full',$4,$4,$5,'',$6,$7,$8::text::date)`,
				rid, o.ID, outletID[o.Outlet], o.Total, o.Method, "refund:"+o.ID, o.Legacy.At, o.Legacy.Day)
			for _, it := range o.Items {
				exec(`INSERT INTO order_refund_items(refund_id,order_item_id,quantity,amount,restocked) VALUES($1,$2,$3,$4,false)`, rid, it.ID, it.Quantity, it.Subtotal)
			}
		}
		switch {
		case o.Legacy != nil:
			exec(`UPDATE orders SET status='refunded', refunded_at=$2, refund_business_date=$3::text::date WHERE id=$1`, o.ID, o.Legacy.At, o.Legacy.Day)
		case o.Status == "refunded":
			last := o.Refunds[len(o.Refunds)-1]
			exec(`UPDATE orders SET status='refunded', refunded_at=$2, refund_business_date=$3::text::date WHERE id=$1`, o.ID, last.At, last.Day)
		case o.Status == "partially_refunded":
			exec(`UPDATE orders SET status='partially_refunded' WHERE id=$1`, o.ID)
		}
	}
}
