# Customer rating of the salesperson — plan (2026-11-27)

Branch `claude/customer-rating` @ 41afd3fe. Migration **0103**. COO demo TODAY. **[D]** = demo-critical, **[L]** = can land after the demo.
Planner: Opus (high). Owner approved 2026-11-27: click-to-chat via `https://wa.me` now (Cloud API = phase 2, out of scope);
demo tablet has WhatsApp Business with the outlet number; raw run.app URL is fine for the link (custom domain later via env).

## Locked decisions

- One salesperson per order (`orders.salesman_id` / `salesman_name`, chosen from staff users). None → rating stored with
  salesman NULL, shown "Tanpa sales"; `{sales}` falls back to "tim kami".
- Server renders the message; POS never sees the template (no sync snapshot / SyncEngine / outbox change).
- Many `receipt_links` per order (one per send; a re-send never invalidates an earlier message); one `order_ratings` row per
  order, first wins. Token 128-bit crypto random, base64url (22 chars); only SHA-256 stored; expires 7 days after creation.
- Recipient: the order's customer phone or a number the cashier types; normalised to `62…` digits; stored masked `****1234`.
  UU PDP note: no full number stored on the link, page shows the first name only.
- Public page: server-rendered `html/template`, no JavaScript, "Kertas & Emas" look; strict CSP; own rate-limit buckets
  keyed by `clientip` only; link base from env `PUBLIC_LINK_BASE_URL` (never the Host header).
- Self-rating: FLAG, never block. `flag_fast` (< 60 s after link creation), `flag_same_network` (per-link salt +
  SHA-256(salt || client IP bucket) compared at submit; only the boolean is kept; no raw IPs).
- Business date = `orders.business_date` (per-outlet zone, `order_business_date()` from 0059), NOT a fixed WIB.
- Template is its own `app_settings` column with its own endpoints; NOT added to `read.AppSettings` (that struct is in the
  POS sync pull, `backend/internal/sync/pull.go:173`).
- Reports take `dateFrom`/`dateTo` like every other report tab; the month picker sets the Laporan hub's Dari/Sampai.
- Revenue reuses the `ReportSummary` net-sales formula so totals match the dashboard (parity asserted in the PG gate).

## Step 0 — contract (before the work packages)

Review tier: Opus (generated types). Files: 0103 SQL, `backend/api/openapi.yaml`, regenerated `backend/internal/api/api.gen.go`
+ `packages/api/src/schema.d.ts`, `packages/api/src/client.ts`, `packages/types/src/waReceipt.ts` (+ test, vectors, index export).

### 0.1 `backend/internal/db/migrations/0103_customer_ratings.sql`
`app_settings` first (0079 lock-order note: app_settings before orders, avoids deadlock with a live sale).

```sql
-- 0103: customer rating of the salesperson via a WhatsApp receipt link. Additive.
-- app_settings first, then the tables that reference orders (lock order of 0079).
-- Tokens are never stored (SHA-256 only); the recipient is stored masked; no raw IPs.
SET LOCAL lock_timeout = '5s';

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS wa_receipt_template text
  CHECK (wa_receipt_template IS NULL OR char_length(wa_receipt_template) BETWEEN 1 AND 1000);

CREATE TABLE receipt_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  outlet_id        uuid NOT NULL,
  token_hash       bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  recipient_masked text NOT NULL,
  recipient_source text NOT NULL CHECK (recipient_source IN ('customer','typed')),
  created_by       uuid NOT NULL,
  created_by_name  text NOT NULL DEFAULT '',
  device_id        text,
  net_salt         bytea NOT NULL CHECK (octet_length(net_salt) = 16),
  net_hash         bytea NOT NULL CHECK (octet_length(net_hash) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX idx_receipt_links_order ON receipt_links (order_id);

CREATE TABLE order_ratings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  link_id           uuid NOT NULL REFERENCES receipt_links(id) ON DELETE CASCADE,
  outlet_id         uuid NOT NULL,
  salesman_id       uuid,
  salesman_name     text,
  business_date     date NOT NULL,           -- copy of orders.business_date (outlet zone, 0059)
  stars             smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags              text[] NOT NULL DEFAULT '{}'
                    CHECK (tags <@ ARRAY['ramah','membantu','paham_produk','cepat']::text[]),
  comment           text CHECK (comment IS NULL OR char_length(comment) <= 500),
  flag_fast         boolean NOT NULL DEFAULT false,
  flag_same_network boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_ratings_period ON order_ratings (business_date, outlet_id);
CREATE INDEX idx_order_ratings_salesman ON order_ratings (salesman_id, business_date);
```

