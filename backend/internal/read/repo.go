package read

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/api"
)

var ErrNotFound = errors.New("not found")

type Repo struct{ Pool *pgxpool.Pool }

func New(p *pgxpool.Pool) *Repo { return &Repo{Pool: p} }

// Scope is the resolved outlet boundary for outlet-scoped tables.
// CrossAll = admin requested every outlet; OutletID = the single active outlet.
type Scope struct {
	CrossAll bool
	OutletID string
}

// listJSON runs a query whose first column is a per-row JSON object and whose
// optional second column is a window total; unmarshals each row into T.
func listJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) ([]T, int, error) {
	rows, err := p.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()
	out := []T{}
	total := 0
	for rows.Next() {
		var raw []byte
		if len(rows.FieldDescriptions()) > 1 {
			if err := rows.Scan(&raw, &total); err != nil {
				return nil, 0, fmt.Errorf("scan: %w", err)
			}
		} else if err := rows.Scan(&raw); err != nil {
			return nil, 0, fmt.Errorf("scan: %w", err)
		}
		var v T
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, 0, fmt.Errorf("unmarshal: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(rows.FieldDescriptions()) <= 1 {
		total = len(out)
	}
	return out, total, nil
}

func oneJSON[T any](ctx context.Context, p *pgxpool.Pool, sql string, args ...any) (T, error) {
	var v T
	var raw []byte
	err := p.QueryRow(ctx, sql, args...).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, fmt.Errorf("query: %w", err)
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return v, fmt.Errorf("unmarshal: %w", err)
	}
	return v, nil
}

func off(page, limit int) int {
	if page < 1 {
		page = 1
	}
	return (page - 1) * limit
}

// ── Catalog ───────────────────────────────────────────────

const productObj = `json_build_object(
  'id',p.id,'name',p.name,'brand',p.brand,'categoryId',p.category_id,
  'description',p.description,'imageUrl',p.image_url,
  'isFeatured',p.is_featured,'isFavourite',p.is_favourite,'isActive',p.is_active,
  'createdAt',p.created_at,
  'variants',COALESCE((SELECT json_agg(json_build_object(
     'size',v.size,'price',v.price,'stock',v.stock,'sku',v.sku) ORDER BY v.size)
     FROM product_variants v WHERE v.product_id=p.id),'[]'::json))`

func (r *Repo) Products(ctx context.Context, page, limit int) ([]api.Product, int, error) {
	return listJSON[api.Product](ctx, r.Pool,
		`SELECT `+productObj+`, count(*) OVER() AS total
		   FROM products p ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}

func (r *Repo) Product(ctx context.Context, id string) (api.Product, error) {
	return oneJSON[api.Product](ctx, r.Pool,
		`SELECT `+productObj+` FROM products p WHERE p.id=$1`, id)
}

func (r *Repo) Categories(ctx context.Context) ([]api.Category, int, error) {
	return listJSON[api.Category](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'description',description,
		   'sortOrder',sort_order) FROM categories ORDER BY sort_order NULLS LAST, name`)
}

func (r *Repo) Bundles(ctx context.Context) ([]api.Bundle, int, error) {
	return listJSON[api.Bundle](ctx, r.Pool,
		`SELECT json_build_object('id',b.id,'name',b.name,'description',b.description,
		   'price',b.price,'imageUrl',b.image_url,'isActive',b.is_active,
		   'createdAt',b.created_at,
		   'items',COALESCE((SELECT json_agg(json_build_object(
		     'productId',i.product_id,'productName',i.product_name,
		     'variantSize',i.variant_size,'quantity',i.quantity,'price',i.price))
		     FROM bundle_items i WHERE i.bundle_id=b.id),'[]'::json))
		   FROM bundles b ORDER BY b.created_at DESC`)
}

func (r *Repo) Outlets(ctx context.Context) ([]api.Outlet, int, error) {
	return listJSON[api.Outlet](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'code',code,'address',address,
		   'phone',phone,'isActive',is_active,'createdAt',created_at)
		   FROM outlets ORDER BY name`)
}

// ── Customers ─────────────────────────────────────────────

const customerObj = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'createdAt',created_at)`

func (r *Repo) Customers(ctx context.Context, page, limit int) ([]api.Customer, int, error) {
	return listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total
		   FROM customers ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}

func (r *Repo) Customer(ctx context.Context, id string) (api.Customer, error) {
	return oneJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+` FROM customers WHERE id=$1`, id)
}

