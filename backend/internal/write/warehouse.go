package write

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// OutletPar is the write-side input for setting a per-variant PAR (low-stock
// threshold) on an outlet. ParLevel nil clears the threshold.
type OutletPar struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	ParLevel    *int   `json:"parLevel"`
}

type Warehouse struct {
	Name     string `json:"name"`
	Code     string `json:"code"`
	Address  string `json:"address"`
	Phone    string `json:"phone"`
	LogoURL  string `json:"logoUrl"`
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
			`INSERT INTO warehouses (name, code, address, phone, logo_url, is_active)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), nullStr(w.LogoURL), w.IsActive).Scan(&id)
	})
	return id, err
}

func (r *Repo) UpdateWarehouse(ctx context.Context, id string, w Warehouse) error {
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		ct, e := t.Exec(ctx,
			`UPDATE warehouses SET name=$1, code=$2, address=$3, phone=$4, logo_url=$5, is_active=$6 WHERE id=$7`,
			w.Name, nullStr(w.Code), nullStr(w.Address), nullStr(w.Phone), nullStr(w.LogoURL), w.IsActive, id)
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

type GoodsReceiptItem struct {
	ProductID   string   `json:"productId"`
	VariantSize string   `json:"variantSize"`
	Qty         int      `json:"qty"`
	UnitCost    *float64 `json:"unitCost"`
}
type GoodsReceipt struct {
	Supplier string             `json:"supplier"`
	Note     string             `json:"note"`
	Items    []GoodsReceiptItem `json:"items"`
}

// CreateGoodsReceipt records a goods-in and INCREMENTS warehouse stock per line.
func (r *Repo) CreateGoodsReceipt(ctx context.Context, warehouseID, createdBy string, g GoodsReceipt) error {
	if len(g.Items) == 0 {
		return fmt.Errorf("minimal satu item")
	}
	for _, it := range g.Items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
	}
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		var rid string
		if e := t.QueryRow(ctx,
			`INSERT INTO goods_receipts (warehouse_id, supplier, note, created_by)
			 VALUES ($1,$2,$3,$4) RETURNING id`,
			warehouseID, nullStr(g.Supplier), nullStr(g.Note), nullUUID(createdBy)).Scan(&rid); e != nil {
			return e
		}
		for _, it := range g.Items {
			if _, e := t.Exec(ctx,
				`INSERT INTO goods_receipt_items (receipt_id, product_id, variant_size, qty, unit_cost)
				 VALUES ($1,$2,$3,$4,$5)`,
				rid, it.ProductID, it.VariantSize, it.Qty, it.UnitCost); e != nil {
				return e
			}
			if _, e := t.Exec(ctx,
				`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (warehouse_id, product_id, variant_size)
				   DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.stock`,
				warehouseID, it.ProductID, it.VariantSize, it.Qty); e != nil {
				return e
			}
		}
		return nil
	})
}

type WarehouseAdjust struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	NewQty      int    `json:"newQty"`
	Reason      string `json:"reason"`
}

// AdjustWarehouseStock SETS the absolute on-hand qty + logs the correction.
func (r *Repo) AdjustWarehouseStock(ctx context.Context, warehouseID, createdBy string, a WarehouseAdjust) error {
	if a.Reason == "" {
		return fmt.Errorf("alasan wajib diisi")
	}
	if a.NewQty < 0 {
		return fmt.Errorf("stok tidak boleh negatif")
	}
	return r.noBumpTx(ctx, func(t pgx.Tx) error {
		if _, e := t.Exec(ctx,
			`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (warehouse_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
			warehouseID, a.ProductID, a.VariantSize, a.NewQty); e != nil {
			return e
		}
		_, e := t.Exec(ctx,
			`INSERT INTO warehouse_stock_adjustments (warehouse_id, product_id, variant_size, new_qty, reason, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6)`,
			warehouseID, a.ProductID, a.VariantSize, a.NewQty, a.Reason, nullUUID(createdBy))
		return e
	})
}

// bumpOutletTx runs fn in a tx and, on success, bumps ONLY the given outlet's
// content_version under "products" so the POS re-syncs the new on-hand.
func (r *Repo) bumpOutletTx(ctx context.Context, outletID string, fn func(pgx.Tx) error) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	if err := fn(t); err != nil {
		return err
	}
	if err := bumpVersionOutlets(ctx, t, "products", []string{outletID}); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	return t.Commit(ctx)
}

