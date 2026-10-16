package write

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/csvimport"
)

// planCustomerImport plans a customer file against live customers (merged_into IS NULL),
// matching by exact phone in ONE grouped query. Existing phones are skipped, never merged.
func planCustomerImport(ctx context.Context, q pgx.Tx, t *csvimport.Table) (*importPlan, error) {
	plan, err := csvimport.PlanCustomers(t, func(phones []string) (map[string]int, error) {
		rows, err := q.Query(ctx,
			`SELECT phone, count(*)::int FROM customers
			  WHERE merged_into IS NULL AND phone = ANY($1) GROUP BY phone`, phones)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := map[string]int{}
		for rows.Next() {
			var phone string
			var n int
			if err := rows.Scan(&phone, &n); err != nil {
				return nil, err
			}
			out[phone] = n
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
		         WHERE c.phone = ins.phone AND c.merged_into IS NULL
		         ORDER BY c.created_at ASC, c.id ASC LIMIT 1),
		       ins.phone
		  FROM ins
		 WHERE EXISTS (SELECT 1 FROM customers c WHERE c.phone = ins.phone AND c.merged_into IS NULL)
		ON CONFLICT DO NOTHING`,
		names, phones, emails, births, annis, notes); err != nil {
		return err
	}
	return bumpVersion(ctx, tx, "customers")
}