### 0.2 OpenAPI (`backend/api/openapi.yaml`)
Authed routes use the global `bearerAuth`. **No `nullable` anywhere** (optional = absent; avoids the `$ref`+nullable gotcha
and `TestApprovedNullableFields`). `/r/{token}` stays out of the spec, like `/ota/check`.

| Path | Op | operationId | Guard (server.go) | Body / params | Responses |
|---|---|---|---|---|---|
| `/api/v1/receipt-links` | POST | `createReceiptLink` | authed group (any role, like `POST /orders`, server.go:204), `scope(r)`, own `RateLimit(c,"wa-link",30,min)` | `ReceiptLinkRequest` | 201 `ReceiptLinkResponse`; 400 (both/neither id, bad phone, no phone); 403 no active outlet; 404 `orderId` not in scope; 409 `orderUuid` not on server ("Order belum tersinkron") or status not completed/partially_refunded; 429 |
| `/api/v1/settings/wa-receipt-template` | GET | `getWaReceiptTemplate` | `manage_settings` group (server.go ~405) | — | 200 `WaReceiptTemplateResponse` |
| same | PUT | `updateWaReceiptTemplate` | `manage_settings` | `{template: string}` ("" = reset to default) | 200 same; 400 missing `{tautan}` / unknown placeholder / > 1000 chars |
| `/api/v1/reports/sales-performance` | GET | `getSalesPerformance` | `view_reports` group (server.go:453) | `dateFrom`, `dateTo` (required YYYY-MM-DD, `dayRange`), `outletId` | 200 `SalesPerformanceReport`; 400; 403 |
| `/api/v1/reports/sales-ratings` | GET | `listSalesRatings` | `view_reports` | `dateFrom`, `dateTo`, `outletId`, `salesmanId` (uuid or `none`), `flaggedOnly` (bool), `page`, `limit` | 200 `SalesRatingList` (`data` + `Meta`) |

Schemas:
- `ReceiptLinkRequest`: `orderUuid?` uuid; `orderId?` uuid; `phone?` string maxLength 32; `deviceId?` string maxLength 128.
- `ReceiptLink`: required `[url, message, waUrl, expiresAt, phoneMasked]`, strings; `expiresAt` date-time.
- `ReceiptLinkResponse`: `{data: ReceiptLink}`.
- `WaReceiptTemplate`: required `[template, isDefault, defaultTemplate, placeholders]`; `placeholders` string[].
- `WaReceiptTemplateResponse`: `{data: WaReceiptTemplate}`.
- `SalesPerformanceRow`: required `[salesmanName, transactions, revenue, receiptsSent, ratingsReceived, responseRate, starCounts, flaggedCount, latestComments]`;
  `salesmanId?` uuid (absent = "Tanpa sales"); `revenue` double; `responseRate` double 0–1; `avgStars?` double (absent when no ratings);
  `starCounts` integer[5] (index 0 = 1 star); `latestComments` ≤ 3 × `{stars, comment, createdAt}`.
