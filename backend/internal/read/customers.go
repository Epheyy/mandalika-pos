package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/phone"
)

// segmentMatch: the RFM rule predicate. Correlates via BARE columns (last_visit,
// visit_count, total_spent) NOT customers.<col> — because customerObj is also used
// by queries that alias the table. Bare cols resolve to the outer customers row
// whatever its alias.
const segmentMatch = `s.is_active
  AND (s.r_min IS NULL OR (last_visit IS NOT NULL AND ((now() AT TIME ZONE 'Asia/Jakarta')::date - (last_visit AT TIME ZONE 'Asia/Jakarta')::date) >= s.r_min))
  AND (s.r_max IS NULL OR (last_visit IS NOT NULL AND ((now() AT TIME ZONE 'Asia/Jakarta')::date - (last_visit AT TIME ZONE 'Asia/Jakarta')::date) <= s.r_max))
  AND (s.f_min IS NULL OR visit_count >= s.f_min)
  AND (s.f_max IS NULL OR visit_count <= s.f_max)
  AND (s.m_min IS NULL OR total_spent >= s.m_min)
  AND (s.m_max IS NULL OR total_spent <= s.m_max)`

// segmentSel: the computed segment object (or NULL when no rule matches).
const segmentSel = `(SELECT json_build_object('id',s.id,'name',s.name,'color',s.color)
  FROM customer_segments s WHERE ` + segmentMatch + ` ORDER BY s.sort_order, s.created_at LIMIT 1)`

// segmentIdSel: just the matched segment id (for the list filter).
const segmentIdSel = `(SELECT s.id FROM customer_segments s WHERE ` + segmentMatch + ` ORDER BY s.sort_order, s.created_at LIMIT 1)`

const customerObj = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at,
  'segment', ` + segmentSel + `)`

// customerObjWithTags = customerObj + the customer's tags. Used ONLY by the
// backoffice list + detail reads; the shared customerObj stays tag-free so the
// POS sync / lookup / by-phone payloads don't carry tags.
//
// customerObjWithTags must be used ONLY in queries whose outer FROM is
// "FROM customers" (unaliased): the tags sub-select correlates via the bare
// `customers.id`. Aliasing the outer table (e.g. `FROM customers c`) would
// silently return empty tags.
const customerObjWithTags = `json_build_object('id',id,'name',name,'phone',phone,
  'email',email,'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'lastVisit',last_visit,'birthday',birthday,'anniversary',anniversary,
  'notes',notes,'createdAt',created_at,
  'segment', ` + segmentSel + `,
  'tags', COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name)
                    FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id
                    WHERE ct.customer_id = customers.id), '[]'::json))`

func (r *Repo) Customers(ctx context.Context, page, limit int, q, sort, tagId, segmentId string) ([]api.Customer, int, error) {
	// `order` is a fixed internal string (never user input) — safe to concatenate.
	order := `ORDER BY total_spent DESC, created_at DESC`
	if sort == "terbaru" {
		order = `ORDER BY created_at DESC`
	}
	args := []any{off(page, limit), limit, q} // $1 offset, $2 limit, $3 q
	tagFilter := ""
	if tagId != "" {
		args = append(args, tagId)
		tagFilter = fmt.Sprintf(` AND EXISTS (SELECT 1 FROM customer_tags ct
			WHERE ct.customer_id = customers.id AND ct.tag_id = $%d::uuid)`, len(args))
	}
	segFilter := ""
	if segmentId != "" {
		args = append(args, segmentId)
		segFilter = fmt.Sprintf(` AND `+segmentIdSel+` = $%d::uuid`, len(args))
	}
	textMatch := `name ILIKE '%' || $3 || '%' OR phone ILIKE '%' || $3 || '%' OR email ILIKE '%' || $3 || '%'`
	if _, like := phone.SearchKeys(q); like != "" {
		args = append(args, like)
		textMatch += fmt.Sprintf(` OR phone_norm LIKE $%d`, len(args))
	}
	sql := `SELECT ` + customerObjWithTags + `, count(*) OVER() AS total
		   FROM customers
		  WHERE ($3 = '' OR ` + textMatch + `)
		    AND merged_into IS NULL` +
		tagFilter + segFilter + `
		  ` + order + `
		  OFFSET $1 LIMIT $2`
	return listJSON[api.Customer](ctx, r.Pool, sql, args...)
}

// CustomerByPhone returns 0+ live customers whose phone matches this one in any
// format (normalized key, A30), falling back to the exact raw value when the input
// does not normalize. Backs the backoffice soft dup-check via idx_customers_phone_norm.
func (r *Repo) CustomerByPhone(ctx context.Context, rawPhone string) ([]api.Customer, error) {
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total FROM customers
		  WHERE merged_into IS NULL AND (($2 <> '' AND phone_norm = $2) OR phone = $1)
		  ORDER BY created_at, id`, rawPhone, phone.Normalize(rawPhone))
	return rows, err
}

// customerPosObj is the reduced customer the cashier may see: what the POS needs to
// attach a customer and show points. No email, birthday, anniversary, notes or tags.
const customerPosObj = `json_build_object('id',id,'name',name,'phone',phone,
  'points',points,'totalSpent',total_spent,'visitCount',visit_count,
  'createdAt',created_at,'segment', ` + segmentSel + `)`

