package write

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/csvimport"
)

// Stored phones may carry formatting (the backoffice form saves what was typed, e.g.
// "0811-222-333"); the import compares them with the format-cleaned file phone after
// stripping the same noise (space, hyphen, dot, parentheses) from the stored value.
// +62 versus 0 is deliberately NOT unified (plan D5).
const (
	normPhoneSQL  = `regexp_replace(phone, '[\s().-]', '', 'g')`
	normPhoneSQL2 = `regexp_replace(c.phone, '[\s().-]', '', 'g')`
)

// ErrImportStale is the stale-plan error an apply returns (exported for the PostgreSQL gate).
var ErrImportStale = errImportStale

// planCustomerImport plans a customer file against live customers (merged_into IS NULL),
// matching by exact phone in grouped queries. Existing phones are skipped, never merged;
// a phone held only by a tombstoned customer resolves to its terminal keeper and the row
// is skipped with a warning (the import never re-creates a merged-away customer).
func planCustomerImport(ctx context.Context, q pgx.Tx, t *csvimport.Table) (*importPlan, error) {
	plan, err := csvimport.PlanCustomers(t, func(phones []string) (map[string]csvimport.PhoneMatch, error) {
		out := map[string]csvimport.PhoneMatch{}
		rows, err := q.Query(ctx,
			`SELECT `+normPhoneSQL+` AS np, count(*)::int FROM customers
			  WHERE merged_into IS NULL AND `+normPhoneSQL+` = ANY($1) GROUP BY np`, phones)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var phone string
			var n int
			if err := rows.Scan(&phone, &n); err != nil {
				rows.Close()
				return nil, err
			}
			out[phone] = csvimport.PhoneMatch{Live: n}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		// Tombstones only matter where no live customer has the phone. The oldest tombstone
		// per phone is followed through merged_into to the terminal keeper (depth-capped: a chain still
		// going at the cap, or a cycle, is flagged so no intermediate record is named keeper).
		rows, err = q.Query(ctx, `
			WITH RECURSIVE t AS (
			  SELECT DISTINCT ON (np) np, merged_into AS id FROM (
			    SELECT `+normPhoneSQL+` AS np, merged_into, merged_at, id FROM customers
			     WHERE merged_into IS NOT NULL AND `+normPhoneSQL+` = ANY($1)) x
			   ORDER BY np, merged_at, id
			), chain AS (
			  SELECT np, id, 1 AS depth FROM t
			  UNION ALL
			  SELECT chain.np, c.merged_into, chain.depth + 1 FROM chain
			    JOIN customers c ON c.id = chain.id
			   WHERE c.merged_into IS NOT NULL AND chain.depth < 20
			)
			SELECT DISTINCT ON (ch.np) ch.np, k.name, k.phone, k.merged_into IS NOT NULL FROM chain ch
			  JOIN customers k ON k.id = ch.id
			 ORDER BY ch.np, ch.depth DESC`, phones)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var phone string
			var keeper csvimport.MergedKeeper
			if err := rows.Scan(&phone, &keeper.Name, &keeper.Phone, &keeper.ChainTooLong); err != nil {
				return nil, err
			}
			if m := out[phone]; m.Live == 0 {
				out[phone] = csvimport.PhoneMatch{Keeper: &keeper}
			}
		}
		return out, rows.Err()
	})
	if err != nil {
		return nil, err
	}
	creates := plan.Creates
	return &importPlan{report: plan.Report, apply: func(ctx context.Context, tx pgx.Tx) error {
		return ApplyCustomerImportCreates(ctx, tx, creates)
	}}, nil
}

// ApplyCustomerImportCreates (exported so the PostgreSQL gate can drive the plan-to-apply race) inserts the new customers set-based. Under the default policy
// import never creates a customer whose phone already exists (matches are skipped), but
// the advisory lock serialises imports, not POS creates: a POS customer with the same
// phone can land between plan and apply. As a safety net every created row whose phone
// is already held by an older live customer gets a customer_dup_candidates row (the
// recordDupCandidate semantics: oldest existing id, on conflict do nothing). Nothing is
// ever merged.
func ApplyCustomerImportCreates(ctx context.Context, tx pgx.Tx, creates []csvimport.CustomerCreate) error {
	if len(creates) == 0 {
		return nil
	}
	n := len(creates)
	phonesToCreate := make([]string, n)
	for i, c := range creates {
		phonesToCreate[i] = c.Phone
	}
	// A merge can land between plan and apply: a phone that only a tombstoned customer
	// has must not be re-created, so the import is stale (409) instead.
	// Tombstone phones minus live phones, both limited to the create set, so the cost is
	// bounded by the file (two passes), not by a per-row correlated lookup.
	var mergedAway int
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::int FROM (
		  SELECT `+normPhoneSQL+` FROM customers WHERE merged_into IS NOT NULL AND `+normPhoneSQL+` = ANY($1)
		  EXCEPT
		  SELECT `+normPhoneSQL+` FROM customers WHERE merged_into IS NULL AND `+normPhoneSQL+` = ANY($1)
		) x`, phonesToCreate).Scan(&mergedAway); err != nil {
		return err
	}
	if mergedAway > 0 {
		return errImportStale
	}
	names, phones, emails := make([]string, n), make([]string, n), make([]string, n)
	births, annis, notes := make([]string, n), make([]string, n), make([]string, n)
	for i, c := range creates {
		names[i], phones[i], emails[i] = c.Name, c.Phone, c.Email
		births[i], annis[i], notes[i] = c.Birthday, c.Anniversary, c.Notes
	}
	if _, err := tx.Exec(ctx, `
		WITH ins AS (
		  INSERT INTO customers (name, phone, email, birthday, anniversary, notes)
		  SELECT t.n, t.p, NULLIF(t.e,''), NULLIF(t.b,'')::date, NULLIF(t.a,'')::date, NULLIF(t.o,'')
		    FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[]) AS t(n,p,e,b,a,o)
		  RETURNING id, phone
		)
		INSERT INTO customer_dup_candidates (new_customer_id, existing_customer_id, phone)
		SELECT ins.id,
		       (SELECT c.id FROM customers c
		         WHERE `+normPhoneSQL2+` = ins.phone AND c.merged_into IS NULL
		         ORDER BY c.created_at ASC, c.id ASC LIMIT 1),
		       ins.phone
		  FROM ins
		 WHERE EXISTS (SELECT 1 FROM customers c WHERE `+normPhoneSQL2+` = ins.phone AND c.merged_into IS NULL)
		ON CONFLICT DO NOTHING`,
		names, phones, emails, births, annis, notes); err != nil {
		return err
	}
	return bumpVersion(ctx, tx, "customers")
}
