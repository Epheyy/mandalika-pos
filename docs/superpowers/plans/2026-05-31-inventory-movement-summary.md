# Inventory Movement Summary Plan

> Single-session implementation. Per-location product movement report with date range + pagination.

**Goal:** Add a "Pergerakan" (Movement) sub-view under Inventori → Stok Produk that shows a per-product-variant summary of stock movements at a chosen location over a date range. Columns: current stock, goods-in, sold, refunded/cancelled, transfer in, transfer out, adjustment count, opname diff. Filterable by location + date range. Paginated (25/50/100 page-size dropdown from F4).

## Locked decisions
- **Products only** (not ingredients) for now.
- **Single location at a time** (kind + id; required).
- **Per-variant rows** (one row per product variant).
- **Default date range:** last 30 days.
- **Adjustments column:** COUNT of adjustments in range (no delta computation — koreksi sets absolute, prior value not tracked; count gives a useful "how often" signal). The Lokasi view + history is the drill-down.
- **Opname column:** SUM of `stock_count_items.difference` for stock counts completed in range at this location.
- **For warehouses:** Terjual + Refund/Batal columns show "—" (warehouses don't sell). All other columns apply.
- **Bundles:** order_items where `is_bundle=true` are EXCLUDED from the sold/refunded counts to avoid double-counting (bundles typically map to component lines too).
- **Refund/cancel timestamp:** `COALESCE(refunded_at, created_at)` — orders table has no `cancelled_at`, so cancelled-status rows fall back to `created_at`. Note this in the spec; minor edge case in practice.
- **UI placement:** new sub-tab in `StokProduk.tsx` alongside Lokasi + Overview. Sub-tab label: **Pergerakan**.
- **Permissions:** `manage_inventory`.

## Backend

### New SQL — `MovementSummary` in `backend/internal/read/repo.go`

Signature:
```go
func (r *Repo) MovementSummary(ctx context.Context, kind, id, from, to string, page, limit int) ([]api.MovementSummaryRow, int, error)
```

One query with CTEs (one CTE per movement type) then LEFT JOINs onto the variant catalog. Pseudo-shape (outlet version):
```sql
WITH variant_base AS (
  SELECT v.product_id, v.size, p.name AS product_name, COALESCE(v.sku,'') AS sku
  FROM product_variants v JOIN products p ON p.id = v.product_id
  WHERE p.is_active
),
cur AS (
  SELECT product_id, variant_size, stock FROM outlet_variant_stock WHERE outlet_id = $1
),
gin AS (
  SELECT gri.product_id, gri.variant_size, SUM(gri.qty) AS qty
  FROM goods_receipt_items gri
  JOIN goods_receipts gr ON gr.id = gri.receipt_id
  WHERE gr.outlet_id = $1 AND gr.created_at >= $2 AND gr.created_at < $3
  GROUP BY 1,2
),
sold AS (
  SELECT oi.product_id, oi.variant_size, SUM(oi.quantity) AS qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.outlet_id = $1 AND o.status = 'completed' AND oi.is_bundle = false
    AND o.created_at >= $2 AND o.created_at < $3
  GROUP BY 1,2
),
refunded AS (
  SELECT oi.product_id, oi.variant_size, SUM(oi.quantity) AS qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.outlet_id = $1 AND o.status IN ('refunded','cancelled') AND oi.is_bundle = false
    AND COALESCE(o.refunded_at, o.created_at) >= $2
    AND COALESCE(o.refunded_at, o.created_at) < $3
  GROUP BY 1,2
),
tin AS (
  SELECT ti.product_id, ti.variant_size, SUM(ti.received_qty) AS qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.dest_outlet_id = $1 AND t.status = 'completed'
    AND t.received_at >= $2 AND t.received_at < $3
  GROUP BY 1,2
),
tout AS (
  SELECT ti.product_id, ti.variant_size, SUM(ti.sent_qty) AS qty
  FROM transfer_items ti
  JOIN transfers t ON t.id = ti.transfer_id
  WHERE t.source_outlet_id = $1 AND t.status = 'completed'
    AND t.sent_at >= $2 AND t.sent_at < $3
  GROUP BY 1,2
),
adj AS (
  SELECT wsa.product_id, wsa.variant_size, COUNT(*) AS cnt
  FROM warehouse_stock_adjustments wsa
  WHERE wsa.outlet_id = $1
    AND wsa.created_at >= $2 AND wsa.created_at < $3
  GROUP BY 1,2
),
opn AS (
  SELECT sci.product_id, sci.variant_size, SUM(COALESCE(sci.difference, 0)) AS diff
  FROM stock_count_items sci
  JOIN stock_counts sc ON sc.id = sci.stock_count_id
  WHERE sc.outlet_id = $1 AND sc.status = 'completed'
    AND sc.completed_at >= $2 AND sc.completed_at < $3
  GROUP BY 1,2
)
SELECT json_build_object(
  'productId', vb.product_id, 'productName', vb.product_name, 'variantSize', vb.size, 'sku', vb.sku,
  'currentStock', COALESCE(cur.stock, 0),
  'goodsIn', COALESCE(gin.qty, 0),
  'sold', COALESCE(sold.qty, 0),
  'refunded', COALESCE(refunded.qty, 0),
  'transferIn', COALESCE(tin.qty, 0),
  'transferOut', COALESCE(tout.qty, 0),
  'adjustmentCount', COALESCE(adj.cnt, 0),
  'opnameDiff', COALESCE(opn.diff, 0)
), COUNT(*) OVER ()
FROM variant_base vb
LEFT JOIN cur      ON cur.product_id = vb.product_id      AND cur.variant_size = vb.size
LEFT JOIN gin      ON gin.product_id = vb.product_id      AND gin.variant_size = vb.size
LEFT JOIN sold     ON sold.product_id = vb.product_id     AND sold.variant_size = vb.size
LEFT JOIN refunded ON refunded.product_id = vb.product_id AND refunded.variant_size = vb.size
LEFT JOIN tin      ON tin.product_id = vb.product_id      AND tin.variant_size = vb.size
LEFT JOIN tout     ON tout.product_id = vb.product_id     AND tout.variant_size = vb.size
LEFT JOIN adj      ON adj.product_id = vb.product_id      AND adj.variant_size = vb.size
LEFT JOIN opn      ON opn.product_id = vb.product_id      AND opn.variant_size = vb.size
ORDER BY vb.product_name, vb.size
LIMIT $4 OFFSET $5
```

For `kind = 'warehouse'`:
- Replace `outlet_id` with `warehouse_id` in: `cur` (use `warehouse_variant_stock`), `gin`, `tin`, `tout`, `adj`, `opn` CTEs.
- DROP the `sold` and `refunded` CTEs (warehouses don't sell). Set those fields to 0 in the output.

Build the SQL string conditionally based on `kind`. The Go function returns `([]api.MovementSummaryRow, int (total), error)` — use the `COUNT(*) OVER ()` window function pattern (existing repo uses this for paginated listJSON-style reads — check `IngredientTransfers` for an example).

### OpenAPI

Add to `backend/api/openapi.yaml`:
```yaml
MovementSummaryRow:
  type: object
  required: [productId, productName, variantSize, sku, currentStock, goodsIn, sold, refunded, transferIn, transferOut, adjustmentCount, opnameDiff]
  properties:
    productId: { type: string, format: uuid }
    productName: { type: string }
    variantSize: { type: string }
    sku: { type: string }
    currentStock: { type: integer }
    goodsIn: { type: integer }
    sold: { type: integer }
    refunded: { type: integer }
    transferIn: { type: integer }
    transferOut: { type: integer }
    adjustmentCount: { type: integer }
    opnameDiff: { type: integer }
MovementSummaryResponse:
  type: object
  required: [data, meta]
  properties:
    data: { type: array, items: { $ref: '#/components/schemas/MovementSummaryRow' } }
    meta: { $ref: '#/components/schemas/Meta' }
```

Path (next to other `/inventory/*` paths):
```yaml
/api/v1/inventory/movement-summary:
  get:
    operationId: getMovementSummary
    tags: [catalog]
    summary: Per-location product movement summary (Backoffice)
    parameters:
      - { name: kind, in: query, required: true, schema: { type: string, enum: [outlet, warehouse] } }
      - { name: id, in: query, required: true, schema: { type: string, format: uuid } }
      - { name: from, in: query, required: true, schema: { type: string, format: date-time }, description: "Inclusive ISO start (UTC)" }
      - { name: to, in: query, required: true, schema: { type: string, format: date-time }, description: "Exclusive ISO end (UTC)" }
      - { name: page, in: query, schema: { type: integer, default: 1 } }
      - { name: limit, in: query, schema: { type: integer, default: 25 } }
    responses:
      '200':
        description: movement summary
        content:
          application/json:
            schema: { $ref: '#/components/schemas/MovementSummaryResponse' }
```

### Handler + route

New handler in `writes.go` (this file already has the other inventory read handlers like `InventoryOverview` — colocate):
```go
func (h *Handlers) MovementSummary(w http.ResponseWriter, r *http.Request) {
    kind := r.URL.Query().Get("kind")
    id := r.URL.Query().Get("id")
    from := r.URL.Query().Get("from")
    to := r.URL.Query().Get("to")
    if (kind != "outlet" && kind != "warehouse") || id == "" || from == "" || to == "" {
        httpx.Err(w, http.StatusBadRequest, "kind, id, from, to wajib")
        return
    }
    p, l := pageLimit(r)
    rows, total, err := h.Repo.MovementSummary(r.Context(), kind, id, from, to, p, l)
    if err != nil {
        writeErr(w, 500, err)
        return
    }
    writeJSON(w, http.StatusOK, api.MovementSummaryResponse{Data: rows, Meta: *meta(total, p, l)})
}
```

Route in `server.go` manage_inventory group:
```go
r.Get("/inventory/movement-summary", h.MovementSummary)
```

### TS client method

```ts
getMovementSummary: (params: { kind: 'outlet'|'warehouse'; id: string; from: string; to: string; page?: number; limit?: number }) => Promise<MovementSummaryResponse>
```

Implementation builds query string and calls `request<MovementSummaryResponse>('GET', ...)`. Use `request<T>` (no envelope unwrap) — the response is `{data, meta}` per the schema. Actually since data envelope IS standard, prefer `data<MovementSummaryRow[]>` if a matching helper exists; otherwise raw `request`. Match existing paginated reads like `listErrorLogs` / `listIngredientTransfers`.

## Frontend

### New component: `apps/backoffice/src/screens/inventory/MovementSummary.tsx`

- Header: Location picker (`<Select>` with optgroups outlets+warehouses), Date range (`<input type="date">` × 2 labeled "Dari" + "Sampai" — default last-30-days), optional product name filter (client-side substring on rendered rows, deferred to v2 if pagination conflicts).
- Default location: first active outlet. Default `from` = today - 30 days, default `to` = today (+1 to make end-exclusive on midnight UTC).
- Data: `usePolledQuery(() => api.getMovementSummary({...}), [kind, id, fromIso, toIso, page, pageSize])`.
- Table: columns `Produk · Ukuran · SKU · Stok Saat Ini · Stok Masuk · Terjual · Refund/Batal · Transfer Masuk · Transfer Keluar · Koreksi · Selisih Opname`. For warehouse: render "—" in Terjual + Refund/Batal cells.
- Pagination using `<Pagination/>` with the new pageSize dropdown.
- Loading skeleton + EmptyState consistent with the other screens.

### Wire into `StokProduk.tsx`

Add a third sub-tab "Pergerakan". Update `SUB_TABS` to `[Lokasi, Overview, Pergerakan]`. Render `<MovementSummary/>` when `subTab === 'pergerakan'`.

## Tasks (single subagent dispatch)

1. Backend: SQL + handler + route + OpenAPI + regen + TS client (one cohesive backend commit).
2. Frontend: MovementSummary.tsx + sub-tab wiring (one frontend commit).
3. Deploy backend.
4. Push branch (Cloudflare deploys frontend).
5. Quick auth-free smoke (probe route → expect 401), then a tiny authed verification (login, hit endpoint with a real location + 7-day range, assert 200 + plausible structure).
