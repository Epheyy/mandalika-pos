package read

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/mandalika/pos-backend/internal/api"
)

// salesNone is the grouping key of orders without a salesperson ("Tanpa sales").
const (
	salesNoneKey  = "00000000-0000-0000-0000-000000000000"
	salesNoneName = "Tanpa sales"
)

// SalesPerformance reports revenue and customer ratings per salesperson for the filter's business
// days and outlet scope. Revenue is the ReportSummary net-sales formula split by orders.salesman_id:
// gross = SUM(total) of the sale set (completed, partially_refunded, refunded; bound on the SALE day)
// minus the refund rows bound on the REFUND day, so the rows add up to the dashboard's netSales.
// Transactions count completed and partially refunded sales (ReportSummary totalOrders). Ratings
// count by the sale's business day; receiptsSent counts sale-set orders with at least one link.
func (r *Repo) SalesPerformance(ctx context.Context, f OrderFilter) (api.SalesPerformanceReport, error) {
	sf, rf := f, f
	sf.DateBasis, rf.DateBasis = "sale", "refund"
	saleWhere, args := appendOrderWhere(sf, []any{}, false)
	saleWhere += " AND o.status IN ('completed','partially_refunded','refunded')"
	refundWhere, args := appendOrderWhere(rf, args, true)
	sql := fmt.Sprintf(`
WITH sb AS (
  SELECT o.id, o.total, o.status, o.salesman_id, o.salesman_name,
         COALESCE(o.salesman_id, '%[3]s'::uuid) AS skey
  FROM orders o %[1]s
),
sa AS (
  SELECT sb.skey,
         MAX(sb.salesman_name) AS sname,
         COALESCE(SUM(sb.total), 0)::float8 AS gross,
         COUNT(*) FILTER (WHERE sb.status IN ('completed','partially_refunded')) AS txns,
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM receipt_links l WHERE l.order_id = sb.id)) AS sent,
         COUNT(rt.id) AS rated,
         COALESCE(SUM(rt.stars), 0) AS star_sum,
         COUNT(*) FILTER (WHERE rt.stars = 1) AS s1,
         COUNT(*) FILTER (WHERE rt.stars = 2) AS s2,
         COUNT(*) FILTER (WHERE rt.stars = 3) AS s3,
         COUNT(*) FILTER (WHERE rt.stars = 4) AS s4,
         COUNT(*) FILTER (WHERE rt.stars = 5) AS s5,
         COUNT(*) FILTER (WHERE rt.flag_fast OR rt.flag_same_network) AS flagged
  FROM sb LEFT JOIN order_ratings rt ON rt.order_id = sb.id
  GROUP BY sb.skey
),
ra AS (
  SELECT COALESCE(o.salesman_id, '%[3]s'::uuid) AS skey, MAX(o.salesman_name) AS sname,
         COALESCE(SUM(r.amount), 0)::float8 AS refunds
  FROM orders o JOIN order_refunds r ON r.order_id = o.id %[2]s
  GROUP BY 1
)
SELECT COALESCE(sa.skey, ra.skey)::text,
       COALESCE(NULLIF(btrim(COALESCE(sa.sname, ra.sname, '')), ''), u.display_name, ''),
       COALESCE(sa.gross, 0) - COALESCE(ra.refunds, 0),
       COALESCE(sa.txns, 0), COALESCE(sa.sent, 0), COALESCE(sa.rated, 0), COALESCE(sa.star_sum, 0),
       COALESCE(sa.s1, 0), COALESCE(sa.s2, 0), COALESCE(sa.s3, 0), COALESCE(sa.s4, 0), COALESCE(sa.s5, 0),
       COALESCE(sa.flagged, 0),
       COALESCE((SELECT json_agg(json_build_object('stars', c.stars, 'comment', c.comment, 'createdAt', c.created_at)
                                 ORDER BY c.created_at DESC)
                   FROM (SELECT rt.stars, rt.comment, rt.created_at
                           FROM order_ratings rt JOIN sb ON sb.id = rt.order_id
                          WHERE sb.skey = COALESCE(sa.skey, ra.skey) AND btrim(COALESCE(rt.comment, '')) <> ''
                          ORDER BY rt.created_at DESC LIMIT 3) c), '[]'::json)
FROM sa FULL JOIN ra ON sa.skey = ra.skey
LEFT JOIN users u ON u.id = COALESCE(sa.skey, ra.skey) AND COALESCE(sa.skey, ra.skey) <> '%[3]s'::uuid
ORDER BY 3 DESC, 2, 1`, saleWhere, refundWhere, salesNoneKey)

	rows, err := r.Pool.Query(ctx, sql, args...)
	if err != nil {
		return api.SalesPerformanceReport{}, fmt.Errorf("sales performance: %w", err)
	}
	defer rows.Close()

	out := api.SalesPerformanceReport{Data: []api.SalesPerformanceRow{}}
	var sumStars int
	totalCounts := make([]int, 5)
	for rows.Next() {
		var (
			key, name                  string
			revenue                    float64
			txns, sent, rated, starSum int
			c                          [5]int
			flagged                    int
			comments                   []byte
		)
		if err := rows.Scan(&key, &name, &revenue, &txns, &sent, &rated, &starSum,
			&c[0], &c[1], &c[2], &c[3], &c[4], &flagged, &comments); err != nil {
			return out, fmt.Errorf("sales performance scan: %w", err)
		}
		row := api.SalesPerformanceRow{
			SalesmanName: name, Transactions: txns, Revenue: revenue, ReceiptsSent: sent,
			RatingsReceived: rated, ResponseRate: responseRate(rated, sent),
			StarCounts: c[:], FlaggedCount: flagged, AvgStars: avgStars(starSum, rated),
		}
		if key == salesNoneKey {
			row.SalesmanName = salesNoneName
		} else {
			id := openapi_types.UUID{}
			if err := id.UnmarshalText([]byte(key)); err != nil {
				return out, fmt.Errorf("sales performance salesman id: %w", err)
			}
			row.SalesmanId = &id
			if strings.TrimSpace(row.SalesmanName) == "" {
				row.SalesmanName = "Sales"
			}
		}
		if err := json.Unmarshal(comments, &row.LatestComments); err != nil {
			return out, fmt.Errorf("sales performance comments: %w", err)
		}
		out.Data = append(out.Data, row)
		out.Totals.Revenue += revenue
		out.Totals.Transactions += txns
		out.Totals.ReceiptsSent += sent
		out.Totals.RatingsReceived += rated
		out.Totals.FlaggedCount += flagged
		sumStars += starSum
		for i := range totalCounts {
			totalCounts[i] += c[i]
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.Totals.StarCounts = totalCounts
	out.Totals.ResponseRate = responseRate(out.Totals.RatingsReceived, out.Totals.ReceiptsSent)
	out.Totals.AvgStars = avgStars(sumStars, out.Totals.RatingsReceived)
	return out, nil
}

func responseRate(rated, sent int) float64 {
	if sent <= 0 {
		return 0
	}
	v := float64(rated) / float64(sent)
	if v > 1 {
		v = 1
	}
	return v
}

func avgStars(sum, n int) *float64 {
	if n <= 0 {
		return nil
	}
	v := float64(sum) / float64(n)
	return &v
}

// SalesRatings pages the individual ratings of the sale set (same filter and outlet scope as
// SalesPerformance). salesman is a user uuid, "none" for orders without a salesperson, or "" for all.
func (r *Repo) SalesRatings(ctx context.Context, f OrderFilter, salesman string, flaggedOnly bool, page, limit int) ([]api.SalesRating, int, error) {
	sf := f
	sf.DateBasis = "sale"
	where, args := appendOrderWhere(sf, []any{}, false)
	where += " AND o.status IN ('completed','partially_refunded','refunded')"
	switch salesman {
	case "":
	case "none":
		where += " AND o.salesman_id IS NULL"
	default:
		args = append(args, salesman)
		where += fmt.Sprintf(" AND o.salesman_id = $%d::uuid", len(args))
	}
	if flaggedOnly {
		where += " AND (rt.flag_fast OR rt.flag_same_network)"
	}
	args = append(args, limit, off(page, limit))
	n := len(args)
	rows, err := r.Pool.Query(ctx, fmt.Sprintf(`
SELECT rt.id::text, o.id::text, o.order_number, o.outlet_id::text, ou.name,
       COALESCE(o.salesman_id::text, ''), COALESCE(NULLIF(btrim(COALESCE(o.salesman_name,'')),''), ''),
       rt.stars::int, rt.tags, rt.comment, rt.flag_fast, rt.flag_same_network,
       o.business_date::text, rt.created_at, count(*) OVER ()
  FROM order_ratings rt
  JOIN orders o ON o.id = rt.order_id
  JOIN outlets ou ON ou.id = o.outlet_id
  %s
 ORDER BY rt.created_at DESC, rt.id DESC
 LIMIT $%d OFFSET $%d`, where, n-1, n), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("sales ratings: %w", err)
	}
	defer rows.Close()
	out := []api.SalesRating{}
	total := 0
	for rows.Next() {
		var (
			id, orderID, number, outletID, outletName, sid, sname string
			stars                                                 int
			tags                                                  []string
			comment                                               *string
			fast, net                                             bool
			bdate                                                 string
			created                                               time.Time
		)
		if err := rows.Scan(&id, &orderID, &number, &outletID, &outletName, &sid, &sname,
			&stars, &tags, &comment, &fast, &net, &bdate, &created, &total); err != nil {
			return nil, 0, fmt.Errorf("sales ratings scan: %w", err)
		}
		d, err := time.Parse("2006-01-02", bdate)
		if err != nil {
			return nil, 0, fmt.Errorf("sales ratings date: %w", err)
		}
		sr := api.SalesRating{
			OrderNumber: number, Stars: stars, Tags: tags, Comment: comment,
			FlagFast: fast, FlagSameNetwork: net, BusinessDate: openapi_types.Date{Time: d}, CreatedAt: created,
			OutletName: &outletName, SalesmanName: sname,
		}
		if sr.Tags == nil {
			sr.Tags = []string{}
		}
		if sname == "" {
			sr.SalesmanName = salesNoneName
		}
		for dst, src := range map[*openapi_types.UUID]string{&sr.Id: id, &sr.OrderId: orderID, &sr.OutletId: outletID} {
			if err := dst.UnmarshalText([]byte(src)); err != nil {
				return nil, 0, fmt.Errorf("sales ratings id: %w", err)
			}
		}
		if sid != "" {
			u := openapi_types.UUID{}
			if err := u.UnmarshalText([]byte(sid)); err != nil {
				return nil, 0, fmt.Errorf("sales ratings salesman id: %w", err)
			}
			sr.SalesmanId = &u
		}
		out = append(out, sr)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(out) == 0 && page > 1 {
		// Past the end: report the real count with an empty page.
		var cnt int
		cargs := args[:n-2]
		if err := r.Pool.QueryRow(ctx, `SELECT count(*) FROM order_ratings rt JOIN orders o ON o.id = rt.order_id `+where, cargs...).Scan(&cnt); err == nil {
			total = cnt
		}
	}
	return out, total, nil
}
