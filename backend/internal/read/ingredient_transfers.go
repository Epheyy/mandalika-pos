package read

import (
	"context"
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
)

// ingTransferItemsSubq is the shared ingredient transfer items subquery.
const ingTransferItemsSubq = `(
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id, 'ingredientId', i.ingredient_id,
    'ingredientName', ing.name, 'ingredientUnit', ing.unit,
    'sentQty', i.sent_qty, 'receivedQty', i.received_qty, 'difference', i.difference
  ) ORDER BY ing.name), '[]'::jsonb)
    FROM ingredient_transfer_items i JOIN ingredients ing ON ing.id = i.ingredient_id
   WHERE i.transfer_id = t.id
)`

// ingTransferObj builds the polymorphic JSON shape for an ingredient transfer.
// Joins both outlets and warehouses for each leg so names are resolved regardless
// of location kind (mirrors transferObj / transferFrom in the product transfer reads).
const ingTransferObj = `jsonb_build_object(
  'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
  'source', jsonb_build_object(
    'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
    'name', COALESCE(so.name, sw.name)),
  'dest', jsonb_build_object(
    'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
    'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
    'name', COALESCE(do2.name, dw.name)),
  'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
  'note', t.note, 'discrepancyReason', t.discrepancy_reason,
  'createdAt',   to_char(t.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'sentAt',      CASE WHEN t.sent_at      IS NULL THEN NULL ELSE to_char(t.sent_at      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
  'receivedAt',  CASE WHEN t.received_at  IS NULL THEN NULL ELSE to_char(t.received_at  AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
  'cancelledAt', CASE WHEN t.cancelled_at IS NULL THEN NULL ELSE to_char(t.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
  'cancelReason', t.cancel_reason,
  'items', ` + ingTransferItemsSubq + `)`

// ingTransferFrom resolves all four nullable location legs.
// do2/dw alias avoids the reserved word "do".
const ingTransferFrom = `FROM ingredient_transfers t
  LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
  LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
  LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
  LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id`

// IngredientTransfers lists ingredient transfers newest-first with optional filters:
// status, date range, and location (any side — source OR dest).
func (r *Repo) IngredientTransfers(ctx context.Context, page, limit int, status, from, to, locKind, locID string) ([]api.IngredientTransfer, int, error) {
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
	  ORDER BY t.created_at DESC, t.id DESC LIMIT $%d OFFSET $%d`,
		ingTransferObj, ingTransferFrom, where, len(args)-1, len(args))
	return listJSON[api.IngredientTransfer](ctx, r.Pool, sql, args...)
}

// IngredientTransfer returns a single ingredient transfer with sender/receiver
// letterheads resolved from location address/phone/logo_url with
// app_settings.documents_* fallback. Supports any location kind (outlet or warehouse).
func (r *Repo) IngredientTransfer(ctx context.Context, id string) (api.IngredientTransfer, error) {
	const sql = `
      WITH s AS (SELECT * FROM app_settings LIMIT 1),
           t AS (SELECT it.* FROM ingredient_transfers it WHERE it.id = $1)
      SELECT jsonb_build_object(
        'id', t.id, 'transferNo', t.transfer_no, 'status', t.status,
        'source', jsonb_build_object(
          'kind', CASE WHEN t.source_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
          'id',   COALESCE(t.source_outlet_id, t.source_warehouse_id),
          'name', COALESCE(so.name, sw.name)),
        'dest', jsonb_build_object(
          'kind', CASE WHEN t.dest_outlet_id IS NOT NULL THEN 'outlet' ELSE 'warehouse' END,
          'id',   COALESCE(t.dest_outlet_id, t.dest_warehouse_id),
          'name', COALESCE(do2.name, dw.name)),
        'suratJalanNo', t.surat_jalan_no, 'tandaTerimaNo', t.tanda_terima_no,
        'note', t.note, 'discrepancyReason', t.discrepancy_reason,
        'createdAt',   to_char(t.created_at   AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'sentAt',      CASE WHEN t.sent_at      IS NULL THEN NULL ELSE to_char(t.sent_at      AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'receivedAt',  CASE WHEN t.received_at  IS NULL THEN NULL ELSE to_char(t.received_at  AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelledAt', CASE WHEN t.cancelled_at IS NULL THEN NULL ELSE to_char(t.cancelled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
        'cancelReason', t.cancel_reason,
        'senderLetterhead', jsonb_build_object(
          'locationName', COALESCE(so.name, sw.name),
          'brandName',    s.documents_brand_name,
          'logoUrl',      COALESCE(so.logo_url, sw.logo_url, s.documents_logo_url),
          'addressLines', string_to_array(
                            COALESCE(NULLIF(COALESCE(so.address, sw.address), ''),
                                     s.documents_address_lines, ''), E'\n'),
          'phone',        COALESCE(so.phone, sw.phone, s.documents_phone),
          'npwp',         s.documents_npwp),
        'receiverLetterhead', jsonb_build_object(
          'locationName', COALESCE(do2.name, dw.name),
          'brandName',    s.documents_brand_name,
          'logoUrl',      COALESCE(do2.logo_url, dw.logo_url, s.documents_logo_url),
          'addressLines', string_to_array(
                            COALESCE(NULLIF(COALESCE(do2.address, dw.address), ''),
                                     s.documents_address_lines, ''), E'\n'),
          'phone',        COALESCE(do2.phone, dw.phone, s.documents_phone),
          'npwp',         s.documents_npwp),
        'items', ` + ingTransferItemsSubq + `
      )
      FROM t
      LEFT JOIN outlets    so  ON so.id  = t.source_outlet_id
      LEFT JOIN warehouses sw  ON sw.id  = t.source_warehouse_id
      LEFT JOIN outlets    do2 ON do2.id = t.dest_outlet_id
      LEFT JOIN warehouses dw  ON dw.id  = t.dest_warehouse_id
      LEFT JOIN s ON true`
	return oneJSON[api.IngredientTransfer](ctx, r.Pool, sql, id)
}