// ── Promotions / loyalty ──────────────────────────────────

func (r *Repo) Promotions(ctx context.Context) ([]api.Promotion, int, error) {
	return listJSON[api.Promotion](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'description',description,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'applicableProductIds',applicable_product_ids,
		   'applicableVariantKeys',applicable_variant_keys,
		   'applicableVariantSizes',applicable_variant_sizes,
		   'outletIds',outlet_ids,'combinable',combinable,
		   'combinableWith',combinable_with,'activeFromHour',active_from_hour,
		   'activeToHour',active_to_hour,'activeDays',active_days,
		   'isActive',is_active,'startDate',start_date,'endDate',end_date,
		   'createdAt',created_at) FROM promotions ORDER BY created_at DESC`)
}

func (r *Repo) DiscountCodes(ctx context.Context) ([]api.DiscountCode, int, error) {
	return listJSON[api.DiscountCode](ctx, r.Pool,
		`SELECT json_build_object('id',id,'code',code,'promotionId',promotion_id,
		   'type',type,'value',value,'minPurchase',min_purchase,
		   'usageLimit',usage_limit,'usageCount',usage_count,'isActive',is_active,
		   'startDate',start_date,'endDate',end_date,'createdAt',created_at)
		   FROM discount_codes ORDER BY created_at DESC`)
}

func (r *Repo) LoyaltyConditions(ctx context.Context) ([]api.LoyaltyCondition, int, error) {
	return listJSON[api.LoyaltyCondition](ctx, r.Pool,
		`SELECT json_build_object('id',id,'name',name,'type',type,'trigger',trigger,
		   'rewardType',reward_type,'rewardValue',reward_value,
		   'rewardProductIds',reward_product_ids,
		   'campaignStartDate',campaign_start_date,'campaignEndDate',campaign_end_date,
		   'activeDays',active_days,'applicableProductIds',applicable_product_ids,
		   'minimumSpend',minimum_spend,'isActive',is_active,'createdAt',created_at)
		   FROM loyalty_conditions ORDER BY created_at DESC`)
}

func (r *Repo) LoyaltySettings(ctx context.Context) (api.LoyaltySettings, error) {
	return oneJSON[api.LoyaltySettings](ctx, r.Pool,
		`SELECT json_build_object('enabled',enabled,'tierEnabled',tier_enabled,
		   'pointsPerThousand',points_per_thousand,'redemptionRate',redemption_rate)
		   FROM loyalty_settings WHERE id=1`)
}

func (r *Repo) AppSettings(ctx context.Context) (api.AppSettings, error) {
	return oneJSON[api.AppSettings](ctx, r.Pool,
		`SELECT json_build_object('taxEnabled',tax_enabled,'taxRate',tax_rate,
		   'roundingEnabled',rounding_enabled,'roundingType',rounding_type,
		   'roundingAmount',rounding_amount,'roundingDirection',rounding_direction,
		   'roundingApplyToTax',rounding_apply_to_tax,'autoOpenShift',auto_open_shift,
		   'paymentMethods',payment_methods,'receipt',receipt)
		   FROM app_settings WHERE id=1`)
}

func (r *Repo) CustomRoles(ctx context.Context) ([]api.CustomRole, int, error) {
	return listJSON[api.CustomRole](ctx, r.Pool,
		`SELECT json_build_object('id',cr.id,'name',cr.name,'createdAt',cr.created_at,
		   'permissions',COALESCE((SELECT json_agg(permission)
		     FROM custom_role_permissions WHERE role_id=cr.id),'[]'::json))
		   FROM custom_roles cr ORDER BY cr.name`)
}

// ── Users ─────────────────────────────────────────────────

const userObj = `json_build_object('id',u.id,'email',u.email,
  'displayName',u.display_name,'role',u.role,'outletId',u.outlet_id,
  'photoURL',u.photo_url,'createdAt',u.created_at,
  'permissions',COALESCE((SELECT json_agg(permission)
    FROM user_permissions WHERE user_id=u.id),'[]'::json))`

func (r *Repo) Users(ctx context.Context, page, limit int) ([]api.User, int, error) {
	return listJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+`, count(*) OVER() AS total
		   FROM users u ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`,
		limit, off(page, limit))
}

func (r *Repo) User(ctx context.Context, id string) (api.User, error) {
	return oneJSON[api.User](ctx, r.Pool,
		`SELECT `+userObj+` FROM users u WHERE u.id=$1`, id)
}

// ── Sales (outlet-scoped) ─────────────────────────────────

const orderObj = `json_build_object('id',o.id,'orderNumber',o.order_number,
  'outletId',o.outlet_id,'cashierId',o.cashier_id,'cashierName',o.cashier_name,
  'salesmanId',o.salesman_id,'salesmanName',o.salesman_name,
  'customerId',o.customer_id,'customerName',o.customer_name,
  'subtotal',o.subtotal,'discountAmount',o.discount_amount,
  'discountType',o.discount_type,'discountValue',o.discount_value,
  'discountCode',o.discount_code,
  'surchargeType',o.surcharge_type,'surchargeValue',o.surcharge_value,
  'surchargeAmount',o.surcharge_amount,
  'taxAmount',o.tax_amount,'total',o.total,
  'paymentMethod',o.payment_method,'amountPaid',o.amount_paid,'change',o.change,
  'status',o.status,'notes',o.notes,'refundReason',o.refund_reason,
  'refundedAt',o.refunded_at,'shiftId',o.shift_id,'createdAt',o.created_at,
  'pointsRedeemed',o.points_redeemed,
  'items',COALESCE((SELECT json_agg(json_build_object(
     'productId',it.product_id,'productName',it.product_name,
     'variantSize',it.variant_size,'price',it.price,'quantity',it.quantity,
     'subtotal',it.subtotal,'isBundle',it.is_bundle))
     FROM order_items it WHERE it.order_id=o.id),'[]'::json))`

func (r *Repo) Orders(ctx context.Context, sc Scope, shiftID, customerID, from, to, q string, page, limit int) ([]api.Order, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		where += fmt.Sprintf(" AND o.outlet_id=$%d", len(args))
	}
	if shiftID != "" {
		args = append(args, shiftID)
		where += fmt.Sprintf(" AND o.shift_id=$%d", len(args))
	}
	if customerID != "" {
		args = append(args, customerID)
		where += fmt.Sprintf(" AND o.customer_id=$%d", len(args))
	}
	if from != "" {
		args = append(args, from)
		where += fmt.Sprintf(" AND o.created_at >= $%d", len(args))
	}
	if to != "" {
		args = append(args, to)
		where += fmt.Sprintf(" AND o.created_at < ($%d::date + interval '1 day')", len(args))
	}
	if q != "" {
		args = append(args, "%"+q+"%")
		// Match order number, the order's stored customer name, or the
		// linked customer's phone/name.
		where += fmt.Sprintf(` AND (o.order_number ILIKE $%d OR o.customer_name ILIKE $%d
		  OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id
		    AND (c.phone ILIKE $%d OR c.name ILIKE $%d)))`,
			len(args), len(args), len(args), len(args))
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM orders o %s
	  ORDER BY o.created_at DESC LIMIT $%d OFFSET $%d`,
		orderObj, where, len(args)-1, len(args))
	return listJSON[api.Order](ctx, r.Pool, sql, args...)
}

