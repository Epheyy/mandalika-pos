package write

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type Warehouse struct {
	Name     string `json:"name"`
	Code     string `json:"code"`
	Address  string `json:"address"`
	Phone    string `json:"phone"`
	IsActive bool   `json:"isActive"`
}

// noBumpTx runs fn in a tx WITHOUT bumping content_version (warehouses are not
// POS-synced, so no cashier resync is needed).
func (r *Repo) noBumpTx(ctx context.Context, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	return t.Commit(ctx)
}

func (r *Repo) CreateWarehouse(ctx context.Context, w Warehouse) (string, error) {
	var id string
	err := r.noBumpTx(ctx, func(t pgx.Tx) error {
		return t.QueryRow(ctx,
			`INSERT INTO warehouses (name, code, address, phone, is_active)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), w.IsActive).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateWarehouse(ctx context.Context, id string, w Warehouse) error {
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE warehouses SET name=$1, code=$2, address=$3, phone=$4, is_active=$5 WHERE id=$6`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), w.IsActive, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteWarehouse(ctx context.Context, id string) error {
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `DELETE FROM warehouses WHERE id=$1`, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}
