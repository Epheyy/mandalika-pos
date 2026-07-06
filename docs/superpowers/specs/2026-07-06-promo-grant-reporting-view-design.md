# Promo Giveaway Report (grant-reporting-view) — Design

**Date:** 2026-07-06
**Branch:** `prod-hardening`
**Status:** Design approved — ready for implementation plan
**Slice:** the deferred `promo_reward_grants` reporting view — surfaces the reward-giveaway audit that buy-X-get-Y reward-fulfillment (SP-Promo-3b-reward) and bundle (SP-Promo-3b-bundle) write but nothing reads. Backend + backoffice only; the last small open item in the promotion module besides SP-Promo-4.

---

## Context
`promo_reward_grants` (migration 0039) records **one row per freed unit** given away by a promo: `order_id`, `promotion_id`, `product_id`, `product_name`, `variant_size`, `full_price`, `reward_price`, `reward_value` (= full − reward), `created_at`. It's written by both bxgy-reward fulfillment and bundle, indexed on `order_id` + `promotion_id`. Today the owner has **no way to see what free items have been handed out**. A per-order read fn (`RewardGrantsByOrder`) exists; the `PromoRewardGrant` OpenAPI schema exists but is **pruned from `api.gen.go`** (unreferenced — oapi-codegen drops unreferenced schemas until an endpoint uses it). There is no list/report endpoint and no UI.

Backoffice reporting lives in `apps/backoffice/src/screens/Reports.tsx` ("Laporan") — a tabbed hub (Transaksi / Ekspor / Shift) with a shared date-range picker, outlet scope (`useOutlet`), and permission gating (`view_transactions` / `view_reports`), using `usePolledQuery` + the generated API client.

## Decisions (locked during brainstorm)
1. **Shape = summary + drill-down list** (both, in one report).
2. **Filters = date range + outlet + promotion + product** (full filtering).
3. **Detail grain = grouped** (by order + promotion + product + variant, with a quantity + summed value) — not raw per-unit rows.
4. **Summary breakdowns = by promotion AND by product**, plus headline totals.
5. **Completed orders only** — exclude giveaways on refunded/cancelled orders (the item came back); the report is the true "given away and kept" cost.
6. **Read-only.** No POS, no APK, no migration. Backend endpoint + backoffice tab.
7. **Value metric = `reward_value`** (retail value of the freebie; for a free item = full price).

---

## 1. API — `GET /api/v1/promo-reward-grants`
One endpoint returns **both** the summary and the paginated grouped list, so the summary reflects the *entire* filtered set (the list is paginated; client-side aggregation of one page would be wrong).

**Query params** (all optional): `dateFrom`, `dateTo` (YYYY-MM-DD, inclusive, on `g.created_at` in WIB), `outletId`, `promotionId`, `productId`, `page` (default 1), `limit` (default 50).

**Response body** (new `PromoRewardGrantReport` schema):
```jsonc
{
  "summary": {
    "totalValue": 1250000,        // Σ reward_value over the filtered set
    "totalItems": 14,             // Σ quantity (freed units)
    "totalOrders": 9,             // distinct orders
    "byPromotion": [ { "promotionId": "…", "promotionName": "Paket Gorgeous", "value": 900000, "items": 8 } ],
    "byProduct":   [ { "productId": "…", "productName": "Atomizer 10ml", "variantSize": "", "value": 675000, "items": 6 } ]
  },
  "data": [                       // grouped rows, newest first, paginated
    { "orderId": "…", "orderNumber": "MND-000123", "promotionId": "…", "promotionName": "Paket Gorgeous",
      "productId": "…", "productName": "Atomizer 10ml", "variantSize": "",
      "quantity": 2, "fullPrice": 225000, "valueGivenAway": 450000, "createdAt": "…" }
  ],
  "meta": { "total": 37, "page": 1, "limit": 50 }   // total = # grouped rows
}
```

Permission: **`view_reports`** (matches Ekspor/Shift). Handler decodes query params → read repo → writes the enveloped body.

