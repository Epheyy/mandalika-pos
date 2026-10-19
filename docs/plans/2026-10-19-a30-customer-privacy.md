# A30: customer privacy (phone-only cashier lookup; managers see their brand; admins see all) (plan)

Date 2026-10-19 · base `prod-hardening` 8310855 · planner: Opus (read-only), saved by the main session.
Policy (owner 2026-10-17 item 4): cashiers look customers up BY PHONE only (no browsing); managers see their OWN brand's customers; admins see all.

## 1. What exists today
- Roles: `users.role` admin|manager|cashier (mig 0001). Permissions from `user_permissions`; outlets from `users.outlet_id` + `user_outlets`. JWT carries uid, role, outlet_id, perms. `auth.HasPermission`: admin bypasses everything. `scope(r)` is outlet-only (`handlers/handlers.go:64`). Customer permission = `manage_customers` (backoffice nav `App.tsx:42`).
- **No brand anywhere in the data model.** Only `products.brand` (text). `outlets`, `users`, `customers` have no brand. `app_settings` is a single row (`documents_brand_name` mig 0018, `recipes_enabled`). AGENTS.md: repo is a template for three brands => one deployment (database) per brand. Under that reading "manager sees own brand's customers" = "manager sees this deployment's customers" (default used here, Q1).
- Customer reads and current gates (`server/server.go`): open to any authenticated user: `GET /customers` (name/phone/email ILIKE, full object + tags), `GET /customers/{id}`, `GET /sync/customers/lookup` (name or phone substring, <=20 rows, Redis-cached), `GET /discount-codes` (embeds `customerName`, `read/repo.go:853,870`), `GET /orders` (`q` substring-matches customer name+phone, `read/orderfilter.go:92-100`). Gated on `manage_customers`: by-phone, reminders, dup-candidates, interactions, points, reward-grants, tags, segments, import. Reports gated on `view_reports` return no customer PII.
- **Tablet keeps a browsable customer list offline:** `sync.Pull` ships `RecentCustomersForOutlet(outlet, 90 days, 1000)` (`internal/sync/sync.go:128`) with the full `customerObj` (email, birthday, anniversary, notes, visits; `read/repo.go:660,738`); POS stores it in the KV snapshot (`packages/sync/src/snapshot.ts`); `CashierScreen.tsx:225-238` merges it with online hits; `CustomerPicker.tsx:49-58` filters by name. Snapshot only replaced when content version rises (`engine.ts:391-443`), so a server-only change never clears existing tablets.
- **Cross-role cache leak:** `ckey` keys only on method, path, outlet, raw query (`handlers.go:134`); any role-dependent customer read can be served to another role at the same outlet.
- **No phone normalizer:** `csvimport.CleanPhone` strips noise, does not fold +62 to 0; stored phones are raw.
- POS only needs id, name, phone, points, segment from a customer. `Customer` schema requires id, name, phone, points, totalSpent, visitCount, createdAt (`openapi.yaml:792`).

## 2. New rule per endpoint and screen
Resolver `customerScope(r)` in `backend/internal/handlers/customerscope.go` returns `All` or `PhoneOnly`: admin -> All; cashier -> PhoneOnly always (even with `manage_customers`, Q2); else `manage_customers` -> All; else PhoneOnly. (If brands ever share a deployment this is the only place that grows a brand filter, appendix.)

