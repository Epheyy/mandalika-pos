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
		return t.QueryRow(ctx,
			`INSERT INTO customers (name, phone, email, birthday, anniversary, notes)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			c.Name, c.Phone, nullStr(c.Email),
			nullDate(c.Birthday), nullDate(c.Anniversary), nullStr(c.Notes)).Scan(&id)
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
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteCustomer(ctx context.Context, id string) error {
	return r.delete(ctx, "customers", "customers", id)
}
