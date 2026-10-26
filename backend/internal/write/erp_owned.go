package write

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// ErpOwnedError is a form change to a field the ERP owns on an ERP-linked row (plan 4.5).
// It carries the 409 conflict code; handlers answer it with HTTP 409.
type ErpOwnedError struct{ Msg string }

func (e *ErpOwnedError) Error() string { return e.Msg }

func (e *ErpOwnedError) ErrorCode() apperr.Code { return apperr.Conflict }

// IsErpOwned reports whether err is an ErpOwnedError.
func IsErpOwned(err error) bool {
	var e *ErpOwnedError
	return errors.As(err, &e)
}

func erpOwned(msg string) error { return &ErpOwnedError{Msg: msg} }

// Mapping v3 (owner decision 2026-10-26): a product's name and category and an outlet's
// name, address and phone are POS-owned and editable even when ERP-linked, so there is no
// product-row or outlet guard. Only variant size/SKU, variant removal and product delete
// stay ERP-owned.

// guardLinkedVariants rejects a changed size or SKU on an ERP-linked variant and the
// removal of one; a whitespace-only difference is replaced by the stored size and SKU in
// vs (the caller owns the slice). matched maps each incoming variant to the existing id
// it updates.
func guardLinkedVariants(ctx context.Context, t pgx.Tx, id string, vs []Variant, matched []string, byID map[string]existingVariant) error {
	rows, e := t.Query(ctx, `SELECT id::text FROM product_variants WHERE product_id=$1 AND erp_slug IS NOT NULL`, id)
	if e != nil {
		return e
	}
	linked := map[string]bool{}
	for rows.Next() {
		var vid string
		if e := rows.Scan(&vid); e != nil {
			rows.Close()
			return e
		}
		linked[vid] = true
	}
	rows.Close()
	if e := rows.Err(); e != nil {
		return e
	}
	if len(linked) == 0 {
		return nil
	}
	kept := map[string]bool{}
	for i, v := range vs {
		vid := matched[i]
		if vid == "" {
			continue
		}
		kept[vid] = true
		if cur := byID[vid]; linked[vid] {
			if differs(cur.size, v.Size) || differs(cur.sku, v.SKU) {
				return erpOwned(fmt.Sprintf("Ukuran dan SKU varian %s dikelola ERP; ubah di ERP", cur.sku))
			}
			vs[i].Size, vs[i].SKU = cur.size, cur.sku
		}
	}
	for vid := range linked {
		if !kept[vid] {
			return erpOwned(fmt.Sprintf("Varian %s dikelola ERP dan tidak bisa dihapus dari formulir", byID[vid].sku))
		}
	}
	return nil
}

// guardLinkedProductDelete refuses to delete an ERP-linked product (the ERP owns its
// lifecycle; deactivate it instead).
func guardLinkedProductDelete(ctx context.Context, t pgx.Tx, id string) error {
	var linked bool
	e := t.QueryRow(ctx, `
		SELECT p.erp_group_key IS NOT NULL
		       OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.erp_slug IS NOT NULL)
		  FROM products p WHERE p.id=$1`, id).Scan(&linked)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	if linked {
		return erpOwned("Produk ini dikelola ERP dan tidak bisa dihapus; nonaktifkan saja")
	}
	return nil
}

// differs compares form text with the stored text ignoring edge whitespace: the backoffice
// forms trim before they send, so an untouched field must not look changed.
func differs(a, b string) bool { return strings.TrimSpace(a) != strings.TrimSpace(b) }