- `SalesPerformanceReport`: required `[data, totals]`; `data` = `SalesPerformanceRow[]`; `totals` = same fields minus ids/comments.
- `SalesRating`: required `[id, orderId, orderNumber, outletId, salesmanName, stars, tags, flagFast, flagSameNetwork, businessDate, createdAt]`;
  `salesmanId?`, `comment?`, `outletName?`.
- `SalesRatingList`: `{data: SalesRating[], meta: Meta}`.

Regenerate: `cd backend && go run ./cmd/codegen` (= `make gen-go`), then `corepack pnpm --filter @mandalika/api gen`. Never hand-edit.

### 0.3 `packages/api/src/client.ts`
Type aliases near line 158: `ReceiptLink`, `WaReceiptTemplate`, `SalesPerformanceReport`, `SalesPerformanceRow`, `SalesRating`.
Five `Api` methods (near line 480 / implementation ~1057), mirroring `crossOutletLookup`, `listCrossOutletLookups`, `getVoidReport`:

```ts
createReceiptLink: (b: { orderUuid?: string; orderId?: string; phone?: string; deviceId?: string }) => Promise<ReceiptLink>  // data('POST', `${API}/receipt-links`, b)
getWaReceiptTemplate: () => Promise<WaReceiptTemplate>
updateWaReceiptTemplate: (template: string) => Promise<WaReceiptTemplate>
getSalesPerformance: (o: { dateFrom: string; dateTo: string; outletId?: string }) => Promise<SalesPerformanceReport>
listSalesRatings: (p?: Record<string, string | number | boolean>) => Promise<ListResult<SalesRating>>
```

### 0.4 Shared template module — `packages/types/src/waReceipt.ts` (exported from `index.ts`)
Go twin: `backend/internal/receiptlink/template.go` (work package A).
- `WA_PLACEHOLDERS = ['{pelanggan}','{sales}','{outlet}','{no_order}','{total}','{tautan}'] as const`
- `DEFAULT_WA_TEMPLATE`:
  `Halo {pelanggan}, terima kasih sudah berbelanja di {outlet}.\n\nStruk digital pesanan {no_order} (total {total}):\n{tautan}\n\nBagaimana pelayanan {sales} hari ini? Mohon beri penilaian lewat tautan di atas, cukup 10 detik. Tautan berlaku 7 hari.`
- `renderWaTemplate(tpl, {customerName, salesmanName, outletName, orderNumber, total, link})`: single pass (a value containing
  `{sales}` is never re-expanded); each value whitespace/newline-collapsed and trimmed; `{pelanggan}` = first word of the
  customer name or "Kak"; `{sales}` fallback "tim kami"; unknown `{x}` kept literally.
- `formatRupiahWa(n)`: `"Rp " + "."-grouped`, rounded to the rupiah ("Rp 150.000"); no `Intl` (NBSP).
- `validateWaTemplate(tpl)`: null when OK, else a Bahasa Indonesia message; `{tautan}` required; any `{word}` not in the list
  rejected; 1–1000 runes.
- `waDigits(raw)`: `normalizePhone` (from `./phone`), leading `0` → `62`; digits only, 10–15 long, else `''`.
- `maskPhone(d)`: `'****' + last 4`.
- `WA_SAMPLE_VALUES`: sample values for the Backoffice preview.

`packages/types/src/__fixtures__/wa-receipt-vectors.json` sections: `render` (default template, fallbacks, no recursive
expansion, unknown `{x}` literal), `validate`, `rupiah` (`0`, `150000`, `1234567.5 → "Rp 1.234.568"`), `waDigits`
(`0812-3456-7890`, `+62 812…`, `62…`, `812…`, `+1 415 555 0100`, `123 → ""`), `mask`, `waUrl`
(`https://wa.me/<digits>?text=<QueryEscape with + → %20>`). Test `packages/types/src/waReceipt.test.ts` reads the vectors.