## 2. Read repo (`read/repo.go`)
A `PromoRewardGrantReport(ctx, filters, page, limit)` returning the summary + grouped page + total-group-count. Base filter joins for names + scope + the completed-only rule:
```sql
FROM promo_reward_grants g
JOIN orders o     ON o.id = g.order_id AND o.status = 'completed'
JOIN promotions p ON p.id = g.promotion_id
WHERE ($outletId = '' OR o.outlet_id = $outletId)
  AND ($promotionId = '' OR g.promotion_id = $promotionId)
  AND ($productId = '' OR g.product_id = $productId)
  AND ($dateFrom = '' OR g.created_at >= $dateFrom::date)          -- WIB day bounds
  AND ($dateTo   = '' OR g.created_at <  ($dateTo::date + 1))
```
- **Grouped list:** `GROUP BY g.order_id, o.order_number, g.promotion_id, p.name, g.product_id, g.product_name, g.variant_size, o.created_at` → `SUM(quantity=count(*))`, `SUM(g.reward_value)` as `valueGivenAway`, `MAX(g.full_price)` as unit fullPrice (identical within a group); the row's `createdAt` = `o.created_at` (the sale time, already in the GROUP BY); `ORDER BY o.created_at DESC` + `LIMIT/OFFSET` (reuse `off(page,limit)`). NOTE: each `promo_reward_grants` row is already one unit, so `count(*)` per group = quantity.
- **Total group count:** a `COUNT(*) FROM (…grouped subquery…)` for `meta.total`.
- **Summary aggregates** (over the full filtered set, ignore paging): `totalValue = SUM(reward_value)`, `totalItems = COUNT(*)`, `totalOrders = COUNT(DISTINCT order_id)`; `byPromotion` = `GROUP BY promotion_id, p.name` (value + count, `ORDER BY value DESC`); `byProduct` = `GROUP BY product_id, product_name, variant_size` (value + count, `ORDER BY value DESC`).
- Keep the date handling consistent with the existing WIB convention used elsewhere (grants `created_at` is `timestamptz`; the reporting hub filters by WIB day — mirror `Reports.tsx`'s `inRange`/the orders report bounds).

## 3. OpenAPI + codegen (the gap-class for a new endpoint)
- Enrich the existing `PromoRewardGrant` schema — it's currently the raw row (id/orderId/promotionId/productId/productName/variantSize/fullPrice/rewardPrice/rewardValue/createdAt). For the report, add the grouped shape as a new schema `PromoRewardGrantGroup` (orderNumber, promotionName, quantity, valueGivenAway) rather than overloading the raw one. Add `PromoGrantSummary` (+ `PromoGrantBreakdown` for the by-promo/by-product entries) and the `PromoRewardGrantReport` wrapper (`summary`, `data`, `meta`).
- Add the `GET /api/v1/promo-reward-grants` path with the query params + a 200 returning `PromoRewardGrantReport`.
- Regenerate `api.gen.go` (`make gen-check`) + `schema.d.ts` (`corepack pnpm@10.11.1 --filter @mandalika/api gen`). Referencing `PromoRewardGrantReport` from the path un-prunes the schemas.
- Wire the route in the server (mirror an existing report/list route registration) → the handler.

## 4. Backoffice — new "Hadiah Promo" tab in `Reports.tsx`
- Add `'grants'` to `ReportTab`; tab label "Hadiah Promo", gated on `view_reports` (like Ekspor/Shift). Add it to `visibleTabs`.
- The tab reuses the hub's `dateFrom`/`dateTo` + `outletId` scope; adds a **promotion** `<Select>` and a **product** `<Select>` (populate from `api.listPromotions()` / `api.listProducts()` — patterns already used elsewhere; or reuse loaded data). A "semua" (all) option = no filter.
- Data via `usePolledQuery` → new `api.listPromoRewardGrants({dateFrom,dateTo,outletId,promotionId,productId,page,limit})`.
- **Summary block:** headline cards (Total nilai hadiah / Jumlah item / Jumlah transaksi) + two compact breakdown tables ("Per Promosi", "Per Produk"), value formatted with the existing rupiah helper (`BRAND.currency.format`).
- **Detail table:** Tanggal · No. Order · Promosi · Produk (· varian) · Qty · Nilai — newest first, with the existing pagination affordance if the hub has one (else a simple page control; `limit` 50). Empty state ("Belum ada hadiah promo pada rentang ini").
- Keep `Reports.tsx` cohesive — if adding the tab pushes the file toward unwieldy, extract the grants tab into `screens/reports/PromoGrantsTab.tsx` (the screen already has sibling patterns; prefer a focused child component).

## 5. Testing & verification
- **Go:** table/integration test of `PromoRewardGrantReport` — grouping + quantity (a qty-2 giveaway → one group, quantity 2, value = 2×reward_value), completed-only (a refunded order's grants excluded), each filter (date/outlet/promo/product) narrows correctly, summary totals match the sum of the (unpaginated) rows, empty range → zeros + empty list. (Use a throwaway/seed harness like the prior slices, or the existing read-repo test setup if one exists.)
- **Backoffice:** tsc + vite build; the tab renders, filters re-fetch, empty state shows.
- **Gap-class / codegen:** `make gen-check` clean; `PromoRewardGrantReport`/`PromoRewardGrantGroup`/`PromoGrantSummary` present in `api.gen.go` + `schema.d.ts` (no longer pruned).
- **Live authed smoke** on the deployed rev: `GET /promo-reward-grants` returns 200 with the envelope; if the test DB has real giveaway data, spot-check totals; else create one bundle/bxgy order → confirm it appears → clean up. (Or note the DB may have no grants yet → empty-but-correct.)
- Deploy (NO migration); backoffice auto-deploys via Cloudflare on push. **No APK.**

## 6. Model routing & rollout
Sonnet implements. **Opus** reviews the read query (the join + completed-only + grouping + summary correctness — money-adjacent aggregation) + the OpenAPI/codegen. **Haiku** for the backoffice tab wiring/copy + spec-conformance. Additive endpoint + schemas; no migration; existing behavior untouched.

## Out of scope / deferred
- CSV/Excel export of the giveaway report (the hub's Ekspor tab is separate; add later if wanted).
- Gross-vs-net toggle (completed-only is the chosen default).
- Charts/trends over time (tables only this slice).
- SP-Promo-4 (outlet selector on the promo form, active-hours fields) — separate slice.
