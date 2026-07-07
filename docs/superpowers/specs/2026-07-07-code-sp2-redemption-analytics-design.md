# SP-Code-2 — Discount-Code Redemption Analytics (Design)

**Date:** 2026-07-07
**Branch:** `prod-hardening`
**Status:** Design approved — build
**Slice:** second of the discount-code series (SP-Code-1 bulk-gen done). A backoffice report of code performance — redemptions, value given, remaining quota — mirroring the grant-reporting-view pattern.

---

## Context
Discount codes have no performance report today (the Kode Diskon list shows `usage_count`/`usage_limit` but no VALUE given, no date/outlet breakdown). The data already exists: `orders.discount_breakdown` (jsonb array of `{label, kind?, value?, amount}`, mig 0008) where **a code's component is labeled with its code string** (`c.code`) and `amount` = that code's discount contribution (POS `CashierScreen.tsx:796`), plus `orders.applied_discount_codes` (jsonb array, mig 0036). **Per-code value comes from the breakdown component `amount`, NOT `orders.discount_amount`** (the combined total when codes/promos stack). This slice is a read-only report; it mirrors the grant-reporting-view slice (`docs/superpowers/{specs,plans}/2026-07-06-promo-grant-reporting-view*`).

## Decisions (locked during brainstorm)
1. **A new "Kode Diskon" tab in the Reports (Laporan) hub** (like the "Hadiah Promo" grants tab) — summary + per-code table + the hub's date-range + outlet scope.
2. **List = codes redeemed in the filtered range**, sorted by value given desc (not all codes / not zero-redemption ones).
3. **Columns:** code · linked-promotion name (if any) · redemptions · value given · remaining quota · status.
4. **Completed orders only**; **outlet via `scope(r)`** (the IDOR lesson — never a raw `outletId` param); **WIB day bounds** on dates.
5. Per-code value from the breakdown component amount (single source), joining `label → discount_codes.code` to isolate code components from promo/manual labels.
6. **No migration**, no POS/APK. Read-only.

---

## 1. API — `GET /api/v1/discount-code-report`
Gated `view_reports`. Query params: `dateFrom`, `dateTo` (WIB day), `page`, `limit`. (Outlet comes from `scope(r)` / the X-Outlet-Id header, NOT a query param — mirroring the grants-report fix.) Response `DiscountCodeReport` schema:
```jsonc
{
  "summary": { "totalRedemptions": 42, "totalValue": 1250000, "distinctCodes": 9 },
  "data": [ { "code": "RAYA7K9", "promotionName": "Promo Raya", "redemptions": 12,
             "valueGiven": 600000, "usageLimit": 100, "usageCount": 12, "remaining": 88,
             "status": "aktif" } ],
  "meta": { "total": 9, "page": 1, "limit": 50 }
}
```