| Surface | New rule |
|---|---|
| `GET /customers`, `GET /customers/{id}` | Move into the `manage_customers` group; group guard becomes `RequireCustomerReader()` (scope All) instead of `RequirePermission`. Cashier -> 403. |
| Rest of the `manage_customers` group (by-phone, reminders, dup-candidates, interactions, points, reward-grants, tags, segments, import, create/update/delete) | Same `RequireCustomerReader()` guard; otherwise unchanged. by-phone dup-check matches on `phone_norm`. |
| `GET /sync/customers/lookup` | Never cached. All: current typeahead (backoffice DiscountCodeFormModal keeps working). PhoneOnly: reads `phone` (or legacy `q`), normalizes; invalid or <8 digits -> `200 []` (not counted); else rate-limit, then exact `phone_norm` match, not merged, oldest first, max 3 rows. Rows use reduced `customerPosObj`: id, name, phone, points, totalSpent, visitCount, createdAt, segment (no email/birthday/anniversary/notes/tags). |
| `GET /sync/pull` | `customers: []` always (field stays for old bundles, deprecated). `discountCodes[].customerName` stripped; `customerId` stays (POS `wrong_customer` rule needs it). |
| `GET /discount-codes` | `customerName` only for holders of `manage_promotions`; cache key gets a permission suffix (`:p=1/0`). |
| `GET /orders` `q` | PhoneOnly callers: `q` matches order number, cashier name, or exact `phone_norm` of the linked customer; customer-name and phone-substring branches dropped. All: unchanged. `customerName` column in outlet-scoped order rows stays. |
| POS CustomerPicker | Phone input only: local known-customers cache (exact normalized phone) plus online lookup. No name search, no list. |
| Backoffice Pelanggan | Unchanged (gated on `manage_customers`). DiscountCodeFormModal shows a "cari dengan no. telepon" hint for PhoneOnly users. |