func (r *Repo) Order(ctx context.Context, sc Scope, id string) (api.Order, error) {
	args := []any{id}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND o.outlet_id=$2"
	}
	return oneJSON[api.Order](ctx, r.Pool,
		`SELECT `+orderObj+` FROM orders o WHERE o.id=$1`+cond, args...)
}

const shiftObj = `json_build_object('id',s.id,'outletId',s.outlet_id,
  'outletName',s.outlet_name,'cashierId',s.cashier_id,'cashierName',s.cashier_name,
  'status',s.status,'openedAt',s.opened_at,'closedAt',s.closed_at,
  'startingCash',s.starting_cash,'closingCash',s.closing_cash,
  'totalSales',s.total_sales,'totalOrders',s.total_orders,
  'totalRefunds',s.total_refunds,'cashSales',s.cash_sales,'cardSales',s.card_sales,
  'transferSales',s.transfer_sales,'qrisSales',s.qris_sales,
  'countedByMethod',s.counted_by_method)`

func (r *Repo) Shifts(ctx context.Context, sc Scope, page, limit int) ([]api.Shift, int, error) {
	where := ""
	args := []any{}
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		where = "WHERE s.outlet_id=$1"
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM shifts s %s
	  ORDER BY s.opened_at DESC LIMIT $%d OFFSET $%d`,
		shiftObj, where, len(args)-1, len(args))
	return listJSON[api.Shift](ctx, r.Pool, sql, args...)
}

func (r *Repo) Shift(ctx context.Context, sc Scope, id string) (api.Shift, error) {
	args := []any{id}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND s.outlet_id=$2"
	}
	return oneJSON[api.Shift](ctx, r.Pool,
		`SELECT `+shiftObj+` FROM shifts s WHERE s.id=$1`+cond, args...)
}

// CurrentShift returns the open shift for the active outlet, or ErrNotFound.
func (r *Repo) CurrentShift(ctx context.Context, sc Scope) (api.Shift, error) {
	args := []any{}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND s.outlet_id=$1"
	}
	return oneJSON[api.Shift](ctx, r.Pool,
		`SELECT `+shiftObj+` FROM shifts s WHERE s.status='open'`+cond+
			` ORDER BY s.opened_at DESC LIMIT 1`, args...)
}

const stockCountObj = `json_build_object('id',sc.id,'name',sc.name,
  'status',sc.status,'outletId',sc.outlet_id,'plannedDate',sc.planned_date,
  'startedAt',sc.started_at,'completedAt',sc.completed_at,'notes',sc.notes,
  'createdBy',sc.created_by,'createdAt',sc.created_at,
  'items',COALESCE((SELECT json_agg(json_build_object(
     'productId',i.product_id,'productName',i.product_name,
     'variantSize',i.variant_size,'sku',i.sku,'frozenQty',i.frozen_qty,
     'actualQty',i.actual_qty,'difference',i.difference))
     FROM stock_count_items i WHERE i.stock_count_id=sc.id),'[]'::json))`

func (r *Repo) StockCounts(ctx context.Context, s Scope, page, limit int) ([]api.StockCount, int, error) {
	where := ""
	args := []any{}
	if !s.CrossAll {
		args = append(args, s.OutletID)
		where = "WHERE sc.outlet_id=$1"
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM stock_counts sc %s
	  ORDER BY sc.created_at DESC LIMIT $%d OFFSET $%d`,
		stockCountObj, where, len(args)-1, len(args))
	return listJSON[api.StockCount](ctx, r.Pool, sql, args...)
}

