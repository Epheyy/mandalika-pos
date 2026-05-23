package write

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ── Custom roles (global reference data — bumps content version) ──

type CustomRole struct {
	Name        string   `json:"name"`
	Permissions []string `json:"permissions"`
}

func (r *Repo) CreateCustomRole(ctx context.Context, c CustomRole) (string, error) {
	var id string
	err := r.tx(ctx, "customRoles", func(t pgx.Tx) error {
		if e := t.QueryRow(ctx,
			`INSERT INTO custom_roles (name) VALUES ($1) RETURNING id`,
			c.Name).Scan(&id); e != nil {
			return e
		}
		return insertRolePerms(ctx, t, id, c.Permissions)
	})
	return id, err
}

func (r *Repo) UpdateCustomRole(ctx context.Context, id string, c CustomRole) error {
	return r.tx(ctx, "customRoles", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `UPDATE custom_roles SET name=$1 WHERE id=$2`, c.Name, id)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, e := t.Exec(ctx,
			`DELETE FROM custom_role_permissions WHERE role_id=$1`, id); e != nil {
			return e
		}
		return insertRolePerms(ctx, t, id, c.Permissions)
	})
}

func insertRolePerms(ctx context.Context, t pgx.Tx, roleID string, perms []string) error {
	for _, p := range perms {
		if _, e := t.Exec(ctx,
			`INSERT INTO custom_role_permissions (role_id, permission) VALUES ($1,$2)
			 ON CONFLICT DO NOTHING`, roleID, p); e != nil {
			return e
		}
	}
	return nil
}

func (r *Repo) DeleteCustomRole(ctx context.Context, id string) error {
	return r.delete(ctx, "customRoles", "custom_roles", id)
}

// ── Stock counts (outlet-scoped; not reference data) ──────────────

type StockCountItem struct {
	ProductID   string `json:"productId"`
	ProductName string `json:"productName"`
	VariantSize string `json:"variantSize"`
	SKU         string `json:"sku"`
	FrozenQty   int    `json:"frozenQty"`
	ActualQty   *int   `json:"actualQty"`
	Difference  *int   `json:"difference"`
}

type StockCountCreate struct {
	Name        string           `json:"name"`
	PlannedDate string           `json:"plannedDate"`
	Notes       string           `json:"notes"`
	Items       []StockCountItem `json:"items"`
}

type StockCountUpdate struct {
	Status string           `json:"status"`
	Notes  string           `json:"notes"`
	Items  []StockCountItem `json:"items"`
}

// CreateStockCount freezes the supplied snapshot. Outlet + creator come from
// the caller (server-resolved), never the body (plan §2a).
func (r *Repo) CreateStockCount(ctx context.Context, outletID, createdBy string, s StockCountCreate) (string, error) {
	var id string
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer t.Rollback(ctx)
	if e := t.QueryRow(ctx, `
		INSERT INTO stock_counts (name, status, outlet_id, planned_date, notes, created_by)
		VALUES ($1,'planned',$2,$3,$4,$5) RETURNING id`,
		s.Name, outletID, nullDate(s.PlannedDate), nullStr(s.Notes),
		nullUUID(createdBy)).Scan(&id); e != nil {
		return "", e
	}
	if e := insertStockItems(ctx, t, id, s.Items); e != nil {
		return "", e
	}
	return id, t.Commit(ctx)
}