Step 0 verify: `corepack pnpm gen:check`; `cd backend && go build ./... && go run ./cmd/codegen -check`;
`corepack pnpm -r typecheck` (catches fake `Api` objects in tests); `corepack pnpm --filter @mandalika/types test`.

## Work package A — Backend (Sonnet implements, Opus reviews: public surface, client IP, orders)
Owns `backend/**` (except Step 0 files) and `scripts/ci/postgres_gate.py`.

| # | File | Change | Mirrors |
|---|---|---|---|
| A1 [D] | `backend/internal/receiptlink/` (new leaf; stdlib + `internal/phone` only) | `token.go`: `NewToken()` 16 bytes crypto/rand → base64url (22) + sha256; `HashToken(s)` → hash, ok (shape `^[A-Za-z0-9_-]{22}$`). `template.go`: Go twin of 0.4 (`Placeholders`, `DefaultTemplate`, `Render`, `Validate`, `FormatRupiah`, `WaDigits`, `MaskPhone`, `WaURL`). `netflag.go`: `NewSalt()`, `NetHash(salt, bucket)`. `page.go` + embedded `page.html` / `gone.html` (`html/template`): `SetPublicHeaders(w)`, `RenderReceipt(w, PageData)`, `RenderGone(w)`. | `formatRupiahID` `service/void_replace.go:186`; `phone.Normalize` |
| A2 [D] | `backend/internal/archtest/arch_test.go:31` | add `"receiptlink": leaf` | — |
| A3 [D] | `backend/internal/config/config.go` (+ test) | `PublicLinkBaseURL` from `PUBLIC_LINK_BASE_URL`, default `https://mandalika-pos-538849926142.asia-southeast2.run.app`; `url.Parse`, https only (http only for localhost when not prod), host required, no query/fragment, trailing `/` trimmed; bad value fails `Validate()`. | `parseXOLookup` config.go:188, `xoLookupBad` :324 |
| A4 [D] | `backend/internal/write/receipt_links.go` | `InsertReceiptLink`; `InsertOrderRating` (`ON CONFLICT (order_id) DO NOTHING`, returns inserted); `SetWaReceiptTemplate(*string)` (NULL when empty or equal to default). | `UpdateAppSettingsBy` write/settings.go:51 |
| A5 [D] | `backend/internal/read/receipt_links.go` | `ReceiptLinkOrder(ctx, sc Scope, byUUID, id)` (order + outlet name + `customers.phone`, scoped like `Repo.Order` read/orders.go:152); `ReceiptLinkByHash(ctx, hash)` (`expires_at > now()`, joins existing rating); `ReceiptPage(ctx, orderID)` (lines, discount, tax, total, payment label from `app_settings.payment_methods`/tenders, outlet name + zone, `documents_brand_name`, customer FIRST NAME only); `WaReceiptTemplate(ctx)`. | `read/settings.go` |
| A6 [D] | `backend/internal/read/sales_performance.go` | `SalesPerformance(ctx, OrderFilter)` + `SalesRatings(ctx, f, salesman, flaggedOnly, page, limit)`. Revenue = `ReportSummary` formula (reports.go:33-125): sale set via `appendOrderWhere(saleBasis)` status IN (completed, partially_refunded, refunded), gross = SUM(total); refunds via `orders o JOIN order_refunds r` + `appendOrderWhere(refundBasis, refundRows=true)`; group both by `o.salesman_id`, FULL JOIN `IS NOT DISTINCT FROM`. transactions = count(completed, partially_refunded); receiptsSent = sale-set orders with ≥ 1 link; ratings/starCounts/avg/flagged from `order_ratings JOIN sale set`; latest 3 comments via LATERAL. **Do not edit `summarySaleCTEs`** (A27 gate). | `ReportSummary`, `PromoRewardGrantReport` |
| A7 [D] | `backend/internal/handlers/receipt_links.go` | `CreateReceiptLink`: strict `httpx.Decode`; exactly one id; `scope(r)` + `requireActiveOutlet`; uuid not found → 409 "Order belum tersinkron"; phone typed → `WaDigits` or 400 "Nomor WhatsApp tidak valid"; empty → customer phone or 400 "Nomor WhatsApp wajib diisi"; salt + `NetHash(salt, clientip.ClientIPBucket(r))`; expires now+7d; render stored-or-default template; 201. Never log token or phone. | `CrossOutletLookup` cross_outlet_lookup.go:142 |
| A8 [D] | `backend/internal/handlers/receipt_page.go` | GET `ReceiptPage` / POST `SubmitReceiptRating`: `MaxBytesReader` 8 KiB, `ParseForm`; stars 1–5 required (else re-render 400 with error); tags allowlist; comment trimmed, control chars stripped, ≤ 500 runes; flags (fast < 60 s, same_network = NetHash equal); insert then 303 to `/r/{token}` (relative). Unknown / expired / bad-shape token → the **same 404 `gone.html` body**. Every response: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, `Content-Type: text/html; charset=utf-8`. | `OtaCheck` handlers/ota.go:44 |
| A9 [D] | `backend/internal/handlers/wa_template.go`, `sales_performance.go` | Template GET/PUT (`Validate`); report handlers reuse `summaryFilter`-style parsing (`dayRange`, `scope(r)`, order_filter.go:73) and `pageLimit`/`meta`. Not wrapped in `h.cached` (ratings change live). | `ReportSummary` handlers.go:510, void report |
| A10 [D] | `backend/internal/handlers/handlers.go` | field `linkBase string` + `SetReceiptLinkBase(s)` | `SetCrossOutletLookupLimit` |
| A11 [D] | `backend/internal/server/server.go` | `h.SetReceiptLinkBase(cfg.PublicLinkBaseURL)` (~line 121). Root-level public groups outside `/api/v1`: `RateLimit(c,"receipt-view",60,min)` + `Get("/r/{token}")`; `RateLimit(c,"receipt-rate",10,min)` + `Post("/r/{token}")`. Authed: `r.With(mw.RateLimit(c,"wa-link",30,min)).Post("/receipt-links", …)` after ~line 204. Template GET/PUT in `manage_settings`; reports in `view_reports`. | "ota" group server.go:152 |
| A12 [L] | `backend/internal/server/bodylimit.go` (+ test) | exception `POST /r/{token}` 8 KiB | `bodyLimitExceptions` |
| A13 [D] | unit tests | `receiptlink/*_test.go`: vectors from `../../../packages/types/src/__fixtures__/wa-receipt-vectors.json`, token shape/hash, page has no `<script`, `<b>` name escaped, gone body identical for unknown vs expired. `server/public_receipt_routes_test.go`: `chi.Walk` (as `customer_routes_privacy_test.go:43`) asserts the EXACT set of routes reachable without auth (`/healthz`, `/livez`, `/readyz`, `/api/v1/auth/{login,refresh,logout}`, `/api/v1/ota/check`, the two `/internal/erp/*`, `GET`+`POST /r/{token}`); unauthenticated `/api/v1/receipt-links` → 401; 11th POST `/r/x` from one IP → 429. `config_test.go`. | — |
| A14 [D] | `backend/internal/handlers/customer_rating_integration_test.go` + `scripts/ci/postgres_gate.py` GATES `("CR","TestCustomerRatingPostgres",26488,"cr")` | `gatePool(t,"CR",26488)`. Cases: unsynced uuid → 409; create → 201, row has hash + masked phone, DB holds no raw phone/token; GET shows lines + total, no phone / full name; POST → 303 + one row with the order's business_date; second POST adds no row, shows "Terima kasih, penilaian sudah diterima"; expired → identical 404; flags; NULL salesman → "Tanpa sales"; **Σ revenue = `ReportSummary.netSales` and Σ transactions = `totalOrders` for the same filter, incl. a partial refund on another day**; manager without coverage sees only own outlet; template PUT validation. | `TestCrossOutletLookupGuardPostgres` (26487) |

