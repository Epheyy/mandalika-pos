package read

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

const (
	profileLastOrders    = 5
	profileFrequentItems = 3
	profileNotes         = 5
	profileNeverTried    = 3
	// profileGapOrders caps how many recent orders feed the median gap.
	profileGapOrders = 60
	// profileMinGapOrders is the fewest completed orders that give a usual interval.
	profileMinGapOrders = 3
	mergeChainDepth     = 10
	secondsPerDay       = 24 * 60 * 60
)

// CustomerProfileData is what the read layer knows; the handler adds the tier (a service
// rule) and the reward count (a service evaluation) before it answers.
type CustomerProfileData struct {
	Profile api.CustomerProfile
	// TotalSpend is the lifetime spend the tier is computed from.
	TotalSpend float64
}

// MedianGapDays is the median whole-day gap between consecutive order times, or nil when
// fewer than profileMinGapOrders orders exist or every order falls on one day. Input order
// does not matter. Even counts take the mean of the two middle gaps, rounded to a day.
func MedianGapDays(times []time.Time) *int {
	if len(times) < profileMinGapOrders {
		return nil
	}
	sorted := append([]time.Time(nil), times...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Before(sorted[j]) })
	gaps := make([]float64, 0, len(sorted)-1)
	for i := 1; i < len(sorted); i++ {
		gaps = append(gaps, sorted[i].Sub(sorted[i-1]).Seconds()/secondsPerDay)
	}
	sort.Float64s(gaps)
	mid := len(gaps) / 2
	median := gaps[mid]
	if len(gaps)%2 == 0 {
		median = (gaps[mid-1] + gaps[mid]) / 2
	}
	days := int(median + 0.5)
	if days < 1 {
		return nil
	}
	return &days
}

// resolveKeeper follows customers.merged_into to the live customer, depth capped so a
// corrupt cycle cannot loop. ErrNotFound when the id is unknown or the chain never ends.
func (r *Repo) resolveKeeper(ctx context.Context, id string) (string, error) {
	cur := id
	for i := 0; i <= mergeChainDepth; i++ {
		var mergedInto *string
		err := r.Pool.QueryRow(ctx, `SELECT merged_into::text FROM customers WHERE id=$1`, cur).Scan(&mergedInto)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		if err != nil {
			return "", fmt.Errorf("resolve keeper: %w", err)
		}
		if mergedInto == nil {
			return cur, nil
		}
		cur = *mergedInto
	}
	return "", ErrNotFound
}

// orderScopeSQL limits orders o to the caller's outlets: every outlet for a cross-outlet
// admin, else exactly the caller's own outlet (an empty outlet matches nothing).
const orderScopeSQL = `($2::bool OR o.outlet_id = NULLIF($3,'')::uuid)`

// CustomerProfile assembles the POS profile sheet for one customer (D-25). The customer
// row (identity, points, lifetime totals) is brand-wide like every customer read; the
// order-derived parts (last orders, frequent items, pitch) only see orders inside scope.
// Notes are CRM data: withNotes false (a cashier, A30) returns none.
func (r *Repo) CustomerProfile(ctx context.Context, id string, sc Scope, withNotes bool, phoneNorm string) (CustomerProfileData, error) {
	keeper, err := r.resolveKeeper(ctx, id)
	if err != nil {
		return CustomerProfileData{}, err
	}
	if !withNotes {
		// A30: a phone-only caller may only open a customer whose phone they hold. Ids leak to cashiers
		// (discount-code customerId, order customerId), so the id alone must never answer.
		var ok bool
		if err := r.Pool.QueryRow(ctx, `SELECT $2::text <> '' AND EXISTS (SELECT 1 FROM customers WHERE id = ANY($1::uuid[]) AND phone_norm = $2::text)`,
			[]string{id, keeper}, phoneNorm).Scan(&ok); err != nil {
			return CustomerProfileData{}, fmt.Errorf("profile phone gate: %w", err)
		}
		if !ok {
			return CustomerProfileData{}, ErrNotFound
		}
	}
	var out CustomerProfileData
	p := &out.Profile
	h := &p.Customer
	var spend float64
	err = r.Pool.QueryRow(ctx, `SELECT id::text, name, phone, points, total_spent::float8, visit_count, created_at
	    FROM customers WHERE id=$1 AND merged_into IS NULL`, keeper).
		Scan(&h.Id, &h.Name, &h.Phone, &h.Points, &spend, &h.OrderCount, &h.Since)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, fmt.Errorf("profile customer: %w", err)
	}
	h.TotalSpend = spend
	out.TotalSpend = spend

	if p.LastOrders, err = r.profileLastOrders(ctx, keeper, sc); err != nil {
		return out, err
	}
	if p.FrequentItems, err = r.profileFrequent(ctx, keeper, sc); err != nil {
		return out, err
	}
	p.Notes = []api.CustomerProfileNote{}
	if withNotes {
		if p.Notes, err = r.profileNotes(ctx, keeper); err != nil {
			return out, err
		}
	}
	if p.Pitch, err = r.profilePitch(ctx, keeper, sc, p.LastOrders); err != nil {
		return out, err
	}
	return out, nil
}