// CustomerByPhoneNorm is the cashier lookup: live (not merged-away) customers whose
// normalized phone equals norm exactly, oldest first, at most limit rows, reduced fields.
func (r *Repo) CustomerByPhoneNorm(ctx context.Context, norm string, limit int) ([]api.Customer, error) {
	if norm == "" {
		return []api.Customer{}, nil
	}
	if limit < 1 || limit > 20 {
		limit = 3
	}
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerPosObj+`, count(*) OVER() AS total FROM customers
		  WHERE phone_norm = $1 AND merged_into IS NULL
		  ORDER BY created_at, id
		  LIMIT $2`, norm, limit)
	return rows, err
}

// CustomerLookup is the on-demand cashier search (SP-CRM-3 seam): capped,
// exact-phone matches ranked first.
func (r *Repo) CustomerLookup(ctx context.Context, q string, limit int) ([]api.Customer, error) {
	if limit < 1 || limit > 20 {
		limit = 20
	}
	norm, like := phone.SearchKeys(q)
	args := []any{q, limit, norm}
	phoneNormMatch := ""
	if like != "" {
		args = append(args, like)
		phoneNormMatch = ` OR phone_norm LIKE $4`
	}
	rows, _, err := listJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObj+`, count(*) OVER() AS total FROM customers
		  WHERE (name ILIKE '%' || $1 || '%' OR phone ILIKE '%' || $1 || '%'`+phoneNormMatch+`)
		    AND merged_into IS NULL
		  ORDER BY (phone = $1 OR ($3 <> '' AND phone_norm = $3)) DESC, name
		  LIMIT $2`, args...)
	return rows, err
}

func (r *Repo) Customer(ctx context.Context, id string) (api.Customer, error) {
	return oneJSON[api.Customer](ctx, r.Pool,
		`SELECT `+customerObjWithTags+` FROM customers WHERE id=$1 AND merged_into IS NULL`, id)
}

// Interactions returns a customer's interaction log, newest-first, paginated.
func (r *Repo) Interactions(ctx context.Context, customerID string, page, limit int) ([]api.Interaction, int, error) {
	const sql = `SELECT json_build_object(
		  'id', id, 'type', type, 'interactionDate', interaction_date,
		  'note', note, 'createdBy', created_by, 'createdByName', created_by_name,
		  'createdAt', created_at), count(*) OVER() AS total
		FROM customer_interactions
		WHERE customer_id = $1
		ORDER BY interaction_date DESC, created_at DESC
		OFFSET $2 LIMIT $3`
	return listJSON[api.Interaction](ctx, r.Pool, sql, customerID, off(page, limit), limit)
}

// PointTransactions returns a customer's points ledger, newest-first, paginated.
func (r *Repo) PointTransactions(ctx context.Context, customerID string, page, limit int) ([]api.PointTransaction, int, error) {
	const sql = `SELECT json_build_object(
		  'id', pt.id, 'type', pt.type, 'points', pt.points, 'balanceAfter', pt.balance_after,
		  'reason', pt.reason, 'orderId', pt.order_id, 'orderNumber', o.order_number,
		  'createdByName', pt.created_by_name, 'createdAt', pt.created_at), count(*) OVER() AS total
		FROM point_transactions pt
		LEFT JOIN orders o ON o.id = pt.order_id
		WHERE pt.customer_id = $1
		ORDER BY pt.created_at DESC, pt.id DESC
		OFFSET $2 LIMIT $3`
	return listJSON[api.PointTransaction](ctx, r.Pool, sql, customerID, off(page, limit), limit)
}

// RewardGrants lists a customer's product_reward grants (SP-CRM-8), newest first.
func (r *Repo) RewardGrants(ctx context.Context, customerID string) ([]api.RewardGrant, error) {
	const sql = `SELECT json_build_object(
		  'id', a.id, 'conditionName', a.condition_name,
		  'rewardProductIds', COALESCE(a.reward_product_ids,'[]'::jsonb),
		  'orderId', a.order_id, 'orderNumber', o.order_number, 'createdAt', a.created_at)
		FROM loyalty_condition_applications a
		LEFT JOIN orders o ON o.id = a.order_id
		WHERE a.customer_id = $1 AND a.reward_type = 'product_reward'
		ORDER BY a.created_at DESC, a.id DESC`
	rows, _, err := listJSON[api.RewardGrant](ctx, r.Pool, sql, customerID)
	return rows, err
}

// Tags lists all customer tags ordered by sort_order then name.
func (r *Repo) Tags(ctx context.Context) ([]api.Tag, error) {
	const sql = `SELECT json_build_object('id',id,'name',name,'color',color,
		'sortOrder',sort_order,'createdAt',created_at)
		FROM tags ORDER BY sort_order NULLS LAST, name ASC`
	rows, _, err := listJSON[api.Tag](ctx, r.Pool, sql)
	return rows, err
}

// Segments lists all segment rules ordered by priority.
func (r *Repo) Segments(ctx context.Context) ([]api.Segment, error) {
	const sql = `SELECT json_build_object('id',id,'name',name,'color',color,
		'sortOrder',sort_order,'rMin',r_min,'rMax',r_max,'fMin',f_min,'fMax',f_max,
		'mMin',m_min,'mMax',m_max,'isActive',is_active,'createdAt',created_at)
		FROM customer_segments ORDER BY sort_order`
	rows, _, err := listJSON[api.Segment](ctx, r.Pool, sql)
	return rows, err
}