Guards that apply: `internal/archtest/arch_test.go` tier list; `internal/server/revocation_guard_test.go` (every
`mw.RequireAuth` passes `WithRevocation`); `realip_guard_test.go`; `handlers/errsanitize_scan_test.go`. No new top-level
tests in `internal/api` / `internal/codegen` (codegen gate untouched).

Verify: `cd backend && go vet ./... && go test ./internal/receiptlink ./internal/config ./internal/server ./internal/archtest ./internal/handlers -run 'Receipt|Rating|Public|Import|Revocation|RealIP|NoRawError'`;
`python scripts/ci/postgres_gate.py` (CR); `go run ./cmd/codegen -check`; local smoke with `PUBLIC_LINK_BASE_URL=http://localhost:8080`.

## Work package B — POS (Sonnet implements, Opus reviews: online/synced state of orders; SyncEngine untouched)
Owns `apps/pos/**`.

| # | File | Change | Mirrors |
|---|---|---|---|
| B0 [D] | tablet (adb + CDP, read-only) | before building, check `window.open('https://wa.me/62…?text=hi','_system')` opens WhatsApp from a click handler (no tablet attached 2026-11-27 morning → do at the walkthrough) | `CashierScreen.tsx:1763` |
| B1 [D] | `apps/pos/src/cashier/waReceipt/sendWaReceipt.ts` (+ test) | `createWaLink(api, target, phone)`: blocked offline (`WA_OFFLINE = 'Butuh internet'`); `waErrorMessage(e)`: 409 → "Order belum tersinkron, coba lagi sebentar", 429 → wait from Retry-After, 400 → server text; client `waDigits` check before the call. | `crossOutletLookup.ts` (`lookupErrorMessage`, `CROSS_OFFLINE_SEARCH`) |
| B2 [D] | `apps/pos/src/cashier/waReceipt/WaReceiptSheet.tsx` (+ test) | sheet: phone input (prefilled, editable, `inputMode="tel"`); "Buat pesan" → create; message preview; then a SEPARATE "Buka WhatsApp" button calling `window.open(link.waUrl,'_system')` synchronously in its own click (avoid non-gesture popup blocking). If not synced (`orderState !== 'synced'`), call the `flush` prop (`useOfflineData` flush → `engine.flushNow()`, hooks/useOfflineData.ts:148) and show retry copy. | existing POS sheets; motionGuard rules |
| B3 [D] | `apps/pos/src/cashier/ReceiptPreview.tsx` | optional `onSendWa?: () => void`; "Kirim struk WA" next to Cetak ulang (~line 266) | — |
| B4 [D] | `apps/pos/src/cashier/CashierScreen.tsx` (~1692) | sheet state; open with `{orderUuid: state.lastOrderId}` and phone `state.selectedCustomer?.phone ?? ''`; pass `offlineData.isOnline`, `orderStateFor(...)`, `offlineData.flush` | A18 `isOnline` wiring |
| B5 [L] | `apps/pos/src/cashier/OrderHistoryPanel.tsx` (~430) | "Kirim struk WA" on server orders (not in `queuedSaleUuids`) → sheet with `{orderId: o.id}`, empty phone, hint "Kosongkan untuk memakai nomor pelanggan" when `o.customerId` set; hidden offline | Cetak Ulang button |