// CreateLocationGoodsReceipt records a goods-in for an outlet OR warehouse and
// INCREMENTS that location's stock per line. Outlet writes bump the outlet's
// content_version; warehouse writes do not.
func (r *Repo) CreateLocationGoodsReceipt(ctx context.Context, kind, locID, createdBy string, g GoodsReceipt) error {
	if err := validateGoodsReceipt(kind, g.Items); err != nil {
		return err
	}
	var whID, outID any
	if kind == "warehouse" {
		whID = locID
	} else {
		outID = locID
	}
	work := func(t pgx.Tx) error {
		var rid string
		if e := t.QueryRow(ctx,
			`INSERT INTO goods_receipts (warehouse_id, outlet_id, supplier, note, created_by)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			whID, outID, nullStr(g.Supplier), nullStr(g.Note), nullUUID(createdBy)).Scan(&rid); e != nil {
			return e
		}
		for _, it := range g.Items {
			if _, e := t.Exec(ctx,
				`INSERT INTO goods_receipt_items (receipt_id, product_id, variant_size, qty, unit_cost)
				 VALUES ($1,$2,$3,$4,$5)`,
				rid, it.ProductID, it.VariantSize, it.Qty, it.UnitCost); e != nil {
				return e
			}
			if kind == "warehouse" {
				if _, e := t.Exec(ctx,
					`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
					 VALUES ($1,$2,$3,$4)
					 ON CONFLICT (warehouse_id, product_id, variant_size)
					   DO UPDATE SET stock = warehouse_variant_stock.stock + EXCLUDED.stock`,
					locID, it.ProductID, it.VariantSize, it.Qty); e != nil {
					return e
				}
			} else {
				// outlet: touch ONLY stock — preserve available + par_level.
				if _, e := t.Exec(ctx,
					`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
					 VALUES ($1,$2,$3,$4)
					 ON CONFLICT (outlet_id, product_id, variant_size)
					   DO UPDATE SET stock = outlet_variant_stock.stock + EXCLUDED.stock`,
					locID, it.ProductID, it.VariantSize, it.Qty); e != nil {
					return e
				}
			}
		}
		return nil
	}
	if kind == "warehouse" {
		return r.noBumpTx(ctx, work)
	}
	return r.bumpOutletTx(ctx, locID, work)
}

// AdjustLocationStock SETS the absolute on-hand qty for an outlet OR warehouse +
// logs the correction. Outlet writes touch ONLY stock (preserve available +
// par_level) and bump the outlet's content_version.
func (r *Repo) AdjustLocationStock(ctx context.Context, kind, locID, createdBy string, a WarehouseAdjust) error {
	if err := validateLocationAdjust(kind, a.NewQty, a.Reason); err != nil {
		return err
	}
	var whID, outID any
	if kind == "warehouse" {
		whID = locID
	} else {
		outID = locID
	}
	work := func(t pgx.Tx) error {
		if kind == "warehouse" {
			if _, e := t.Exec(ctx,
				`INSERT INTO warehouse_variant_stock (warehouse_id, product_id, variant_size, stock)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (warehouse_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
				locID, a.ProductID, a.VariantSize, a.NewQty); e != nil {
				return e
			}
		} else {
			if _, e := t.Exec(ctx,
				`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
				 VALUES ($1,$2,$3,$4)
				 ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET stock=EXCLUDED.stock`,
				locID, a.ProductID, a.VariantSize, a.NewQty); e != nil {
				return e
			}
		}
		_, e := t.Exec(ctx,
			`INSERT INTO warehouse_stock_adjustments (warehouse_id, outlet_id, product_id, variant_size, new_qty, reason, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			whID, outID, a.ProductID, a.VariantSize, a.NewQty, a.Reason, nullUUID(createdBy))
		return e
	}
	if kind == "warehouse" {
		return r.noBumpTx(ctx, work)
	}
	return r.bumpOutletTx(ctx, locID, work)
}

// SetOutletPar upserts ONLY par_level for one (outlet, product, variant),
// preserving stock + available. Bumps the outlet version (cheap; future-proofs
// any POS low-stock consumer). par == nil clears the threshold.
func (r *Repo) SetOutletPar(ctx context.Context, outletID, productID, variantSize string, par *int) error {
	return r.bumpOutletTx(ctx, outletID, func(t pgx.Tx) error {
		_, e := t.Exec(ctx,
			`INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, par_level)
			 VALUES ($1,$2,$3,$4)
			 ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET par_level=EXCLUDED.par_level`,
			outletID, productID, variantSize, par)
		return e
	})
}
