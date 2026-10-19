# A28 per-outlet timezone and business date: plan (2026-10-19)

Base `prod-hardening` @ 097176a. Written by the Opus planner (read-only), saved by Claude.
Owner policy (HANDOFF Decisions 2026-10-17 item 3, binding): each OUTLET has a timezone (WIB or WITA; WIT allowed,
unused); the business day is the OPENING DATE of the shift; NO return deadline.

## 1. Scope

**Phase A (backend + backoffice, no OTA/APK):** `outlets.timezone`; stored `business_date` on shifts and orders;
`orders.refund_business_date` (stamped now, read later by A27); every sales-report/list date filter moves to the
business date (`/orders`, `/reports/summary` incl. `dailySales`, `/shifts`, oversell report, promo-grant report,
discount-code report); timezone field on the outlet form; backoffice UTC-date fragments fixed.

**Phase B (backend + POS web layer via OTA, no APK; ships separately, later; NEEDS the owner answer in section 11):**
promo/loyalty clocks move from fixed WIB to the outlet's timezone on the server and in its POS twin; the pull bundle
carries `outletTimezone`; POS order history moves to business days.

**OUT:** return/refund deadline (seam only: compare `orders.business_date` with the refund shift's `business_date` in
`service/order.go` RefundOrder near :805; document, no code); bounding promo clock skew (belongs to A05); the
refund-date report basis (A27; this slice only stamps the column); `settled_at`; warehouse timezones (stay Asia/Jakarta);
re-deriving history when an outlet timezone is edited later (R4).

## 2. Migration 0059 `0059_outlet_timezone_business_date.sql`