Verify: `corepack pnpm --filter pos test -- waReceipt ReceiptPreview OrderHistoryPanel`; `corepack pnpm --filter pos typecheck`;
`corepack pnpm browser:ci`. Ships by OTA only (no native change).

## Work package C — Backoffice (Sonnet implements)
Owns `apps/backoffice/**`. No new dependency (no lockfile change).

| # | File | Change | Mirrors |
|---|---|---|---|
| C1 [D] | `apps/backoffice/src/screens/settings/WaTemplateCard.tsx` (+ test) | card "Template WhatsApp Struk": `Textarea` with ref; placeholder chips insert at `selectionStart`; live preview `renderWaTemplate(draft, WA_SAMPLE_VALUES)`; inline `validateWaTemplate` errors; "Kembalikan default"; save via `updateWaReceiptTemplate`. Own save, not `useSettingsDraft`. | `settings/SettingsCard.tsx`, `ui/Field.tsx` |
| C2 [D] | `apps/backoffice/src/screens/SettingsScreen.tsx:110` | render `<WaTemplateCard/>` under `StrukSection` in the `struk` tab | — |
| C3 [D] | `apps/backoffice/src/screens/reports/SalesPerformanceTab.tsx` + `salesPerformance.ts` (+ tests) | month input (`type="month"`) → `onPickMonth(from, to)`; columns Sales, Transaksi, Pendapatan (Rp), Struk terkirim, Penilaian, Respons %, Rata-rata ★, distribution bar, Ditandai; latest comments under each row | `VoidReportTab.tsx:121`, `voidReport.ts` |
| C4 [L] | same tab: drill-down `SlideOver` | `listSalesRatings` paged (`ReportPager`); "Hanya yang ditandai" filter | `ui/SlideOver.tsx`, `ReportPager.tsx` |
| C5 [D] | `apps/backoffice/src/lib/router/routes.ts:94` + `routes.test.ts:110` | `tab('sales','performa-sales','Performa Sales','view_reports')`; update asserted list | — |
| C6 [D] | `apps/backoffice/src/screens/Reports.tsx` | `'sales'` in `ReportTab`; render keyed by `${outletId}\|${dateFrom}\|${dateTo}` (~185); `onPickMonth` → `setState({dari, sampai, hal: 1})` | VoidReportTab line |