func (r *Repo) profileLastOrders(ctx context.Context, id string, sc Scope) ([]api.CustomerProfileOrder, error) {
	rows, err := r.Pool.Query(ctx, `SELECT o.id::text, o.order_number, COALESCE(o.client_created_at, o.created_at),
	    COALESCE(NULLIF(ou.code,''), ou.name), o.payment_method, o.total::float8
	  FROM orders o JOIN outlets ou ON ou.id = o.outlet_id
	  WHERE o.customer_id=$1 AND `+orderScopeSQL+` AND o.status='completed'
	  ORDER BY COALESCE(o.client_created_at, o.created_at) DESC, o.id DESC LIMIT $4`,
		id, sc.CrossAll, sc.OutletID, profileLastOrders)
	if err != nil {
		return nil, fmt.Errorf("profile orders: %w", err)
	}
	defer rows.Close()
	orders := []api.CustomerProfileOrder{}
	ids := []string{}
	for rows.Next() {
		var o api.CustomerProfileOrder
		if err := rows.Scan(&o.Id, &o.Number, &o.At, &o.OutletCode, &o.PaymentMethod, &o.Total); err != nil {
			return nil, fmt.Errorf("profile orders scan: %w", err)
		}
		o.Lines = []api.CustomerProfileOrderLine{}
		orders = append(orders, o)
		ids = append(ids, o.Id.String())
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return orders, nil
	}
	lr, err := r.Pool.Query(ctx, `SELECT order_id::text, product_id::text, product_name, variant_size, quantity, subtotal = 0
	  FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, subtotal DESC, id`, ids)
	if err != nil {
		return nil, fmt.Errorf("profile lines: %w", err)
	}
	defer lr.Close()
	byOrder := map[string]int{}
	for i, o := range orders {
		byOrder[o.Id.String()] = i
	}
	for lr.Next() {
		var oid string
		var l api.CustomerProfileOrderLine
		if err := lr.Scan(&oid, &l.ProductId, &l.Name, &l.Size, &l.Qty, &l.Free); err != nil {
			return nil, fmt.Errorf("profile lines scan: %w", err)
		}
		i := byOrder[oid]
		orders[i].Lines = append(orders[i].Lines, l)
	}
	return orders, lr.Err()
}

