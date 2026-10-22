package write

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type Outlet struct {
	Name     string `json:"name"`
	Code     string `json:"code"`
	Address  string `json:"address"`
	Phone    string `json:"phone"`
	LogoURL  string `json:"logoUrl"`
	IsActive bool   `json:"isActive"`
	// Timezone is one of bizday.Allowed. Empty means "not sent": a new outlet gets the
	// column default (Asia/Jakarta) and an update keeps the current zone.
	Timezone string `json:"timezone"`
}

func (r *Repo) CreateOutlet(ctx context.Context, o Outlet) (string, error) {
	var id string
	err := r.tx(ctx, "outlets", func(t pgx.Tx) error {
		if e := t.QueryRow(ctx,
			`INSERT INTO outlets (name, code, address, phone, logo_url, is_active, timezone)
			 VALUES ($1,$2,$3,$4,$5,$6,COALESCE(NULLIF($7,''),'Asia/Jakarta')) RETURNING id`,
			o.Name, nullStr(o.Code), nullStr(o.Address), nullStr(o.Phone), nullStr(o.LogoURL), o.IsActive, o.Timezone).
			Scan(&id); e != nil {
			return e
		}
		// Seed a content_versions row so the new outlet has a baseline.
		_, e := t.Exec(ctx,
			`INSERT INTO content_versions (outlet_id) VALUES ($1)
			 ON CONFLICT DO NOTHING`, id)
		return e
	})
	return id, err
}

func (r *Repo) UpdateOutlet(ctx context.Context, id string, o Outlet) error {
	return r.tx(ctx, "outlets", func(t pgx.Tx) error {
		if e := guardLinkedOutlet(ctx, t, id, &o); e != nil {
			return e
		}
		ct, e := t.Exec(ctx,
			`UPDATE outlets SET name=$1, code=$2, address=$3, phone=$4, logo_url=$5, is_active=$6,
			   timezone=COALESCE(NULLIF($7,''),timezone) WHERE id=$8`,
			o.Name, nullStr(o.Code), nullStr(o.Address), nullStr(o.Phone), nullStr(o.LogoURL), o.IsActive, o.Timezone, id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}