Verify: `corepack pnpm --filter backoffice test -- routes SalesPerformance WaTemplate`;
`corepack pnpm --filter backoffice typecheck && corepack pnpm --filter backoffice build`.

## Merge and release (orchestrator, owner go-ahead)
1. Step 0 → A, B, C in parallel → `corepack pnpm quality:ci` + CR gate → PR into `prod-hardening`, gate on `gate/customer-rating`.
2. Release: backend (mig 0103; `PUBLIC_LINK_BASE_URL` optional) → Backoffice → POS OTA.
3. Demo path: sale with a salesperson + customer → Kirim struk WA → open the link on a phone, rate → Laporan › Performa Sales.

## Risks
- `window.open` from the WebView: B0 check + two-tap flow.
- CSP vs styling: `style-src 'unsafe-inline'`, one inline `<style>` block.
- Revenue drift from the dashboard: parity assertion in the CR gate.
- Ratings from the outlet Wi-Fi flagged as same network: flags only.
- First write after idle may hit a transient DB error: retry.
- Token in a URL can be forwarded: one order, first name only, 7-day expiry, first rating wins. Token in the path appears in
  Cloud Run request logs (accepted for v1).

## Defaults chosen (owner can override)
- Global template in `app_settings.wa_receipt_template` (NULL = built-in default).
- Tags: `ramah`, `membantu`, `paham_produk`, `cepat` (labels Ramah, Membantu, Paham produk, Cepat).
- Fast flag < 60 s; same network compares the client-IP bucket (/64 for IPv6).
- Ratings count in the month of the SALE's business date (outlet zone).
- Links only for completed and partially refunded orders.
- Rate limits: view 60/min/IP, submit 10/min/IP, create 30/min.
- Riwayat: a cashier may send to the customer's stored phone without seeing it first (it shows in WhatsApp anyway).
- Rating comments visible to everyone with `view_reports`.
- Page shows no logo in v1 (text brand name; keeps `img-src` closed).
- Rupiah "Rp 150.000"; international numbers allowed (10–15 digits); no retention job yet.