func (r *Repo) profileFrequent(ctx context.Context, id string, sc Scope) ([]api.CustomerProfileFrequentItem, error) {
	rows, err := r.Pool.Query(ctx, `SELECT oi.product_id::text, oi.variant_size, (array_agg(oi.product_name ORDER BY COALESCE(o.client_created_at, o.created_at) DESC))[1],
	    sum(oi.quantity)::int AS n
	  FROM order_items oi JOIN orders o ON o.id = oi.order_id
	  WHERE o.customer_id=$1 AND `+orderScopeSQL+` AND o.status='completed'
	    AND oi.subtotal > 0 AND COALESCE(o.client_created_at, o.created_at) >= now() - interval '12 months'
	  GROUP BY oi.product_id, oi.variant_size
	  ORDER BY n DESC, max(COALESCE(o.client_created_at, o.created_at)) DESC, oi.product_id, oi.variant_size LIMIT $4`,
		id, sc.CrossAll, sc.OutletID, profileFrequentItems)
	if err != nil {
		return nil, fmt.Errorf("profile frequent: %w", err)
	}
	defer rows.Close()
	out := []api.CustomerProfileFrequentItem{}
	for rows.Next() {
		var f api.CustomerProfileFrequentItem
		if err := rows.Scan(&f.ProductId, &f.Size, &f.Name, &f.Count); err != nil {
			return nil, fmt.Errorf("profile frequent scan: %w", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *Repo) profileNotes(ctx context.Context, id string) ([]api.CustomerProfileNote, error) {
	rows, err := r.Pool.Query(ctx, `SELECT interaction_date, COALESCE(note,''), type
	  FROM customer_interactions WHERE customer_id=$1
	  ORDER BY interaction_date DESC, created_at DESC LIMIT $2`, id, profileNotes)
	if err != nil {
		return nil, fmt.Errorf("profile notes: %w", err)
	}
	defer rows.Close()
	out := []api.CustomerProfileNote{}
	for rows.Next() {
		var n api.CustomerProfileNote
		var kind string
		var at time.Time
		if err := rows.Scan(&at, &n.Text, &kind); err != nil {
			return nil, fmt.Errorf("profile notes scan: %w", err)
		}
		n.At.Time = at
		n.Kind = api.CustomerProfileNoteKind(kind)
		out = append(out, n)
	}
	return out, rows.Err()
}

func (r *Repo) profilePitch(ctx context.Context, id string, sc Scope, last []api.CustomerProfileOrder) (api.CustomerProfilePitch, error) {
	pitch := api.CustomerProfilePitch{NeverTriedCategories: []string{}}
	// nullable.Nullable marshals an unset value as its zero value, so say null explicitly.
	pitch.LastAt.SetNull()
	pitch.LastItem.SetNull()
	pitch.UsualIntervalDays.SetNull()
	if len(last) > 0 {
		at := last[0].At
		pitch.LastAt.Set(at)
		for _, l := range last[0].Lines {
			if !l.Free {
				pitch.LastItem.Set(l.Name)
				break
			}
		}
	}
	rows, err := r.Pool.Query(ctx, `SELECT COALESCE(o.client_created_at, o.created_at)
	  FROM orders o WHERE o.customer_id=$1 AND `+orderScopeSQL+` AND o.status='completed'
	  ORDER BY COALESCE(o.client_created_at, o.created_at) DESC LIMIT $4`,
		id, sc.CrossAll, sc.OutletID, profileGapOrders)
	if err != nil {
		return pitch, fmt.Errorf("profile gaps: %w", err)
	}
	defer rows.Close()
	var times []time.Time
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err != nil {
			return pitch, fmt.Errorf("profile gaps scan: %w", err)
		}
		times = append(times, t)
	}
	if err := rows.Err(); err != nil {
		return pitch, err
	}
	if d := MedianGapDays(times); d != nil {
		pitch.UsualIntervalDays.Set(*d)
	}
	cats, err := r.Pool.Query(ctx, `SELECT c.name FROM categories c
	  WHERE EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.is_active AND p.sellable)
	    AND NOT EXISTS (
	      SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
	      JOIN products p ON p.id = oi.product_id
	      WHERE o.customer_id=$1 AND `+orderScopeSQL+` AND o.status='completed'
	        AND oi.subtotal > 0 AND p.category_id = c.id)
	  ORDER BY c.sort_order NULLS LAST, c.name, c.id LIMIT $4`,
		id, sc.CrossAll, sc.OutletID, profileNeverTried)
	if err != nil {
		return pitch, fmt.Errorf("profile categories: %w", err)
	}
	defer cats.Close()
	for cats.Next() {
		var name string
		if err := cats.Scan(&name); err != nil {
			return pitch, fmt.Errorf("profile categories scan: %w", err)
		}
		pitch.NeverTriedCategories = append(pitch.NeverTriedCategories, name)
	}
	return pitch, cats.Err()
}
