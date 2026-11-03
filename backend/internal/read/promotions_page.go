package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// promoBusinessDay is "today" for the derived promo status. The client derives the same badge from
// the business day, so a server-side status filter and the badges agree.
const promoBusinessDay = `(now() AT TIME ZONE 'Asia/Jakarta')::date`

// PromoStatuses are the values of the status filter of the promotion and discount-code lists.
var PromoStatuses = []string{"aktif", "terjadwal", "berakhir", "nonaktif"}

// promoStatusWhere is the predicate of one derived status over is_active / start_date / end_date,
// in the precedence the badge uses: inactive first, then ended, then not yet started, else active.
// The argument is one of PromoStatuses (callers validate); anything else matches nothing.
func promoStatusWhere(status string) string {
	switch status {
	case "nonaktif":
		return `NOT is_active`
	case "berakhir":
		return `is_active AND end_date < ` + promoBusinessDay
	case "terjadwal":
		return `is_active AND (end_date IS NULL OR end_date >= ` + promoBusinessDay + `) AND start_date > ` + promoBusinessDay
	case "aktif":
		return `is_active AND (end_date IS NULL OR end_date >= ` + promoBusinessDay + `)
		  AND (start_date IS NULL OR start_date <= ` + promoBusinessDay + `)`
	}
	return `false`
}

// PromoListFilter narrows the promotion and discount-code lists; empty fields match everything.
type PromoListFilter struct {
	Q, Status, Type string
	// SearchHolder lets a discount-code search also match the holder's name. Only for callers who may
	// see it (manage_promotions): otherwise the search would reveal what WithoutCustomerNames hides.
	SearchHolder bool
}

// IsZero reports whether no filter is set.
func (f PromoListFilter) IsZero() bool { return f.Q == "" && f.Status == "" && f.Type == "" }

// PromotionsPage is Promotions plus the backoffice filters and paging. Promotions stays as it is:
// the tablet pull calls it directly. limit 0 returns every match, unpaged.
func (r *Repo) PromotionsPage(ctx context.Context, f PromoListFilter, page, limit int) ([]api.Promotion, int, error) {
	var args []any
	where := `true`
	if f.Q != "" {
		args = append(args, likePattern(f.Q))
		where += fmt.Sprintf(` AND (name ILIKE $%[1]d OR description ILIKE $%[1]d)`, len(args))
	}
	if f.Type != "" {
		args = append(args, f.Type)
		where += fmt.Sprintf(` AND type = $%d`, len(args))
	}
	if f.Status != "" {
		where += ` AND ` + promoStatusWhere(f.Status)
	}
	return pagedJSON[api.Promotion](ctx, r, promotionObj, `promotions`, where, args, page, limit)
}

// DiscountCodesPage is DiscountCodes plus the backoffice filters and paging (see PromotionsPage).
// The search matches the code and, with SearchHolder, a customer-assigned code's holder name.
func (r *Repo) DiscountCodesPage(ctx context.Context, f PromoListFilter, page, limit int) ([]api.DiscountCode, int, error) {
	var args []any
	where := `true`
	if f.Q != "" {
		args = append(args, likePattern(f.Q))
		where += fmt.Sprintf(` AND (code ILIKE $%[1]d`, len(args))
		if f.SearchHolder {
			where += fmt.Sprintf(` OR EXISTS (SELECT 1 FROM customers c WHERE c.id = discount_codes.customer_id AND c.name ILIKE $%[1]d)`, len(args))
		}
		where += `)`
	}
	if f.Type != "" {
		args = append(args, f.Type)
		where += fmt.Sprintf(` AND type = $%d`, len(args))
	}
	if f.Status != "" {
		where += ` AND ` + promoStatusWhere(f.Status)
	}
	return pagedJSON[api.DiscountCode](ctx, r, discountCodeObj, `discount_codes`, where, args, page, limit)
}

// pagedJSON lists `obj` rows of one table under where, newest first with an id tie-break, with the
// total matching rows. limit 0 returns every match. Past the last page the window total vanishes
// with the rows, so the count is asked again.
func pagedJSON[T any](ctx context.Context, r *Repo, obj, table, where string, args []any, page, limit int) ([]T, int, error) {
	n := len(args)
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total FROM %s WHERE %s
	  ORDER BY created_at DESC, id DESC LIMIT NULLIF($%d,0) OFFSET $%d`, obj, table, where, n+1, n+2)
	rows, total, err := listJSON[T](ctx, r.Pool, sql, append(append([]any{}, args...), limit, off(page, limit))...)
	if err != nil || len(rows) > 0 || page <= 1 {
		return rows, total, err
	}
	err = r.Pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s`, table, where), args...).Scan(&total)
	return rows, total, err
}