func insertStockItems(ctx context.Context, t pgx.Tx, scID string, items []StockCountItem) error {
	for _, i := range items {
		if _, e := t.Exec(ctx, `
			INSERT INTO stock_count_items (stock_count_id, product_id, product_name,
			  variant_size, sku, frozen_qty, actual_qty, difference)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			scID, i.ProductID, i.ProductName, i.VariantSize, i.SKU,
			i.FrozenQty, i.ActualQty, i.Difference); e != nil {
			return e
		}
	}
	return nil
}

// scopedSC returns ErrNotFound when the stock count is not in the caller's outlet.
func scopedSC(ctx context.Context, t pgx.Tx, id, outletID string) error {
	var n int
	if e := t.QueryRow(ctx,
		`SELECT count(*) FROM stock_counts WHERE id=$1 AND outlet_id=$2`,
		id, outletID).Scan(&n); e != nil {
		return e
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateStockCount handles: start (status=in_progress → started_at), cancel
// (status=cancelled), and save progress (items + notes replace).
func (r *Repo) UpdateStockCount(ctx context.Context, id, outletID string, u StockCountUpdate) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if e := scopedSC(ctx, t, id, outletID); e != nil {
		return e
	}
	switch u.Status {
	case "in_progress":
		if _, e := t.Exec(ctx,
			`UPDATE stock_counts SET status='in_progress', started_at=now() WHERE id=$1`,
			id); e != nil {
			return e
		}
	case "cancelled":
		if _, e := t.Exec(ctx,
			`UPDATE stock_counts SET status='cancelled' WHERE id=$1`, id); e != nil {
			return e
		}
	}
	if u.Items != nil {
		if _, e := t.Exec(ctx,
			`DELETE FROM stock_count_items WHERE stock_count_id=$1`, id); e != nil {
			return e
		}
		if e := insertStockItems(ctx, t, id, u.Items); e != nil {
			return e
		}
	}
	if u.Notes != "" {
		if _, e := t.Exec(ctx,
			`UPDATE stock_counts SET notes=$1 WHERE id=$2`, u.Notes, id); e != nil {
			return e
		}
	}
	return t.Commit(ctx)
}

// CompleteStockCount applies actual quantities to product stock in one tx and
// bumps the products content version so POS resyncs (plan §5a). If items are
// supplied they replace the stored items first.
func (r *Repo) CompleteStockCount(ctx context.Context, id, outletID string, items []StockCountItem) error {
	return r.tx(ctx, "products", func(t pgx.Tx) error {
		if e := scopedSC(ctx, t, id, outletID); e != nil {
			return e
		}
		if items != nil {
			if _, e := t.Exec(ctx,
				`DELETE FROM stock_count_items WHERE stock_count_id=$1`, id); e != nil {
				return e
			}
			if e := insertStockItems(ctx, t, id, items); e != nil {
				return e
			}
		}
		rows, e := t.Query(ctx, `
			SELECT product_id, variant_size, frozen_qty, actual_qty
			  FROM stock_count_items WHERE stock_count_id=$1 AND actual_qty IS NOT NULL`,
			id)
		if e != nil {
			return e
		}
		type adj struct {
			pid, size      string
			frozen, actual int
		}
		var adjs []adj
		for rows.Next() {
			var a adj
			if e := rows.Scan(&a.pid, &a.size, &a.frozen, &a.actual); e != nil {
				rows.Close()
				return e
			}
			adjs = append(adjs, a)
		}
		rows.Close()
		for _, a := range adjs {
			// Apply the counted quantity to THIS outlet's stock row (the count is
			// outlet-scoped via scopedSC); create it if the outlet hasn't been
			// stocked before.
			if _, e := t.Exec(ctx,
				`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
				   VALUES ($1,$2,$3,$4)
				 ON CONFLICT (outlet_id, product_id, variant_size)
				   DO UPDATE SET stock = EXCLUDED.stock`,
				outletID, a.pid, a.size, a.actual); e != nil {
				return e
			}
			if _, e := t.Exec(ctx,
				`UPDATE stock_count_items SET difference=$1
				   WHERE stock_count_id=$2 AND product_id=$3 AND variant_size=$4`,
				a.actual-a.frozen, id, a.pid, a.size); e != nil {
				return e
			}
		}
		_, e = t.Exec(ctx,
			`UPDATE stock_counts SET status='completed', completed_at=now() WHERE id=$1`,
			id)
		return e
	})
}