(0058 = A10; 0057 reserved for A15 Phase B; decision #11: whichever merges first renumbers.)

1. `ALTER TABLE outlets ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Jakarta'` +
   `CONSTRAINT outlets_timezone_allowed CHECK (timezone IN ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura'))`.
2. SQL functions (STABLE, must NEVER raise):
   - `business_date_at(p_outlet uuid, p_at timestamptz) RETURNS date` =
     `(p_at AT TIME ZONE COALESCE((SELECT timezone FROM outlets WHERE id=p_outlet),'Asia/Jakarta'))::date`
   - `order_business_date(p_outlet, p_shift, p_client timestamptz, p_created timestamptz) RETURNS date`: if a shift exists,
     `(SELECT business_date FROM shifts WHERE id=p_shift AND outlet_id=p_outlet)`; otherwise
     `business_date_at(p_outlet, capture)` where capture = `p_client` if inside `[p_created - 7 days, p_created + 5 min]`
     else `p_created`.
3. `shifts ADD business_date date`; backfill `(opened_at AT TIME ZONE 'Asia/Jakarta')::date`; SET NOT NULL.
4. `orders ADD business_date date, ADD refund_business_date date`; backfill `business_date =
   order_business_date(outlet_id, shift_id, client_created_at, created_at)`, SET NOT NULL; backfill refunded rows
   `refund_business_date = COALESCE(<refund shift business_date>, business_date_at(outlet_id, refunded_at))` where
   `status='refunded' AND refunded_at IS NOT NULL`; others stay NULL.
5. Triggers (plpgsql `$$`), fill only when NULL: `shifts BEFORE INSERT` (business_date_at(outlet, opened_at));
   `orders BEFORE INSERT` (order_business_date); `orders BEFORE UPDATE OF status WHEN NEW.status='refunded' AND
   OLD.status<>'refunded' AND NEW.refund_business_date IS NULL` (from NEW.refund_shift_id / NEW.refunded_at).
6. Indexes: `orders(outlet_id, business_date)`, `orders(business_date)`, `shifts(outlet_id, business_date)`.

Why triggers, not Go stamping: rows are inserted outside the service by 6 test files (orders), 7 (shifts) and
`fsmigrate/tables.go:280,308`; the rollback revision keeps inserting/refunding. Go diff to `service/order.go` (insert :491,
refund UPDATE :813) and `service/shift.go:109` is ZERO. `db.go:122` runs each migration whole in a tx; the BD gate must prove it
applies.

Fallbacks: late offline sale on a closed shift keeps the shift id (`sync/attribute.go:233-236`) so it takes the shift's date;
shift-less order (unknown shift dropped at attribute.go:276-279, legacy) uses clamped device time in the outlet tz else server
time; shift `opened_at` is server `now()` (shift.go:112) and offline open is blocked. Dates are frozen at write time; editing an
outlet tz never rewrites them.

## 3. Helpers

SQL: the two functions; reads do no tz math: `o.business_date BETWEEN $from::date AND $to::date` (exact across outlets in
different zones because each row carries its outlet's local day).

Go new `backend/internal/bizday`: `Default="Asia/Jakarta"`, `Allowed`, `Valid(tz)`, `Zone(tz) *time.Location` using FIXED offsets
+7/+8/+9 (no `LoadLocation`: static CGO-off binary on distroless; test cross-checks against `time/tzdata`, imported only in test),
`ValidDay(s)` replacing `validWIBDay` (`handlers/oversell.go:21`). Rename `wibDayRange` (`handlers/order_filter.go:17`) to
`dayRange`. Delete `wibDayStart/wibDayEnd/wibDayInstant` (`read/orderfilter.go:34-41,98-105`).

TS new `apps/backoffice/src/lib/businessDay.ts`: `localDay(d=new Date())` (browser-local YYYY-MM-DD), `OUTLET_TIMEZONES`
(value/label WIB/WITA/WIT/offset), `dayStartIso(day,tz)`, `dayEndIso(day,tz)` (fixed-offset ISO). Phase B adds POS twin `zoneParts`.

## 4. What changes

Backend (A): `read/orderfilter.go:72-77` DateFrom/DateTo -> `o.business_date`; `appliedWindow` (:109) adds dateFrom/dateTo echo
(legacy instants unchanged); `read/reports.go:50` dailySales groups by `to_char(business_date,'YYYY-MM-DD')` (was UTC);
`read/repo.go:1033-1040` Shifts use `s.business_date`; `:1879-1880` grant report `o.business_date` (was g.created_at);
`:1963-1964` code report `o.business_date`; `read/oversell.go:23-24` `o.business_date` (was x.sold_at); `read/repo.go:978` orderObj
and `:1009` shiftObj add `'businessDate'`; `:221` Outlets JSON add `'timezone'`; `:646-647` segment recency `now()::date` ->
Asia/Jakarta days; `handlers/handlers.go:449,475` grant/code reports return 400 on bad dates (today 500 from SQL cast). Legacy POS
`/orders` `from`/`to` (`orderfilter.go:60-65`) stays BYTE-IDENTICAL.

Backoffice (A): switch to `localDay()`: `customers/CustomerDetail.tsx:41`, `ingredients/OpnameTab.tsx:182,202`,
`StockCount.tsx:80,150`, `Promotions.tsx:253`, `lib/csvUtils.ts:10,47`, `auth.tsx:16`. `inventory/MovementSummary.tsx:13-31`:
outlet -> `dayStartIso` in its tz, warehouse -> Asia/Jakarta. `dashboard/metrics.ts` (wibDay :58-62, fetch window, completedIn,
buildTrend :120-160): send business-day dateFrom/dateTo (today = localDay()); trim/bucket day/week/month by `o.businessDate` with
fallback to local day of createdAt; hourly "today" trend keeps hour of createdAt; drop the WITA +-1 day padding. `Reports.tsx:48`
fix comment. `reports/ExportTab.tsx` add "Hari Bisnis" CSV column.

Phase B: server `service/order.go:30,205-209,404`, `loyalty_preview.go:80`, `promo_validate.go:40,111-140` (rename
`SaleTimeWIB` -> `SaleTimeLocal`), `loyalty.go:36`; bundle `sync/sync.go:69,96` + `OutletTimezone`; POS `promoValidate.ts:37-60`
(wibParts -> zoneParts), `CashierScreen.tsx:523,567`, `PromoPanel.tsx:118`, persist tz where `outletCode` from the bundle is stored
(`terminalBinding.ts` or equivalent), `OrderHistoryPanel.tsx:47-75` (`localDay()` + dateFrom/dateTo; offline cache key changes).

## 5. OpenAPI (`backend/api/openapi.yaml`)

`Outlet` (:154) `timezone` enum [Asia/Jakarta, Asia/Makassar, Asia/Jayapura], required; `OutletInput` (:2228) `timezone` optional,
same enum; `Order` (:1304) and `Shift` (:1433) `businessDate` (format date), OPTIONAL (POS builds local Order objects);
`ReportSummary` (:1666) add `dateFrom`/`dateTo` (format date, nullable), `from`/`to` echo only legacy instant params; parameter
descriptions for /orders, /shifts, /reports/summary, /oversell-report, grant + code reports: dateFrom/dateTo = business days.
Phase B: `SyncPullBundle` (:1805) `outletTimezone`.
Codegen: `make gen-go` in backend AND `corepack pnpm --filter @mandalika/api gen`; check `corepack pnpm gen:check` and
`go run ./cmd/codegen -check`.

## 6. Outlet timezone trace (gap-class)

Migration -> `write.Outlet` (`write/repo.go:917`) `Timezone string` -> CreateOutlet INSERT (:930; empty -> Asia/Jakarta) ->
UpdateOutlet UPDATE (:948) `timezone = COALESCE(NULLIF($n,''), timezone)` (absent KEEPS current; matters for the toggle in
`settings/LocationsSection.tsx:81` and cached old builds) -> handlers `handlers/writes.go:255,264`: 400 "zona waktu tidak valid" if
non-empty and not `bizday.Valid` (DB CHECK second guard) -> read JSON (`read/repo.go:221`) -> OpenAPI + both codegens
(`packages/api/src/client.ts:205-206,574-575` follow codegen) -> UI `inventory/OutletFormModal.tsx` "Zona Waktu" select
(WIB Asia/Jakarta, WITA Asia/Makassar, WIT Asia/Jayapura; default current or WIB; sent in body :76-83); `LocationsSection.tsx:81`
passes `timezone: o.timezone`; help text "Mengubah zona waktu tidak mengubah hari bisnis transaksi lama."

## 7. Tests (tests first)

New PG gate **BD `TestBusinessDatePostgres`, port 56462** (56458 reserved A15 ST; 56459-56461 taken). Register in
`scripts/ci/postgres_gate.py:33-54`. File `backend/internal/handlers/business_date_integration_test.go`. Outlets W (Asia/Jakarta),
M (Asia/Makassar).
1. WITA boundary: shift-less orders at 16:45Z 2026-10-19: W = 23:45 WIB -> 10-19; M = 00:45 WITA -> 10-20; at 17:15Z both 10-20.
   Cross-outlet `/reports/summary?dateFrom=dateTo=2026-10-19` as admin includes W row, excludes M row; dailySales and /orders agree.
   M shift opened 23:30 WITA 10-19 (15:30Z) with a sale at 00:15 WITA 10-20 -> 10-19.
2. Offline sale synced next day: W shift opened 10-19 08:00 WIB closed 22:00; order via /sync/batch on 10-20 10:00 WIB with the
   closed shift id and client time 10-19 20:00 -> business_date 10-19, in 10-19 summary + dailySales, absent from 10-20;
   CloseShift totals unchanged.
3. Shift-less late sale: client 10-19 20:00 WIB accepted 10-20 -> 10-19; client clock +1 h future or 30 days old -> created_at.
4. Refund stamp: POS refund on shift opened 10-21 -> refund_business_date 10-21; backoffice refund no shift 23:50 WITA at M -> WITA
   date; original sale business_date unchanged.
5. Outlet: create without tz -> Jakarta; PUT without tz on M keeps Makassar; `Europe/London` -> 400; direct SQL bad value rejected
   by CHECK; changing M to Jakarta does not change existing business_date.
6. Filters/scope: /shifts, /oversell-report, grant report, code report filter on business_date (one row each); non-admin with
   `?outletId=<other>` still sees only own outlet; bad dateFrom on grant/code -> 400.
7. Migration applies through db.go (proves `$$` bodies); triggers fill rows from fixture INSERTs that omit the columns.
Must stay green: gates A26/A27 (their 16:59/17:01Z rows are shift-less -> Jakarta day of created_at, same as today), QT, RF, OS,
legacy POS from/to byte-identical; update `contract_consumers_integration_test.go` if it pins Outlet/Order/Shift key sets.
Unit: Go `bizday` (Valid, offsets vs tzdata, ValidDay), handler 400s; Vitest `lib/businessDay.test.ts`, extend
`dashboard/metrics.fetchWindow.test.ts`, OutletFormModal sends tz, toggle preserves tz.
Phase B: Go TestValidatePromo/TestValidateCode (window 10:00-12:00 at 02:30Z valid for M, invalid for W; end date crossing midnight
in M; loyalty birthday 23:30 WITA); same vectors in `promoValidate.test.ts` + `promoParity.test.ts` + PL gate; order-service PG
case: online WITA order 422/valid exactly as the TS twin decides.

## 8. Risks

R1 money: no money column/total formula changes; shift close (`shift.go:226`) and POS recap stay keyed by shift_id; only the day
a row is assigned to moves. R2 historical numbers change at deploy (all outlets still Jakarta): post-midnight sales on a
pre-midnight shift move to the earlier day; late-synced sales move to their shift's day; dailySales UTC->business days; oversell/
grant/code reports move from sold_at/g.created_at to order business day; shifts identical. BEFORE DEPLOY: read-only Neon count of
orders whose computed business_date differs from `(created_at AT TIME ZONE 'Asia/Jakarta')::date`; show the owner. R3 sale path:
orders trigger on every sale insert; functions never raise (missing outlet/shift -> default); two PK lookups; Opus review + BD
gate. R4 frozen dates: set WITA outlets BEFORE go-live; test-DB re-derive UPDATE only on request (count first, Neon write needs go-
ahead). R5 rollback: pre-0059 revision keeps working. R6 migration rewrites all orders/shifts rows once; release with tablets at
0 pending. R7 Phase B skew: new server + old POS bundle at WITA outlet disagrees on promo hours -> deploy B while every outlet is
Jakarta (bundle Jakarta = fixed WIB), OTA the POS, wait for all tablets, THEN set WITA outlets; old bundles ignore the additive
field. R8 `businessDate` optional in TS types: consumers fall back to createdAt/openedAt.

## 9. Tasks (TDD order)

| # | Task | Files | Verify | Reviewer |
|---|---|---|---|---|
| A1 | BD gate skeleton (cases 1-7 failing) + registration | new business_date_integration_test.go, postgres_gate.py | fails as expected | Opus |
| A2 | Migration 0059 | internal/db/migrations/0059_*.sql | BD 1-4,7 pass; A26/A27/QT/RF/OS green | Opus |
| A3 | OpenAPI section 5 + both codegens | openapi.yaml, api.gen.go, packages/api schema.d.ts | gen:check, codegen -check | Opus |
| A4 | bizday pkg + outlet trace section 6 backend | internal/bizday/*, write/repo.go, handlers/writes.go, read/repo.go:221 | BD 5; unit | Haiku |
| A5 | Read side section 4 backend + handler rename | read/*, handlers/* | BD 6; full PG gate; go test ./... | Opus |
| A6 | Segment recency to Asia/Jakarta | read/repo.go:646-647 | test | Haiku |
| A7 | lib/businessDay.ts + date-default sites | files in section 4 | vitest | Haiku |
| A8 | Outlet form tz select + toggle keep | OutletFormModal.tsx, LocationsSection.tsx | vitest; browser:ci | Haiku |
| A9 | Dashboard businessDate; Reports comment + CSV col; MovementSummary | metrics.ts, Reports.tsx, ExportTab.tsx, MovementSummary.tsx | metrics.fetchWindow.test.ts; quality:ci | Haiku |
| A10 | Gates + final review of whole diff | | quality:ci, browser:ci, full PG gate, go test ./... | Opus |
| B1 | Server promo/loyalty clock in outlet zone | service/order.go, promo_validate.go, loyalty.go, loyalty_preview.go | Go vectors; PL gate | Opus |
| B2 | Bundle outletTimezone + POS persists | sync/sync.go, OpenAPI SyncPullBundle + codegens, terminalBinding.ts | sync tests; gen:check | Opus |
| B3 | POS zoneParts twin + parity vectors | promoValidate.ts, CashierScreen.tsx, PromoPanel.tsx + tests | vitest; PL gate | Opus |
| B4 | POS history on business days | OrderHistoryPanel.tsx | vitest | Haiku |
| B5 | Gates + review; OTA after owner go-ahead | | four gates | Opus |

## 10. Release

Phase A: backend deploy with 0059 (tablets at 0 pending; show the R2 count first), then first non-skip push (Cloudflare deploys
backoffice); no APK/OTA; can join the held A29/A26/A10 release (migrations 0058 -> 0059). Smoke: summary total = CSV sum
(today, 30 days, per outlet, all outlets); outlet edit + toggle keep tz; a Makassar test outlet's shift-less sale near 16:30-17:30Z
lands on the WITA day. Phase B: backend deploy then `make ota-release` (web layer only), R7 order.

## 11. Owner question (ONE) — ANSWERED 2026-10-19: YES, outlet-local time. Phase B is in scope, built after Phase A.

At a WITA outlet, do promo hours, active days, promo/code start-end dates and loyalty triggers (birthday, anniversary, date-matched)
mean that outlet's LOCAL time? Recommended default: YES (Phase B). If "head-office WIB time", Phase B is dropped and only Phase A
ships. Owner actions (no decision): set WITA outlets' timezone before go-live; say whether test-DB history is re-derived afterwards
(default no).

Recorded technical defaults: shift-less fallback = device time inside [accept - 7 days, accept + 5 min] else server accept time;
warehouses and customer-level dates use Asia/Jakarta; `businessDate` optional in TS types.
