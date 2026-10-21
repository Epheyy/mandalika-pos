package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

const transferObj = `json_build_object(
  'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
  'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
  'source', json_build_object(
    'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
    'name', COALESCE(so.name, sw.name)),
  'dest', json_build_object(
    'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
    'name', COALESCE(do2.name, dw.name)),
  'senderLetterhead', json_build_object(
    'locationName', COALESCE(so.name, sw.name),
    'brandName',    s.documents_brand_name,
    'logoUrl',      COALESCE(so.logo_url, sw.logo_url, s.documents_logo_url),
    'addressLines', string_to_array(
                      COALESCE(NULLIF(COALESCE(so.address, sw.address), ''),
                               s.documents_address_lines, ''), E'\n'),
    'phone',        COALESCE(so.phone, sw.phone, s.documents_phone),
    'npwp',         s.documents_npwp),
  'receiverLetterhead', json_build_object(
    'locationName', COALESCE(do2.name, dw.name),
    'brandName',    s.documents_brand_name,
    'logoUrl',      COALESCE(do2.logo_url, dw.logo_url, s.documents_logo_url),
    'addressLines', string_to_array(
                      COALESCE(NULLIF(COALESCE(do2.address, dw.address), ''),
                               s.documents_address_lines, ''), E'\n'),
    'phone',        COALESCE(do2.phone, dw.phone, s.documents_phone),
    'npwp',         s.documents_npwp),
  'note', t.note, 'discrepancyReason', t.discrepancy_reason,
  'createdAt', t.created_at, 'sentAt', t.sent_at,
  'receivedAt', t.received_at, 'cancelledAt', t.cancelled_at,
  'items', COALESCE((SELECT json_agg(json_build_object(
     'productId', ti.product_id, 'productName', p.name,
     'variantSize', ti.variant_size, 'sku', v.sku,
     'sentQty', ti.sent_qty, 'receivedQty', ti.received_qty,
     'difference', ti.difference) ORDER BY p.name, ti.variant_size)
     FROM transfer_items ti
     JOIN products p ON p.id = ti.product_id
     LEFT JOIN product_variants v ON v.product_id = ti.product_id AND v.size = ti.variant_size
     WHERE ti.transfer_id = t.id), '[]'::json))`

// transferFrom resolves both polymorphic endpoints' names. `do2`/`dw` aliases
// avoid the reserved word `do`. The single-row app_settings table is joined
// unconditionally (ON true) to supply brand-level letterhead defaults.
const transferFrom = `FROM transfers t
  LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
  LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
  LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
  LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id
  LEFT JOIN app_settings s ON true`

// Transfers lists transfers newest-first with optional filters: status, date range,
// and location (any side — source OR dest).
func (r *Repo) Transfers(ctx context.Context, status, from, to, locKind, locID string, page, limit int) ([]api.Transfer, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	if status != "" {
		args = append(args, status)
		where += fmt.Sprintf(" AND t.status=$%d", len(args))
	}
	if from != "" {
		args = append(args, from)
		where += fmt.Sprintf(" AND t.created_at >= $%d", len(args))
	}
	if to != "" {
		args = append(args, to)
		where += fmt.Sprintf(" AND t.created_at < $%d", len(args))
	}
	if locKind != "" && locID != "" {
		args = append(args, locID)
		if locKind == "warehouse" {
			where += fmt.Sprintf(" AND (t.source_warehouse_id=$%d OR t.dest_warehouse_id=$%d)", len(args), len(args))
		} else {
			where += fmt.Sprintf(" AND (t.source_outlet_id=$%d OR t.dest_outlet_id=$%d)", len(args), len(args))
		}
	}
	args = append(args, limit, off(page, limit))
	sql := fmt.Sprintf(`SELECT %s, count(*) OVER() AS total %s %s
	  ORDER BY t.created_at DESC LIMIT $%d OFFSET $%d`,
		transferObj, transferFrom, where, len(args)-1, len(args))
	return listJSON[api.Transfer](ctx, r.Pool, sql, args...)
}

// Transfer returns one transfer with its items.
func (r *Repo) Transfer(ctx context.Context, id string) (api.Transfer, error) {
	return oneJSON[api.Transfer](ctx, r.Pool,
		`SELECT `+transferObj+` `+transferFrom+` WHERE t.id=$1`, id)
}

// TransfersForOutlet returns transfers of a given status destined to this outlet.
// Used by the POS pull bundle (status="in_transit") so the destination outlet can
// receive on-device.
func (r *Repo) TransfersForOutlet(ctx context.Context, outletID, status string) ([]api.Transfer, error) {
	sql := `SELECT ` + transferObj + `, count(*) OVER() AS total ` + transferFrom +
		` WHERE t.dest_outlet_id=$1 AND t.status=$2 ORDER BY t.created_at DESC`
	rows, _, err := listJSON[api.Transfer](ctx, r.Pool, sql, outletID, status)
	return rows, err
}

// OutletTransferHistory returns transfers (incoming OR outgoing) for an outlet
// at a given status, newest first. Used by the cashier-scoped history view.
func (r *Repo) OutletTransferHistory(ctx context.Context, outletID, status string) ([]api.Transfer, error) {
	sql := `SELECT ` + transferObj + `, count(*) OVER() AS total ` + transferFrom +
		` WHERE (t.source_outlet_id=$1 OR t.dest_outlet_id=$1) AND t.status=$2 ORDER BY t.created_at DESC`
	rows, _, err := listJSON[api.Transfer](ctx, r.Pool, sql, outletID, status)
	return rows, err
}
