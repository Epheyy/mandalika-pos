package write

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type Customer struct {
	Name        string `json:"name"`
	Phone       string `json:"phone"`
	Email       string `json:"email"`
	Birthday    string `json:"birthday"`
	Anniversary string `json:"anniversary"`
	Notes       string `json:"notes"`
}

func (r *Repo) CreateCustomer(ctx context.Context, c Customer) (string, error) {
	var id string
	err := r.tx(ctx, "customers", func(t pgx.Tx) error {
		e := t.QueryRow(ctx,
			`INSERT INTO customers (name, phone, email, birthday, anniversary, notes)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			c.Name, c.Phone, nullStr(c.Email),
			nullDate(c.Birthday), nullDate(c.Anniversary), nullStr(c.Notes)).Scan(&id)
		if e != nil {
			return e
		}
		return flagDupCandidate(ctx, t, id)
	})
	return id, err
}

func (r *Repo) UpdateCustomer(ctx context.Context, id string, c Customer) error {
	return r.tx(ctx, "customers", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE customers SET name=$1, phone=$2, email=$3,
			   birthday=$4, anniversary=$5, notes=$6 WHERE id=$7`,
			c.Name, c.Phone, nullStr(c.Email),
			nullDate(c.Birthday), nullDate(c.Anniversary), nullStr(c.Notes), id)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return flagDupCandidate(ctx, t, id)
	})
}

func (r *Repo) DeleteCustomer(ctx context.Context, id string) error {
	return r.delete(ctx, "customers", "customers", id)
}

// flagDupCandidate puts customer id into the Duplikat review queue when another live customer
// has the same normalized phone (0812..., 62812... and +62 812... are one number). It only
// flags, never merges: a human decides in the backoffice. The pair is oriented like the POS
// path (the newer row is "new", the oldest other live row is "existing") and an already-known
// pair, in either direction and whatever its status, is left alone.
func flagDupCandidate(ctx context.Context, t pgx.Tx, id string) error {
	_, err := t.Exec(ctx, `
		INSERT INTO customer_dup_candidates (new_customer_id, existing_customer_id, phone)
		SELECT c.id, e.id, c.phone
		  FROM customers c
		  JOIN LATERAL (
		    SELECT x.id FROM customers x
		     WHERE x.merged_into IS NULL AND x.id <> c.id AND x.phone_norm = c.phone_norm
		     ORDER BY x.created_at, x.id LIMIT 1) e ON true
		 WHERE c.id = $1 AND c.merged_into IS NULL AND c.phone_norm <> ''
		   AND NOT EXISTS (SELECT 1 FROM customer_dup_candidates d
		                    WHERE d.new_customer_id = e.id AND d.existing_customer_id = c.id)
		ON CONFLICT DO NOTHING`, id)
	return err
}