func (r *Repo) StockCount(ctx context.Context, s Scope, id string) (api.StockCount, error) {
	args := []any{id}
	cond := ""
	if !s.CrossAll {
		args = append(args, s.OutletID)
		cond = " AND sc.outlet_id=$2"
	}
	return oneJSON[api.StockCount](ctx, r.Pool,
		`SELECT `+stockCountObj+` FROM stock_counts sc WHERE sc.id=$1`+cond, args...)
}

func (r *Repo) CashFlows(ctx context.Context, s Scope, shiftID string, page, limit int) ([]api.CashFlow, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if !s.CrossAll {
		args = append(args, s.OutletID)
		where += fmt.Sprintf(" AND cf.outlet_id=$%d", len(args))
	}
	if shiftID != "" {
		args = append(args, shiftID)
		where += fmt.Sprintf(" AND cf.shift_id=$%d", len(args))
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT json_build_object('id',cf.id,'outletId',cf.outlet_id,
	  'shiftId',cf.shift_id,'type',cf.type,'amount',cf.amount,
	  'description',cf.description,'cashierId',cf.cashier_id,
	  'cashierName',cf.cashier_name,'createdAt',cf.created_at),
	  count(*) OVER() AS total FROM cash_flows cf %s
	  ORDER BY cf.created_at DESC LIMIT $%d OFFSET $%d`,
		where, len(args)-1, len(args))
	return listJSON[api.CashFlow](ctx, r.Pool, sql, args...)
}
