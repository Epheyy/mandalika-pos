package read

import (
	"context"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
)

// dayKey pairs an MMDD value (month*100+day) with how many days from "today"
// it is — used by Reminders to sort soonest-first and label "dalam N hari".
type dayKey struct {
	mmdd      int
	daysUntil int
}

func isLeap(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

// mmddWindow returns the MMDD keys for the (days+1) calendar days starting at
// today (inclusive), soonest-first. AddDate handles month rollover and year-end
// wrap. In a non-leap year a window spanning Mar 1 also emits 0229 so Feb-29
// dates still get a reminder. days is clamped to [0, 366].
func mmddWindow(today time.Time, days int) []dayKey {
	if days < 0 {
		days = 0
	}
	if days > 366 {
		days = 366
	}
	out := make([]dayKey, 0, days+2)
	for i := 0; i <= days; i++ {
		d := today.AddDate(0, 0, i)
		out = append(out, dayKey{mmdd: int(d.Month())*100 + d.Day(), daysUntil: i})
		// d.Year() is the WINDOW year (does February have 29 days this year),
		// not the customer's birth year.
		if d.Month() == time.March && d.Day() == 1 && !isLeap(d.Year()) {
			out = append(out, dayKey{mmdd: 229, daysUntil: i})
		}
	}
	return out
}

// Reminders returns customers whose birthday or anniversary falls within the
// [today, today+days] window, soonest-first, paginated. typ ∈ {all,birthday,
// anniversary}. A customer with both dates in-window yields two rows (one per
// kind). The MMDD lists drive index-eligible equality lookups on the partial
// idx_customers_*_mmdd indexes.
func (r *Repo) Reminders(ctx context.Context, today time.Time, days int, typ string, page, limit int) ([]api.Reminder, int, error) {
	keys := mmddWindow(today, days)
	mmdds := make([]int, len(keys))
	dus := make([]int, len(keys))
	for i, k := range keys {
		mmdds[i] = k.mmdd
		dus[i] = k.daysUntil
	}
	const sql = `
		WITH win AS (SELECT * FROM unnest($1::int[], $2::int[]) AS w(mmdd, du)),
		rem AS (
		  SELECT c.id, c.name, c.phone, 'birthday'::text AS kind, c.birthday AS dt, w.du
		    FROM customers c JOIN win w ON c.birthday_mmdd = w.mmdd
		   WHERE $3 IN ('all','birthday')
		  UNION ALL
		  SELECT c.id, c.name, c.phone, 'anniversary'::text, c.anniversary, w.du
		    FROM customers c JOIN win w ON c.anniversary_mmdd = w.mmdd
		   WHERE $3 IN ('all','anniversary')
		)
		SELECT json_build_object(
		  'id', id, 'name', name, 'phone', phone,
		  'kind', kind, 'date', dt, 'daysUntil', du), count(*) OVER() AS total
		FROM rem
		ORDER BY du, name
		OFFSET $4 LIMIT $5`
	return listJSON[api.Reminder](ctx, r.Pool, sql, mmdds, dus, typ, off(page, limit), limit)
}