Rate limit: helper in `handlers/customerlookup.go` using `h.Cache.IncrWindow`, keyed per user and minute/day (not per IP: an outlet's tablets share one NAT and one terminal account). Defaults `lookupPerMinute=30`, `lookupPerDay=400` (Q4). Over limit -> 429 with `Retry-After`. Only real valid-length queries count.

## 3. Brand scoping for managers
Default (one deployment per brand): manager with `manage_customers` sees every customer in the deployment; manager without it is PhoneOnly; admin all. No brand stored.
Appendix, NOT built unless Q1 = shared: `brands` table + `outlets.brand_id` (backfill one default brand); `customer_brands(customer_id, brand_id)` filled by trigger on `orders` AFTER INSERT and `UPDATE OF customer_id` (covers merges) plus `customers.created_outlet_id`; a customer who bought at several brands is visible to each brand's managers; manager brands = brands of home outlet + `user_outlets`; cashier lookup stays global by exact phone (owner call on shared points); `customerScope` returns `Brands([]id)` and list/detail/dup queries add `EXISTS customer_brands`.

## 4. Offline POS: what stays on the tablet
New `packages/sync/src/knownCustomers.ts` (Opus tier): KV store key `mandalika.pos.knownCustomers`; only customers looked up, selected or created on this tablet; fields id, name, phone, phoneNorm, points, segment, lastUsedAt; LRU cap 300 (Q3), dropped 30 days after last use; `findByPhone(norm)` exact match only, NO listing API; `remember(c)` on online-lookup select, on create (`customer_create`), on attach; points refreshed when an online lookup returns.
One-time purge: the new `Snapshot` constructor drops `customers` from the stored bundle and rewrites it (always `customers: []`), does not copy the old list into the cache. Migration 0061 also bumps `content_versions.version` for every outlet so old-bundle tablets re-pull and get `[]` (raises the sales wall once: tablets at 0 pending). Queued orders reference `customerId` only, so the purge cannot break the outbox.

## 5. Codegen, migration, gate, release
Migration `0061_customer_phone_norm.sql` (0057 stays reserved for A15 Phase B): IMMUTABLE `normalize_phone(text)` (trim; strip spaces, `-`, `.`, `(`, `)`; fold `+62` or `62` to `0`; digits only; empty if fewer than 8 digits); `customers.phone_norm text GENERATED ALWAYS AS (normalize_phone(phone)) STORED`; `CREATE INDEX idx_customers_phone_norm ON customers(phone_norm) WHERE merged_into IS NULL`; `UPDATE content_versions SET version=version+1, updated_at=now()`. Adding the stored column rewrites customers under a lock (fine on test data; note for release).
OpenAPI: lookup gets `phone` query param, 429 response, description of both modes; 403 on `/customers` and `/customers/{id}`; `SyncPullBundle.customers` deprecated/always empty; `DiscountCode.customerName` documented. Then `cd backend && make gen-go`, `corepack pnpm --filter @mandalika/api gen`, `corepack pnpm gen:check`, `cd backend && go run ./cmd/codegen -check`.
PG gate: add `("CP", "TestCustomerPrivacyPostgres", 56464, "cp")` to `scripts/ci/postgres_gate.py` (highest in use is now 56463).
OTA vs APK: POS web-layer only -> OTA (`make ota-release`), no APK.
Release order (after the pending 0058-0060 release; tablets at 0 pending): 1 backend deploy with 0061; 2 push (backoffice deploys); 3 OTA.
Old POS bundles on the new server: typed names return `[]`; a full phone returns matches but the old client-side `c.phone.includes(search)` filter hides matches stored in another format (`+62...` vs `0...`) until the OTA lands (accepted); offline they have no customer cache after the forced re-pull except session-created customers.
Rollback: 0061 additive; reverting the backend is safe (old code ignores `phone_norm` but resumes shipping the 1000-customer list: privacy regression only); Capgo rollback works against the new server, degraded as above. Release check: read-only Neon `SELECT count(*) FROM customers WHERE normalize_phone(phone)=''`.

## 6. Test plan
- Twins: one shared vector file `packages/sync/src/__fixtures__/phone-vectors.json` used by Go (`backend/internal/phone/phone_test.go`), TS (`packages/sync/src/phone.test.ts`) and the SQL function (asserted in the CP gate). Cases: `0812-3456-7890`, `+62 812...`, `62812...`, `(021) 555...`, 7-digit value -> "", letters -> "", empty.
- Resolver unit test (`handlers/customerscope_test.go`): admin; manager with/without `manage_customers`; cashier; cashier with `manage_customers`; missing role -> PhoneOnly.
- CP authorization matrix (`backend/internal/handlers/customer_privacy_integration_test.go`), router built like `csv_import_integration_test.go`, tokens from `issue(...)`. Roles: admin, manager with `manage_customers`, manager without, cashier, cashier with `manage_customers`. Assert status and body on: `GET /customers`, `/customers/{id}`, `/customers/by-phone`, `/customers/reminders`, `/customers/dup-candidates`, `/customers/{id}/points`; `/sync/customers/lookup` with a name `q` (PhoneOnly -> []), short `q` (-> [] not counted), `phone=+62...` matching stored `0...` (1 row, no email/birthday/notes), a merged customer (excluded), three soft duplicates (max 3, oldest first); `/sync/pull` (customers [], no `customerName` on discount codes); `/discount-codes` with/without `manage_promotions`; `/orders?q=<customer name>` (PhoneOnly no match; All match); the 31st lookup inside a minute -> 429 with `Retry-After`.
- Cache key unit test: discount-codes key differs by permission; lookup handler never calls `cached`.
- POS vitest: `knownCustomers.test.ts` (cap, TTL, exact-only, no list method); snapshot purge (old stored bundle with customers rewritten to `[]`); CustomerPicker (name input shows nothing; valid phone shows a cache hit; 429 message shown).
- Gates: full PG gate, `quality:ci`, `browser:ci`, both codegen checks.

## 7. Ordered TDD tasks (Sonnet implementer; branch `a30-customer-privacy`; do NOT touch backoffice `Dashboard.tsx` or `dashboard/metrics.ts`)
1. Phone normalizer twins: `backend/internal/phone/phone.go` + test, `packages/sync/src/phone.ts` + test, vectors JSON; export `normalizePhone` from the `packages/sync` index.
2. Migration 0061 as in section 5; CP gate's first test asserts SQL `normalize_phone` matches every vector and `phone_norm` is populated.
3. Resolver and guard: `handlers/customerscope.go` (+ test); `RequireCustomerReader` in `backend/internal/middleware/middleware.go` (or handlers if it needs nothing outside auth context); `server/server.go` moves `GET /customers` and `/customers/{id}` into the customer group with the new guard.
4. Phone-only lookup and rate limit: `handlers/handlers.go` CustomersLookup (no `cached`, mode switch on resolver); new `handlers/customerlookup.go`; `read/repo.go` new `customerPosObj` and `CustomerByPhoneNorm(ctx, norm, limit)`; `CustomerByPhone` switches to `phone_norm`.
5. Pull and discount-code stripping: `internal/sync/sync.go` Pull sets `Customers=[]api.Customer{}`, strips `customerName`; delete `RecentCustomersForOutlet` + tests if unused; `handlers.DiscountCodes` permission-aware strip + cache-key suffix.
6. Order `q` restriction: `read/orderfilter.go` `OrderFilter.CustomerSearch` flag (PhoneOnly branch exact `phone_norm`); set in `ordersFilter` (handlers).
7. OpenAPI + both codegens as in section 5; `packages/api/src/client.ts` adds `lookupCustomerByPhone(phone)` (uses `?phone=`, keep `lookupCustomers`).
8. POS known-customers cache and snapshot purge: `packages/sync/src/knownCustomers.ts` (+ test); `packages/sync/src/snapshot.ts` purge on load (+ test); wire an instance where the POS creates the KV and engine (SyncProvider in `apps/pos/src`).
9. POS picker: `apps/pos/src/cashier/CustomerPicker.tsx` phone-only input (`inputMode=tel`, hits from props, no name filter, placeholder "No. telepon pelanggan..."); `CashierScreen.tsx` lines ~123-146 and ~225-238 use known cache + `lookupCustomerByPhone` once phone valid; drop `snapCustomers` merge; `remember` on select and create; 429 toast; "+ Tambah" prefills the phone only. Verify picker vitest and `browser:ci`.
10. Backoffice hint: `apps/backoffice/src/screens/promotions/DiscountCodeFormModal.tsx` phone hint when user lacks `manage_customers`.
11. CP gate registration + full matrix test (written incrementally from task 2).
12. Docs: customer access matrix section appended to this plan; tracker A30, sweep A30, HANDOFF (release steps: tablets at 0 pending, 0061 lock, version bump raises the sales wall once, malformed-phone count).
Review: one Opus review of the whole branch (auth, pull bundle, generated types, offline store).

## 8. Not in scope (follow-ups)
- Customer PII overwrite: `CreateCustomerTx` uses `ON CONFLICT (id) DO UPDATE` on name/phone/email (`service/order.go:1797-1803`); once lookup returns ids a crafted `customer_create` from any tablet can overwrite an existing customer's PII. Separate slice (insert-or-verify-same).
- Dup detection on normalized phone (`recordDupCandidate`, import) (A39/A25 area).
- Rest of the A30 matrix: warehouse stock, settings/outlets reads, `/orders` permission gate (`view_transactions`), a `chi.Walk` route-matrix test.
- Lookup audit trail; customer names in outlet-scoped order history and receipts (A41 domain, kept); staff list in the pull bundle (A08); `loyalty-preview` with an arbitrary `customerId`.
- Shared-deployment brand model (section 3 appendix) unless Q1 = shared.

## 9. Owner questions and decisions
- Q1 Do the three brands run separate systems, or share one backoffice+database? Default taken: separate (manager with `manage_customers` sees their system's customers). If shared, the brand appendix is built and the owner decides whether one phone = one points account across brands. **Open: recorded in HANDOFF, not blocking.**
- Q2 Cashier with `manage_customers` stays phone-only: default taken (yes).
- Q3 Tablet remembers last 300 customers, forgotten 30 days after last use: default taken.
- Q4 Lookup limit 30/min and 400/day per terminal account: default taken.

## Result (2026-10-19)
- Merged locally as `c093157` on prod-hardening (commits `9ae85b7`..`44cf506`). NOT pushed or deployed. Migration 0061.
- Gates: PG gate 26/26 (port 56464), quality:ci, browser:ci, both gen checks re-run on the branch tip. Opus review Fix-first (All-scope branch ignored `?phone=`), fixed.
- Deviations from plan: customer scope also applied to `/reports/summary`; order-q flag inverted so a zero value is restricted; cache-key suffixes on `/orders` and `/reports/summary`; `RequireCustomerReader` lives in handlers, not middleware; lookup runs only on explicit submit (Enter or Cari), never while typing.
- Open owner questions and follow-ups: see HANDOFF.md A30 bullet.