## 2. Read repo (`read/repo.go`) — `DiscountCodeReport(ctx, scope, dateFrom, dateTo, page, limit)`
Base (shared) join isolates code components + applies completed-only + scope + WIB dates:
```sql
FROM orders o
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.discount_breakdown, '[]'::jsonb)) b
JOIN discount_codes dc ON dc.code = (b->>'label')
LEFT JOIN promotions p ON p.id = dc.promotion_id
WHERE o.status = 'completed'
  AND ($outlet = '' OR o.outlet_id::text = $outlet)
  AND ($dateFrom = '' OR o.created_at >= ($dateFrom::date)::timestamp AT TIME ZONE 'Asia/Jakarta')
  AND ($dateTo   = '' OR o.created_at <  (($dateTo::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
```
- **Per-code list** (`listJSON[api.DiscountCodeReportRow]`): `GROUP BY dc.id, b->>'label', p.name, dc.usage_limit, dc.usage_count, dc.is_active, dc.end_date`; select `code = b->>'label'`, `promotionName = p.name`, `redemptions = COUNT(DISTINCT o.id)`, `valueGiven = SUM((b->>'amount')::numeric)`, `usageLimit`, `usageCount`, `remaining` (usage_limit - usage_count, or null when usage_limit is null), and a **status** computed in Go from `is_active`/`end_date`/`usage_limit`/`usage_count`: `nonaktif` if `!is_active`; else `kedaluwarsa` if `end_date < today (WIB)`; else `kuota habis` if `usage_limit IS NOT NULL AND usage_count >= usage_limit`; else `aktif`. `ORDER BY valueGiven DESC` + `LIMIT/OFFSET`.
- **Summary** (over the full filtered set, separate aggregate): `totalRedemptions = COUNT(DISTINCT o.id)` over all code components, `totalValue = SUM((b->>'amount')::numeric)`, `distinctCodes = COUNT(DISTINCT b->>'label')`.
- **Total** = COUNT over the grouped subquery (# code rows) for `meta`.
- Mirror the WIB-bound + `scope`-based-outlet + completed-only conventions from `read.PromoRewardGrantReport`. Guard `jsonb_array_elements` with `COALESCE(...,'[]')`.

## 3. OpenAPI + codegen
- `DiscountCodeReportRow` (code/promotionName/redemptions/valueGiven/usageLimit/usageCount/remaining/status), `DiscountCodeReportSummary` (totalRedemptions/totalValue/distinctCodes), `DiscountCodeReport` (`{summary, data, meta}` — `meta` → `Meta`). Path `GET /api/v1/discount-code-report` → `DiscountCodeReport`. Regenerate `api.gen.go` + `schema.d.ts` (`make gen-check`).

## 4. Handler + route
`DiscountCodeReport` handler (mirror `PromoRewardGrants`): `pageLimit(r)`, `scope(r)` for the outlet, `dateFrom`/`dateTo` query params → read fn → `writeJSON` the `{summary, data, meta}` envelope. Route `GET /discount-code-report` in the `view_reports` group.

## 5. Client + backoffice tab
- Client `listDiscountCodeReport(opts) => Promise<DiscountCodeReport>` (raw `request<DiscountCodeReport>`, like `listPromoRewardGrants`).
- A new `'codeReport'` tab in `Reports.tsx` labeled **"Kode Diskon"** (gated `canViewReports`), body = `screens/reports/DiscountCodeReportTab.tsx`: summary cards (Total penukaran / Total nilai diskon / Jumlah kode) + a per-code table (Kode · Promosi · Penukaran · Nilai · Sisa kuota · Status, with a status badge) + reusing the hub date-range + outlet scope. Empty state when no redemptions. Mirror `PromoGrantsTab.tsx`.

## 6. Testing & verification
- **Go:** the status-deriving helper (pure) — table test (nonaktif/kedaluwarsa/kuota habis/aktif). The DB query has no unit harness → the live e2e proves it.
- **Live e2e** (throwaway `cmd/codereport`, real read repo, zero-residue): seed a code + completed orders with a `discount_breakdown` component labeled that code (amounts), + a refunded order (excluded) + an unrelated promo/manual breakdown line (not counted) → assert redemptions/value/summary/completed-only/label-isolation; date/outlet filters narrow. Run local or Neon per [[neon-e2e-verification]].
- **Gap-class/codegen:** `make gen-check` clean; types present. Local gate + backoffice tsc/vite.
- **Live authed smoke** on the deployed rev: `GET /discount-code-report` → 200 envelope.
- **USER-PENDING (live):** Laporan → Kode Diskon shows redeemed codes with value/remaining/status.

## 7. Model routing & rollout
Sonnet implements; **Opus** reviews the read query (the breakdown-unnest join + value attribution + scope/completed-only) + type-gen; Haiku/Sonnet the tab. Deploy (no migration) + Cloudflare backoffice; no APK.

## Out of scope / deferred
- Showing UNUSED codes / zero-redemption codes (this report is redemptions).
- Per-day time-series/charts (table only).
- SP-Code-3 (per-customer cap), SP-Code-4 (customer-assigned).
