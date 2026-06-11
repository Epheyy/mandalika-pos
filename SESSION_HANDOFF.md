# Session Handoff — Mandalika POS

Date: 2026-06-11 · Branch: `prod-hardening` · HEAD: `e82f721` (pushed to origin; +docs on top) · Backend rev **00061-jtw** DEPLOYED (migrations →**0033**; SP-CRM-9c live)

> **▶️ NEXT UP — SP-CRM-9c (stock awareness at the POS) is DONE, backend DEPLOYED (rev `00061-jtw`, migration 0033), and settings-smoke-VERIFIED.** See the ⭐ LATEST SESSION (SP-CRM-9c) directly below. Commits `29db28e`…`e82f721`, pushed. **TWO follow-throughs remain, USER-PENDING:** (1) **new APK** (POS changed — ALSO carries the still-pending SP-CRM-9b collapsible UI; trigger `android-release.yml` workflow_dispatch on `prod-hardening`). (2) **on-device check** — reward picker shows `· Stok N`; toggle "Izinkan Stok Minus" off → checkout shows the amber warning but still lets you confirm; product card stock drops immediately after a sale. (Deploy is no longer agent-blocked — a standing `autoMode.allow` rule in `.claude/settings.local.json` now pre-authorizes backend deploys incl. boot migrations.)
>
> **SP-CRM-9b (variant selectors + collapsible rewards, rev `00060-cdn`) — DONE + deployed + live-verified; its POS UI still needs the new APK** (covered by the 9c APK). **SP-CRM-9 (product_reward fulfillment) — DONE + on-device confirmed working.** Next CRM candidates: **SP-CRM-Merge** (dup review queue) or the deferred **offline reward eval**.

> **POST-SP-CRM-8 FIX (rev 00057-77z, commit `ece37cc`):** discovered the backoffice **Kondisi Khusus** save never worked — the backend only had `GET /loyalty-conditions`; the create/update/delete write side was never built (pre-existing gap, the frontend client+UI already called these endpoints). Added the CRUD: `write.LoyaltyCondition` + `Create/Update/DeleteLoyaltyCondition` (mirrors Promotions/DiscountCodes pattern), 3 handlers, `POST /loyalty-conditions` + `PUT/DELETE /loyalty-conditions/{id}` gated **manage_settings**, OpenAPI `LoyaltyConditionInput` + 3 ops (regen, gen-check green). go-reviewer: Approve. Authed smoke test on 00057-77z: create+list+delete all work. **This unblocks authoring loyalty conditions** (prod had 0). DONE 2026-06-10: user created a real condition "First Registrant" (first_registration → set_points +10000); **live-verified** via the real OrderService — a first-time customer's Rp50,000 order earned base 50 + 10000 = **10050** with the breakdown ledger reason + application audit row. **LOYALTY IS NOW ENABLED for ongoing testing** (`loyalty_settings.enabled=true`, ppt=1, redemptionRate=100) — NOT a real go-live; see the ⚠️ ENV note below.
>
> **⚠️ ENV REALITY (user-confirmed 2026-06-10):** the Cloud Run/Neon/Upstash/Cloudflare deployment is the **free-tier TEST cutover** (RUNBOOK.md) — a **pre-launch environment for polishing/hardening before go-live**, holding **TEST data**, NOT live with real customers. "30+ outlets / 50k–500k customers / thousands trx/day" is the **what-if scale to harden for** (the point of `prod-hardening`), not current reality. So: **engineer like it's live, operate like it's test** — routine test-DB writes + feature-flag toggles are low-stakes; act directly without disaster-grade ceremony; re-confirm with the user only before things that matter at actual go-live. (See memory `deployment-is-prelaunch-test`.)

> **SP-CRM-8 (Loyalty-Conditions Trigger Engine) is DONE + deployed (rev 00056-wx9, mig 0032) — see its section further below.** The COPY-READY block beneath it was the SP-CRM-8 kickoff and is now historical.

---

# ⭐ LATEST SESSION — 2026-06-11 (SP-CRM-9c: Stock Awareness at the POS) — READ THIS FIRST

Branch `prod-hardening`. Code COMPLETE + reviewed + pushed (commits `29db28e`(spec)→`e82f721`); **backend DEPLOYED rev `00061-jtw` (migration 0033) + settings-smoke-verified.** Built brainstorm→spec→plan→subagent-driven with per-task model routing (Sonnet implement / Opus review / Haiku spec-check). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-11-crm-sp9c-stock-awareness*`.

## What this slice does (user-reported on-device, SP-CRM-9b session)
A cashier picked an out-of-stock free reward and the sale went through → stock **−2**. Root causes (all confirmed in code): (a) the reward picker showed no stock; (b) the POS submits every order through the offline-first **sync path** (`sync.go:221 Offline:true`) which deliberately allows negative stock + flags `stockWarning` — there was no business toggle; (c) the product card "doesn't update fast" because the grid reads a snapshot that "only refreshes on resync" (`CashierScreen.tsx:196`) with no optimistic local decrement. **All three are addressed.**

## What shipped (code, pushed)
- **Backend** (`95a83a0`): `allowNegativeStock bool` on `app_settings` — **migration 0033** (`ADD COLUMN ... DEFAULT true`), OpenAPI `AppSettings` schema (required→plain bool), read json_build_object + write UpdateAppSettings, regen api.gen.go + schema.d.ts. **Default true = today's behavior.** Server stays LENIENT (records + flags; offline-first can't reject an already-made sale) — the setting drives POS UX only.
- **Backoffice** (`5984073`): "Izinkan Stok Minus" toggle in SettingsScreen (mirrors autoOpenShift; save sends the whole settings object).
- **POS sync pkg** (`61c33b1`): `SyncEngine.pendingStockDeltas(): Record<string,number>` sums unsynced outbox `'order'` quantities per `${productId}|${variantSize}` (paid + reward lines).
- **POS** (`f0f30bd`,`1a86c27`,`e82f721`): `apps/pos/src/cashier/stock.ts` — `applyPendingStock`/`stockFor`/`overstockLines` (pure, tested). `CashierScreen` derives `displayProducts` = snapshot stock − pending deltas → feeds ProductGrid (card updates immediately after a sale) + the reward picker (now shows `· Stok N`, red ≤0) + the checkout warning. CheckoutPanel shows a setting-gated amber "⚠️ Stok tidak mencukupi · masih bisa dilanjutkan" when any line (paid OR reward, **aggregated by variant** so paid+reward of the same item combine) would go negative AND `allowNegativeStock===false` — **confirm button STAYS enabled (warn + override)**. `DEFAULT_SETTINGS` got `allowNegativeStock:true`.

## ✅ Verification — DEPLOYED rev `00061-jtw` + smoke-verified
- Local gate green: backend build+test+`make gen-check` (no drift); POS tsc + vitest (30/30 incl. 9 stock cases); backoffice + sync builds.
- Reviews: A1 go-reviewer (Opus) Approve; C1/C2/C3 typescript-reviewer (Opus) Approve. Applied: C3 same-variant aggregation fix (paid+reward of one variant now warns correctly).
- **Live settings smoke PASSED on rev 00061-jtw:** GET /settings/app → `allowNegativeStock:true` (migration 0033 default on the existing row); PUT false → GET false; PUT true → GET true (restored). Full read/write round-trip works.
- **STILL USER-PENDING:** (1) **new APK** (POS changed — also carries the still-pending 9b UI; `android-release.yml` workflow_dispatch). (2) **on-device check** — reward picker shows `· Stok N`; toggle off → checkout warns but allows; product card decrements immediately after a sale.

## Known-minor (deferred, not bugs)
- `displayProducts` useMemo doesn't fully stabilize (pendingStockDeltas() + filtered products are fresh refs each render) — but ProductGrid already received an equally-unstable array pre-9c, so no regression; decorative, perf-pass candidate.
- The existing scan-add guard (`CashierScreen.tsx:296`, unconditional "Stok habis") is left as-is — the new enforcement is the setting-gated CHECKOUT warning covering the reward path that 296 never guarded.

---

# ⭐ PRIOR SESSION — 2026-06-11 (SP-CRM-9b: Variant-Level Selectors + Collapsible Rewards)

Branch `prod-hardening`. Backend deployed **rev `00060-cdn`** (**NO migration**, NO OpenAPI change — composite IDs ride the existing `string[]` jsonb arrays). Built brainstorm→spec→plan→**subagent-driven** with per-task model routing (Sonnet implement / Opus review / Haiku spec-check). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-11-crm-sp9b-variant-selectors-collapsible-rewards*`.

## What this slice does
SP-CRM-9 let conditions grant a free PRODUCT (all its variants). SP-CRM-9b lets the business pick **specific variants** — e.g. "free 10ml ATOMIZER only", or "only buying the 110ml triggers the promo" — and declutters the POS reward UI.

## Encoding (zero migration)
`rewardProductIds` + `applicableProductIds` stay `string[]`. Each entry is `"pid"` (whole product, any variant — exactly what every pre-9b row means → full backward compat) or `"pid|size"` (that variant only). `|` never appears in size names. NO migration, NO API schema change.

## What shipped
- **Backend** (`100ed87`,`961159e`): `variantKey(pid,size)` helper (one source of the `pid|size` format, shared by 3 sites that must agree); `CreateOrder` eval set + preview eval set gain `pid|size` keys per paid line (engine UNCHANGED — it's a set lookup, pinned by tests in `d96cf15`); `rewardLineAllowed(menu,pid,size)` validates reward lines (whole-product OR exact variant); the fulfillment grant records the chosen item as `pid|size`; `parseMenu` splits composite entries → distinct product ids + per-product allowed-size set (nil=all sizes, whole-product wins), and `rewardProductMenu` filters returned variants by it.
- **Backoffice** (`82a294e`,`240c6e2`): one shared `ProductVariantPicker` (drill-down: whole-product checkbox + chevron → per-variant checkboxes; mutual-exclusion per product; skips id-less products) wired into BOTH Produk Pemicu and Produk Hadiah; `rewardGrantSummary` shows sizes.
- **POS** (`1bbef45`): "Hadiah Loyalti" rewards now COLLAPSE — each promo is a one-line "(name) — Tersedia!" row (chevron, collapsed by default); tap → variant menu; pick → re-collapses to "GRATIS: (product) · (size)" with Ganti/Hapus. Presentation-only (reducer/cart/receipt/props untouched).

## ✅ Verification — LIVE-PROVEN on rev `00060-cdn`
- Local gate green: backend build+test+`make gen-check` (no codegen drift); POS tsc + vitest 22/22; backoffice tsc+build.
- **Live smoke** (deployed): narrowed `#DIJAMINGORGEOUS` to `6560a172…|10ml ATOMIZER` → preview returned EXACTLY 1 product / 1 variant (225000); restored to the 3 whole-product entries → preview returned 3 products / 15 variants (backward-compat proven). Condition left restored to its original whole-product menu.
- Reviews: A1/A2/A3 go-reviewer (Opus) Approve (applied LOWs: `variantKey` DRY + log variant on dropped line); B1/C1 typescript-reviewer (Opus) Approve (applied MEDIUM: skip id-less products).

## ▶️ USER-PENDING (the only remaining work)
1. **NEW APK build** — POS UI changed (collapsible rows), so the tablet's current APK won't show it until rebuilt. Trigger `android-release.yml` (workflow_dispatch) on `prod-hardening` (agent lacks gh/token).
2. **On-device re-check** — after the new APK: collapsed "Tersedia!" rows; expand → variant menu; pick → "GRATIS: … · size"; and (optional) author a variant-level condition in backoffice (the drill-down picker) to confirm the form.

## Known-minor (deferred, not bugs)
- Backoffice picker doesn't reconcile a SAVED `pid|size` entry whose variant was later deleted/renamed — it lingers invisibly (counted in "N varian", no uncheck row). Backend treats it as a no-match (harmless, not an error). Auto-filtering on load is riskier (could drop valid entries before products load), so left as-is.
- POS reward GRATIS still not on the thermal-printed receipt (SP-CRM-9 v1 limitation, unchanged).

---

# ⭐ PRIOR SESSION — 2026-06-11 (SP-CRM-9: product_reward POS Fulfillment)

Branch `prod-hardening`. **Backend + POS + packages/api** (no backoffice code change). Backend deployed **rev `00059-297`** (**NO new migration** — reused `loyalty_condition_applications.reward_product_ids`). 18 commits `4bd8a05`…`50d554b`, pushed to origin. Built brainstorm→spec→plan→**subagent-driven** (fresh implementer per task + two-stage review: spec-compliance + go-reviewer/typescript-reviewer). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-10-crm-sp9-product-reward-fulfillment*`.

## What this slice does
SP-CRM-8 left `product_reward` conditions *recorded-but-not-fulfilled* (an audit grant meaning "was eligible," no free item handed over). SP-CRM-9 lets a cashier actually **give** the free item at checkout — picked online, added as a **Rp0 cart line**, with correct stock, receipt, and an "actually received" grant.

## Architecture (online-only v1)
- New **`POST /api/v1/sync/loyalty-preview`** (cashier-authed). Reuses the pure Go `EvaluateLoyalty` engine (single source of truth) → returns the eligible `product_reward` free-item menus `{conditionId, conditionName, products:[{id,name,variants:[{size,price}]}]}` for the current cart+customer. Read-only, advisory.
- POS CheckoutPanel shows a **"🎁 Hadiah Loyalti"** section; picking a product (+size) dispatches `CART_ADD_REWARD` → a Rp0 line `{isReward:true, rewardConditionId}` that flows through the existing item→stock→receipt path (cart sends `items: state.cart` unchanged).
- At commit, `CreateOrder` re-runs the engine on **paid items only**, validates each reward line (condition matched **and** chosen product ∈ menu), and writes the grant recording the **chosen** product (`points_contributed=0`). **This REPLACES SP-CRM-8's product_reward auto-record-on-match.** Invalid reward line = **lenient** (`slog.Warn` + drop from audit, sale still succeeds).

## What shipped
- **Backend:** `service.OrderItem` +`IsReward`/`RewardConditionID` (request-only, not persisted as columns); pure `ProductRewards(conds,ctx)` engine helper (+test); `loadActiveConditions`/`loadLoyalty` widened to pool-or-tx interfaces; `CreateOrder` builds the eval product-set from paid lines only + the new validated-grant loop (reuses existing `contains` from pricing.go); `service/loyalty_preview.go` `PreviewRewards` + product/variant menu resolution (active products only, lenient on missing customer); `handlers.LoyaltyPreview` + route. OpenAPI: `isReward`/`rewardConditionId` on `OrderItemInput`+`CartItem`, `LoyaltyPreview*` schemas + path (regen, gen-check green).
- **POS/shared:** `api.loyaltyPreview(...)` client; cart reducer `CART_ADD_REWARD`/`CART_REMOVE_REWARD` (one-per-condition, re-pick replaces, paid ops can't touch reward lines, reward lines dropped on customer change) + 9 vitest cases; CheckoutPanel "Hadiah Loyalti" section; CashierScreen preview-fetch effect (online + checkout-open + loyalty + customer; placed after `loyalty`/`derived` to avoid a TDZ; `?.id` dep) + pick/clear handlers; **GRATIS** labels in Cart + ReceiptPreview (no qty/remove controls on reward lines). The thermal-printed receipt not showing GRATIS is an accepted v1 limitation.

## Review-caught (all addressed)
- go-reviewer C1: preview now lenient on `pgx.ErrNoRows` customer (advisory read → empty, not 500) + wrapped errors. **Rejected** its float32-IDR-price concern (app-wide `type:number`→float32 convention; realistic IDR < 16.7M is exact) and the B1 "reward line shouldn't be in order_items" flag (it MUST be — that's how the free item decrements stock; only the FLAG fields aren't persisted as columns).
- ts-reviewer D2/D4: tightened `CART_ADD_REWARD` payload to compile-time-enforce `isReward:true`+`rewardConditionId`; reset `rewardsLoading` on the effect early-return; primitive `selectedCustomer?.id` dep.
- **⭐ E2 live smoke caught a real bug both code-reviews missed:** the handler used `httpx.JSON` (which wraps in `{data:...}`) on an already-enveloped `LoyaltyPreviewResponse{Data:...}` → **double-wrapped `{data:{data:[]}}`**. Fixed to `writeJSON` (commit `50d554b`); redeployed; re-smoke returns the correct single `{data:[]}`. (Sibling `RewardGrants` uses `writeJSON` for the same reason.)

## ✅ Verification — LIVE-PROVEN on rev `00059-297`
- Local gate green: backend `go build`+`go test ./...`+`make gen-check`; POS `tsc -b`+`vite build`+vitest **22/22**; backoffice `tsc -b` (additive schema, no break).
- **E2 authed smoke** (deployed): `/readyz` 200; no-token→401; missing customerId→400; authed real-customer preview→200 `{data:[]}` (correct envelope after the double-wrap fix).
- **E3 live e2e** (throwaway `cmd/sp9e2e`, real `service.OrderService` against the test DB, **all artifacts deleted + loyalty restored** — same protocol as SP-CRM-7/8): valid reward order → **stock −2** (paid+reward same variant, free item handed over); exactly **one product_reward grant** recording the chosen product, `points_contributed=0`; **replay idempotent** (dup, no double-grant/decrement); **bogus reward line → `slog.Warn` + no grant + sale succeeds** (lenient); **refund restocks +2, grant row immutable**; **CLEANUP OK**. Bonus: the order also earned +10000 from the pre-existing "First Registrant" `set_points` condition while the product_reward grant stayed at 0 points — confirms no point inflation from the free item + the existing earning path is intact. Throwaway removed (never committed).

## 🐛 ON-DEVICE CHECK FOUND A BLOCKER → FIXED (2026-06-11, commit `cf26e9d`)
User installed the APK, authored a `product_reward` condition ("#DIJAMINGORGEOUS", spending_threshold ≥ Rp1.25M, campaign) in backoffice — **"Hadiah Loyalti" never appeared for ANY trigger**. Systematic debug found TWO config-side root causes (the SP-CRM-9 backend/POS code was fine):
1. **The Kondisi Khusus form had NO UI for `rewardProductIds`** — picking "Reward Produk Gratis" just hid the points input; every form-authored condition saved an **empty free-item menu**, and `PreviewRewards` silently drops menu-less rewards (loyalty_preview.go `continue`). The user had picked products in "Produk Pemicu" (= `applicableProductIds`, the trigger filter) thinking it was the menu. The E3 e2e missed this because it inserted its condition via SQL, bypassing the form.
2. **Engine: a `campaign` with a missing start OR end date NEVER matches** (loyalty.go `matches()` requires both, by design) — the user's campaign had no end date, so even with a menu it could not fire. (`rewardValue=0` is fine — the ≤0 guard only applies to set/multiply points.)
**Fixes:** (a) live-patched the condition via PUT (menu = the 3 picked products GORGEOUS TUBEROSE/HOLY SWEET/ONLY THE BRAVE, end date 2026-12-31) — **preview live-verified: ≥Rp1.5M cart returns the 3-product menu, Rp500k returns empty**; no redeploy needed, the tablet should now show the section. (b) `cf26e9d` adds the **"Produk Hadiah" picker** to the form (shown for product_reward) + save guards: ≥1 reward product, and campaign requires BOTH dates. Backoffice auto-deploys via Cloudflare on push. Known-minor: the `toggleCond` activate path bypasses the saveCond guards (pre-existing rows can still be toggled active).

## ▶️ USER-PENDING (the only remaining work)
1. ~~APK build~~ — **DONE (user-confirmed 2026-06-11)**: `android-release.yml` ran on `prod-hardening`.
2. **On-device check + fleet rollout** — retry on the tablet: cart ≥ Rp1.25M + customer attached + online → "🎁 Hadiah Loyalti" with the 3-product menu. (First attempt failed due to the form gap above, now fixed.)
3. (Optional) backoffice hard-refresh to confirm a fulfilled order's customer shows the chosen product under "Reward Produk".

## Deferred / next
- **Offline reward eval** (on-device condition evaluation) — the explicit future follow-up.
- Persisting `is_reward` on `order_items` (v1 is migration-free; reprinted thermal receipts won't show GRATIS).
- Strict-reject of invalid reward lines (v1 is lenient+logged).
- **SP-CRM-Merge** (dup-candidate review queue) still pending.

---

# 📋 COPY-READY: (HISTORICAL) SP-CRM-8 kickoff — now DONE

Paste the block below as the first message of a new session. (Full current state is in the ⭐ LATEST SESSION section further down; this block is the self-contained kickoff.)

```
continue Mandalika POS / next = SP-CRM-8 (Loyalty-Conditions Trigger Engine), the slice that finally WIRES the unwired loyalty_conditions table into the earning path so orders earn variable/bonus points. Read SESSION_HANDOFF.md (⭐ LATEST SESSION at top, = SP-CRM-7) + the crm-customers-module + product-module-roadmap memories FIRST, confirm the 6 working rules, then kick off superpowers:brainstorming for SP-CRM-8 before any code.

THE 6 WORKING RULES (confirm these — the user expects them every session):
1. Ask, don't assume  2. Don't touch unrelated  3. Flag uncertainty  4. Verify on failure  5. Show changes  6. Admit gaps

⚠️ SP-CRM-8 = WIRE THE UNWIRED ENGINE: `backend/internal/service/pricing.go` computes earned points as a flat `floor(total/1000)*pointsPerThousand` (gated loyaltyEnabled && hasCustomer). The `loyalty_conditions` table (7 trigger types: first_registration/birthday/anniversary/double_date/member_day/product_purchase/spending_threshold; 3 reward types: set_points/multiply_points/product_reward; + campaign dates, active_days, applicable_product_ids, minimum_spend) is CRUD'd in the backoffice Loyalitas→Kondisi Khusus tab + listed via /loyalty-conditions but NEVER evaluated anywhere. SP-CRM-8 builds the condition-evaluation engine into the earning path so an order earns variable points, and writes the SP-CRM-7 points ledger (earn entries already flow through `write.InsertPointTx`). This is the SECOND consecutive slice on the hot order/earning path — same care as SP-CRM-7 (math correctness, idempotency via processed_keys, don't pollute prod to verify). Brainstorm the scope first (which triggers, server-vs-POS eval, birthday/anniversary needs the customer's dates which ARE on the order's customer).

PROJECT STATE (as of 2026-06-09):
- Branch `prod-hardening`. Backend Cloud Run rev **00055-n5h** (migrations →0031, next slot = 0032). Backoffice auto-deploys via Cloudflare on push; backend deploys via `gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet`; APK via GH Actions android-release.yml. Real-data deployment (30+ outlets, thousands trx/day, 50k–500k identified customers).
- DONE: SP-CRM-1..6, and **SP-CRM-7 (points ledger + manual adjustment + refund reversal — deployed rev 00055-n5h, mig 0031; adjust/ledger/lean-sync 16/16 authed + schema/CHECK/index proven + earn/redeem/refund/forgiveness/idempotency LIVE-PROVEN 12/12 via a real-OrderService e2e)**.
- NOTE: **loyalty is currently OFF in prod** (`loyalty_settings.enabled=false`, though points_per_thousand=1 + redemption_rate=100 are configured) → earning is DORMANT until the business enables it. The e2e briefly toggled it on→off to prove the path.
- USER-PENDING: SP-CRM-5b on-device APK check + fleet rollout; SP-CRM-6 + SP-CRM-7 backoffice visual walkthroughs.

THE CRM MODULE — SP-CRM-1..7 DONE; remaining (each own spec→plan→build):
- SP-CRM-8 — Loyalty-conditions trigger engine (NEXT; touches pricing.go/order.go — the hot earning path; writes the SP-CRM-7 ledger). See ⚠️ above.
- SP-CRM-Merge — backoffice approval review queue for the `customer_dup_candidates` flagged by SP-CRM-3. NEVER auto-merge. Deferred.
MODULE-WIDE LOCKED: backoffice now / POS later (additive-nullable, POS-ready); customer detail = full-page IN-SCREEN VIEW SWAP (no router); phone uniqueness = soft warn, no DB constraint; phone NORMALIZATION deferred; OFFSET pagination. LEAN-SYNC: tags + interactions + reminders + the points LEDGER hydrate BACKOFFICE-ONLY (NOT on the shared customerObj); EXCEPTIONS on the shared customerObj: `segment` (computed) + `points` (the cached balance the POS uses for redemption).
⚠️ KNOWN PRE-EXISTING BUG (out of scope — likely relevant to SP-CRM-8 since it's loyalty-settings): the backoffice Loyalitas settings `loyaltyForm` is initialized from DEFAULT_LOYALTY and NEVER synced from the fetched `lq.data`, so "Simpan Pengaturan" clobbers untouched fields (enabled/pointsPerThousand/redemptionRate) with defaults. Pre-dates the CRM work. (5b worked around it for tierEnabled only.) Worth fixing as part of SP-CRM-8.

CURRENT CUSTOMERS MODULE (post SP-CRM-7):
- Backoffice `screens/Customers.tsx` — `Daftar | Pengingat` sub-tab. Daftar = list (pagination + search + sort toggle + TAG filter + SEGMENT filter; tag+segment chips; "Kelola Tag"/"Kelola Segmen" managers). Pengingat = birthday/anniversary reminders list (7/30-day window + type filter, soonest-first, row→detail). Row → `CustomerDetail.tsx` (profile, stats, history, TAG section, SEGMENT badge, birthday/anniversary header BADGE ≤30d, **Timeline Interaksi** section, **Poin section** = balance + paginated ledger + `manage_settings`-gated "Sesuaikan Poin" form). UI: `screens/customers/{TagManager, SegmentManager, tagColors, interactionTypes, pointTypes}.ts(x)`.
- POS `apps/pos/src/cashier/CustomerPicker.tsx` — shows `customer.segment` chip; reads cached `customer.points` for redemption. (SP-CRM-6 + SP-CRM-7 added NOTHING to the POS.)
- Customer model: { id, name, phone, email?, birthday?, anniversary?, notes?, points (cached balance), totalSpent, visitCount, lastVisit?, createdAt, tags?, segment? } (interactions/reminders/point-ledger are NOT on the customer object — separate endpoints).
- TS client: listCustomers(...), getCustomer, getCustomersByPhone, lookupCustomers, CRUD; listTags/.../setCustomerTags; listSegments/...; listInteractions/createInteraction/deleteInteraction; listReminders({window,type,page,limit}); **listPointTransactions(id,page,limit); adjustPoints(id,{points,reason})→{balanceAfter}**.
- Backend customers: migs 0026–0029 (indexes/dup-candidates/tags/segments), 0030 (interactions + MMDD cols), **0031 point_transactions ledger + orders.points_earned**. `customerObj` (shared) includes computed `segment` + cached `points`; `customerObjWithTags` = +tags (backoffice only). Earning: `service/order.go` CreateOrder writes earn/redeem ledger entries (math unchanged) + persists points_earned; Refund reverses points (clawback floor-0 + restore). Endpoints add: **/customers/{id}/points (GET ledger, manage_customers), /customers/{id}/points/adjust (POST, manage_settings)**.

PROCESS: brainstorm → spec → plan → subagent-driven build (fresh implementer per task + go-reviewer/typescript-reviewer two-stage review). Backend pattern: edit openapi.yaml → `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml` → `corepack pnpm --filter @mandalika/api gen` → build/test → `make gen-check` (commit api.gen.go). NOTE: OpenAPI paths use the `/api/v1/...` prefix; Go route registrations use the un-prefixed form (the group adds /api/v1). Login + all reads use the `{data:...}` envelope (httpx.JSON) — the access token is at `resp.data.access`. Verify: deploy → /readyz → authed live check (pull SEED_ADMIN_PASSWORD via `gcloud secrets versions access latest --secret=SEED_ADMIN_PASSWORD` in command-substitution; never print). DB checks via a pgx throwaway `backend/cmd/<name>` with a tx that ROLLS BACK (DATABASE_URL via the same gcloud-secrets substitution); delete the throwaway after. NOTE: deployed admin login email is admin@mandalika.test (NOT .local). Secret Manager has SEED_ADMIN_PASSWORD + DATABASE_URL (+ JWT/REDIS/CLOUDINARY/SENTRY).

GOTCHAS: commit hook false-positives on chained `git commit && ...` (run git add then commit separately; never --no-verify); CI make gen-check fails if api.gen.go drifts; Neon first-write-after-idle transient (retry warm); tethered-network git pushes drop ("Connection was reset") — just retry; `-race` can't run locally on this Windows box (no cgo/C compiler) — run `go test` without it, CI does race on Linux.
```

---

# ⭐ LATEST SESSION — 2026-06-10 (SP-CRM-8: Loyalty-Conditions Trigger Engine) — READ THIS FIRST; supersedes everything below

Branch `prod-hardening`. **Backend + backoffice only** (no POS, no APK). Backend deployed **rev `00056-wx9`** (migration **0032** applied + verified; `/readyz` ok). Commits `cfd4dcd`(mig)→…→`ca9e4ab`. Built brainstorm→spec→plan→**subagent-driven** (fresh implementer per task + two-stage review: spec-compliance + go-reviewer/typescript-reviewer). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-10-crm-sp8-loyalty-trigger-engine*`.

## What this slice does (wires the unwired engine)
Before SP-CRM-8 the `loyalty_conditions` table was CRUD'd in the backoffice but **never evaluated**; every order earned a flat `base = floor(total/1000)×pointsPerThousand`. Now `CreateOrder` evaluates active conditions and earns **variable** points.

## Scope decisions (locked with user)
- **set_points + multiply_points** ship fully (points → SP-CRM-7 earn ledger). **product_reward** is **evaluated + recorded** (audit grant row, backoffice-visible) but free-item **fulfillment is DEFERRED to a future POS slice** (it's receipt/POS-coupled; server never injects items).
- **Stacking:** `earned = round(base × bestMultiplier) + Σ(matching set_points)`. Multipliers do NOT compound (single highest wins; ties → first by created_at,id). `reward_value ≤ 0` ignored.
- **Eval date:** `client_created_at` in **WIB (UTC+7 fixed, no tzdata)**, fallback server `now()`.
- **Recording:** full audit — one append-only row per applied condition.
- Also **fixed the pre-existing loyaltyForm clobber bug** (+ hardened against poll-refetch race). POS checkout estimate still shows the flat base (server authoritative; customer earns ≥ shown — a future POS slice mirrors the engine).

## What shipped (SP-CRM-8)
- **Migration 0032:** `loyalty_condition_applications` (order_id/customer_id CASCADE, condition_id SET NULL, snapshots of name/trigger/reward_type/reward_value, points_contributed, reward_product_ids jsonb) + 3 indexes + **UNIQUE (order_id, condition_id)**.
- **Pure engine `service/loyalty.go`** (no DB import, 16 table tests): `EvaluateLoyalty(conds, ctx) → {BestMultiplier, FlatBonus, Applied[]}`; `FinalEarned(base)`; `LoyaltyEarnReason(...)` breakdown string. All 7 triggers (first_registration/birthday/anniversary/double_date/member_day/product_purchase/spending_threshold) + campaign window + WIB.
- **`order.go` CreateOrder wiring:** expanded the customer FOR UPDATE select to load birthday/anniversary/visit_count; `loadActiveConditions` tx read; `finalEarned` replaces `res.EarnedPoints` at orders.points_earned + customer balance + earn ledger (Points/BalanceAfter) + breakdown reason; one `write.InsertConditionApplication` per matched condition. **Byte-identical when no condition matches** (bestMultiplier=1, flatBonus=0). Refund unchanged — already claws back orders.points_earned (now the full bonus-inclusive total).
- **API:** `appliedCount` (optional) on LoyaltyCondition read (correlated count); `GET /customers/{id}/reward-grants` (manage_customers) → product_reward grants; TS client `listRewardGrants`.
- **Backoffice:** loyaltyForm seeded-once from server (bug fix); "Terpakai: N×" per condition; "Reward Produk" grants list on CustomerDetail (`screens/customers/rewardTypes.ts`).

## Review-caught (all addressed)
- go-reviewer (engine): added missing tests (fractional multiplier, flat-only reason, early-morning WIB campaign boundary). **Rejected a false positive** — the reviewer claimed `dateOnly` mishandled early-morning WIB, but `t.Year()/Month()/Day()` use t's own location (identical to `t.Date()`); proven correct by a passing regression test.
- go-reviewer (hot path): hardened `outcome` init to `{BestMultiplier:1.0}` (no-match invariant footgun). Rejected the unique-index NULL "gap" with reasoning (condition_id always non-NULL at insert; `NULLS NOT DISTINCT` would break ON DELETE SET NULL). Caching of `loadActiveConditions` deferred to the loyalty-enable cutover (small config table; fine at current scale).
- typescript-reviewer: surfaced a real **poll-race clobber** in the loyaltyForm fix → guarded with a seed-once `useRef`. (eslint is NOT CI-enforced here — `tsc -b`+`vite build` is the gate.)

## ✅ Verification — LIVE-PROVEN on rev 00056-wx9
- Engine: 16 unit tests. Backend `go build` + `go test ./...` green; backoffice `tsc -b` + `vite build` clean; `make gen-check` clean.
- DB (throwaway, tx rolled back): table + 5 indexes + UNIQUE + orders.points_earned present.
- **Live e2e (real `service.OrderService`, throwaway, briefly toggled loyalty on→off, all artifacts deleted):** order earned **200 = base(50)×2 + 100**; earn ledger 200 with reason `"Poin transaksi MND-000039 (dasar 50 ×2 + SP8 Set +100)"`; 3 application rows (set=100, multiply=base, product=0) + product grant with reward_product_ids; **replay idempotent** (no double earn/apps); **refund clawed back to 0** (full bonus-inclusive); **stock net-zero**. Loyalty confirmed back OFF + zero SP8 leftovers (safety-net clean run). Order# advanced by 2 (MND-000039), harmless. **NOTE: loyalty stays OFF in prod** — the engine is dormant until the business enables it.

## ▶️ USER-PENDING — backoffice visual walkthrough
Hard-refresh `mandalika-pos.pages.dev` → Pelanggan/Loyalitas: (1) Loyalitas settings now persist correctly (the clobber bug is fixed); (2) Kondisi Khusus list shows "Terpakai: N×" per condition once any fire; (3) a customer detail with a product-reward grant shows the "Reward Produk" list. (Engine is dormant until loyalty is enabled, so counts/grants stay empty until then.)

## Deferred / next
- **product_reward fulfillment** (inject free items / stock / receipt) — its own POS slice.
- **POS checkout** showing real engine points at the register — POS slice.
- **`loadActiveConditions` caching** when loyalty goes live at scale (short TTL, invalidate on condition writes).
- **SP-CRM-Merge** (dup-candidate review queue) still pending.

---

# ⭐ PRIOR SESSION — 2026-06-09 (SP-CRM-7: Points Ledger + Manual Adjustment + Refund Reversal)

Branch `prod-hardening`. **Backend + backoffice only** (no POS, no APK). Backend deployed **rev `00055-n5h`** (migration **0031** applied + verified; `/readyz` ok). Commits `8c8061d`(spec)→`6daaa3e`(plan)→`8931f8b`. Built brainstorm→spec→plan→**subagent-driven** with the backend SPLIT into two dispatches (foundation T1-3, then the high-risk earning/refund T4-6) so the live-path change got focused review; per-batch two-stage review (spec-compliance + go-reviewer/typescript-reviewer); all findings fixed. Spec/plan: `docs/superpowers/{specs,plans}/2026-06-09-crm-sp7-points-ledger*`.

## Scope decision (the big one)
SP-CRM-7 bundled two separable subsystems; user chose **ledger + adjustment + refund-reversal NOW, defer the loyalty-conditions trigger engine to SP-CRM-8** (it changes the earning AMOUNT, upstream of the ledger). KEY architecture: `customers.points` STAYS the cached authoritative balance (POS reads it for redemption); the ledger is the audit spine; **ledger-forward-only** (no 500k backfill); **floor-at-0** everywhere.

## What shipped (SP-CRM-7)
- **Migration 0031:** `point_transactions` (type CHECK earn/redeem/adjust/refund, signed `points` CHECK<>0, `balance_after` CHECK>=0, reason, order_id FK→orders SET NULL, created_by FK→users SET NULL, created_by_name, FK→customers CASCADE) + idx `(customer_id, created_at DESC, id DESC)`; `orders.points_earned`.
- **Ledger writes:** `write.InsertPointTx(ctx,tx,row)` shared helper (NULLIF convention, Go-layer type guard) — called INSIDE the order/refund tx. `write.PointsClawback` (floor-0 + forgiveness, TDD'd). `write.AdjustPoints` (manual `Pool.Begin` NOT `r.tx` — avoids an all-outlets resync blast; sentinel errors ErrZeroDelta/ErrInsufficientPoints/ErrReasonRequired).
- **CreateOrder (`service/order.go`):** records `earn`(+earned)/`redeem`(−redeemed) ledger entries + persists points_earned. **POINTS MATH BYTE-UNCHANGED** (the `points=points+$2-$4` UPDATE untouched — only recorded). Idempotent (inside the processed_keys-guarded tx). Earn/redeem writes guarded by `hasLoyaltyCustomer`.
- **Refund (`service/order.go`):** now reverses points — clawback earned (`PointsClawback`, floor-0, forgiveness noted) + restore redeemed, two `refund` ledger entries + cached-balance update. Fixes the latent bug (refund previously never touched points). Idempotent (after the already-refunded short-circuit).
- **Manual adjustment:** `POST /customers/{id}/points/adjust {points(signed),reason}` gated **manage_settings** (NOT manage_customers — it mints value); over-subtract/zero/empty-reason→400, missing→404, success→200 `{data:{balanceAfter}}`. Ledger view `GET /customers/{id}/points` gated manage_customers.
- **Backoffice:** reserved "Poin (ledger)" card → real **Poin** section (`CustomerDetail.tsx`): balance + paginated ledger (type chip, signed colored pts, balance_after, reason, date, author) + a gated "Sesuaikan Poin" form (integer-only validation accepting `+50`/`-20`, resets on open/cancel). New `screens/customers/pointTypes.ts`.
- **Lean-sync preserved:** the ledger is OFF `customerObj` (verified no leakage); the cached `points` stays on it (POS redemption, unchanged).

## Review-caught (all fixed + re-verified)
- go-reviewer (foundation): NULLIF convention over nullStr+::uuid; **AdjustPoints `Pool.Begin` not `r.tx`** (r.tx bumps content_versions → full customer resync to all 30+ outlets on every adjust); ledger CHECK constraints (points<>0, balance_after>=0); Go-layer type guard; table-driven test. Commit `79d6c5f`.
- go-reviewer (earning/refund, NO critical, NO correctness/idempotency/concurrency bug): `AdjustPoints` 400-vs-500 split via sentinels; `hasLoyaltyCustomer`-guard the ledger writes; error-wrap the 4 InsertPointTx call-sites; lock-order safety comment; rename shadowing `reason`→`clawReason`. Commit `64ded65`. (Kept manage_settings gate — user's explicit decision; left same-second ledger ordering as a documented known-minor since balance_after is authoritative per-row.)
- typescript-reviewer (backoffice): **integer-only amount validation** (was `parseInt` → silent `5.5`→`5`; now `Number`+`Number.isInteger`, accepts `+50`); reset form fields on open/cancel; avoid a double refetch; drop redundant annotation. Commit `8931f8b`.

## ✅ Verification — adjust/ledger/lean-sync DONE (16/16 on rev 00055-n5h) + schema/CHECK/index
Authed (temp customer, cleaned up): adjust +100→balanceAfter 100 + cached `points` reflects it + ledger `adjust` entry (author Administrator); adjust −30→70; **over-subtract→400, zero→400, empty-reason→400**, balance unchanged after rejects; missing-customer→404; lean-sync regression (by-phone + lookup carry cached `points` but NO ledger). DB (pgx throwaway, rolled back): table+index+points_earned exist; **CHECK constraints actively reject** points=0 and balance_after=-1 (valid row accepted); per-customer read → **Bitmap Index Scan on idx_point_transactions_customer**. Throwaways deleted. Backoffice `tsc -b`+`vite build` clean.

## ✅ earn/redeem/refund — LIVE-PROVEN 12/12 (e2e, 2026-06-09→10)
A throwaway `cmd/crm7e2e` called the REAL `service.OrderService.CreateOrder`+`Refund` against the prod DB: briefly toggled `loyalty_settings.enabled` on (restored to false immediately + via defer), created O1 (earn) + O2 (earn+redeem 20), refunded both, then DELETED all artifacts (order_items/processed_keys/point_transactions/orders/customer; stock net-zero via the refunds' restock; order# advanced by 2, harmless). Verified ledger: earn+50→50, earn+50→100, redeem−20→80, refund clawback−50→30, refund clawback−30→0 (**floor-0, "20 poin dimaafkan"** forgiveness), refund restore+20→20; final balance 20; `orders.points_earned` 50/50; **replay no double-log; double-refund no double-reverse** (idempotency live-confirmed). loyalty confirmed back to false after. (Same-created_at rows sort by random `id` tiebreak — the documented known-minor; `balance_after` is authoritative.) **NOTE: loyalty is OFF in prod** — earning stays dormant until the business enables it.

## ▶️ USER-PENDING — backoffice visual walkthrough
Hard-refresh `mandalika-pos.pages.dev` → Pelanggan → open a customer → the **Poin** section: ledger list + (as an admin/`manage_settings` user) the "Sesuaikan Poin" form (+/− amount + reason).

---

# ⭐ PRIOR SESSION — 2026-06-09 (SP-CRM-6: Interaction Log + Birthday/Anniversary Reminders)

Branch `prod-hardening`. **Backend + backoffice only** (no POS, no APK). Backend deployed **rev `00054-vql`** (migration **0030** applied + verified; `/readyz` ok). Commits `a624a47`(spec)→`a4fbf8c`(plan)→`2d20dd4`. Built brainstorm→spec→plan→**subagent-driven** (per-batch two-stage review: spec-compliance reviewer + go-reviewer/typescript-reviewer; all findings fixed). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-09-crm-sp6-interaction-log-reminders*`.

## Scope decision (the big one)
Trigger-firing was **deferred to SP-CRM-7** — see the ⚠️ in the COPY-READY block: the whole `loyalty_conditions` engine is unwired, so "fire birthday/anniversary triggers" means building condition-evaluation into the earning path (SP-CRM-7's reserved risky territory). SP-CRM-6 = interaction log + reminders (both read-only/additive, zero earning-path risk); reminders are the manual bridge. "Lifecycle" (new/active/at-risk/churned) was NOT rebuilt — already subsumed by the SP-CRM-5 RFM segments.

## What shipped (SP-CRM-6)
- **Migration 0030:** `customer_interactions` (id, customer_id FK→customers CASCADE, type CHECK telepon/kunjungan/pesan/catatan, interaction_date, note, created_by FK→users SET NULL, **created_by_name snapshot**, created_at) + index `(customer_id, interaction_date DESC, created_at DESC)`. Plus two **STORED generated** cols on `customers`: `birthday_mmdd`/`anniversary_mmdd` (=month*100+day) + partial indexes `WHERE … IS NOT NULL`.
- **Interaction log** (create+delete ONLY, no edit): `write/interaction.go` (validate type enum; empty date→today else YYYY-MM-DD; author from authed caller `h.caller(r)`, not body; customer-scoped delete→404; FK/bad-UUID 23503/22P02→404). Reads: `Interactions` (paginated newest-first). Endpoints `GET/POST /customers/{id}/interactions`, `DELETE …/{iid}` — all `manage_customers`.
- **Reminders:** pure TDD'd `mmddWindow(today,days)` in `read/reminders.go` (month rollover + year-end wrap + Feb-29→Mar-1 fold in non-leap years; clamp [0,366]; 7 tests) → `Reminders` UNION-ALL of birthday+anniversary rows joined to the unnested MMDD window over the partial indexes, soonest-first, paginated. `GET /customers/reminders?window=7|30&type=birthday|anniversary|all` (strict 400 on bad window/type; static route registered before `/customers/{id}`).
- **Backoffice:** `Timeline Interaksi` section replaces the reserved card in `CustomerDetail.tsx` (inline add: type/date(defaults today)/note + delete; paginated; busy guards) + a client-side 🎂/💍 header badge (≤30d, computed from already-loaded `c.birthday`/`c.anniversary` — zero query). `Customers.tsx` gets the `Daftar | Pengingat` sub-tab (in-screen swap) with the windowed reminders list (7/30 toggle, Semua/Ulang Tahun/Hari Jadi filter, "dalam N hari" labels, row→detail). New `screens/customers/interactionTypes.ts`. **"Poin (ledger)" placeholder kept** (SP-CRM-7).
- **Lean-sync preserved:** interaction/reminder data stays OFF the shared `customerObj` — verified no leakage on `/sync/customers/lookup` + `/customers/by-phone`.

## Review-caught (all fixed + re-verified)
- go-reviewer (3 Important): `Interactions` query reordered to filter-first param order (latent swap-bug); `CreateInteraction` FK `23503`/bad-UUID `22P02` → `ErrNotFound` → 404 (was a leaky 400); `window` strictly validated to 7/30 (was silent fallback). + Minors: `http.StatusInternalServerError` constant, two `mmddWindow` edge-case tests (days=0/negative), leap-year operand comment. Commit `36c8d05`.
- typescript-reviewer: client `listReminders` `window` guard `!== undefined` (was falsy, dropped 0); spec gap — interaction date input now **defaults to today** (rendered blank before); `addInteraction` avoids a stale/redundant refetch (conditional on iPage); delete `IconButton` `disabled={iBusy}`; `Button loading={iBusy}`. Commit `2d20dd4`. (NOTE: the reviewer's "drop the refetch" suggestion was rejected — it would break the already-on-page-1 case; used a conditional instead.)
- The real `<Pagination/>` API is `page`/`totalPages`/`total`/`onChange`/`pageSize`/`onPageSizeChange` from `../ui` (the plan had guessed `onPageChange`/a different path) — corrected during build.

## ✅ Verification — DONE (21/21 authed on rev 00054-vql + index EXPLAIN)
Scripted authed check (temp customer with today's birthday/anniversary, cleaned up): interaction create→list round-trips type/date/author(`Administrator`)/note + meta; bad type 400; nonexistent customer 404; cross-customer delete 404; delete 200 → gone. Reminders: window=7 returns the temp customer (2 rows: birthday+anniversary) with kind+daysUntil, soonest-first; window=30 ⊇ window=7; type=birthday only birthday; **invalid window=14 → 400, type=xxx → 400**; `/customers/reminders` returns the array envelope (not swallowed by `/{id}`). Regression: by-phone + lookup customers carry NO interaction/reminder fields (lean-sync holds). Index check (pgx throwaway, tx rolled back): all 3 indexes + 2 generated cols + the table exist; windowed birthday query → **Index Scan using idx_customers_birthday_mmdd** (seqscan off). Throwaways deleted. Backoffice `tsc -b` + `vite build` clean. (`-race` not run locally — no cgo on this box.)

## ▶️ USER-PENDING — backoffice visual walkthrough
Hard-refresh `mandalika-pos.pages.dev` → Pelanggan: the **Daftar | Pengingat** sub-tab; Pengingat shows upcoming birthdays/anniversaries (7/30 toggle + type filter); open a customer → **Timeline Interaksi** (add a Telepon/Kunjungan/Pesan/Catatan with a date + note; delete one) + the 🎂/💍 header badge when a date is within 30 days. (Build + 21/21 authed verified; this is the human visual confirm.)

---

# ⭐ PRIOR SESSION — 2026-06-08 (SP-CRM-5b: POS Segment Display)

Branch `prod-hardening`. Frontend + POS only — **NO backend change** (segment already on the reads from 5a), so backend stays rev `00053-ckl`. Commits `9d0b39d`(spec)→`f5e9632`. Built brainstorm→spec→plan→subagent-driven (typescript-reviewer per batch; no go-reviewer — no Go). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-08-crm-sp5b-pos-segment-display*`.

## What shipped (code complete; push + APK pending — see below)
- **POS** (`apps/pos/src/cashier/`): the cashier `CustomerPicker` now shows the customer's **segment as a small colored chip** (selected-customer line + dropdown rows), via a new POS-local `segmentColors.ts` (8-token map mirroring the backoffice palette). The chip is **decoupled from `loyaltyEnabled`** (segment is RFM, not loyalty); `· {points} poin` stays loyalty-gated. **`getCustomerTier` retired** from `pricing.ts` (the spend-ladder is fully gone POS-side).
- **Backoffice** (`Customers.tsx`): removed the now-orphaned **"Sistem Tier"** toggle from the Loyalitas settings + its status mention. `saveLoyalty` now passes through the **server's** `tierEnabled` (`{...loyaltyForm, tierEnabled: loyalty.tierEnabled}`) so it isn't clobbered by the stale form default. The `tierEnabled` schema field is left vestigial (no migration).

## Review-caught (fixed + re-verified)
typescript-reviewer (HIGH): removing the toggle would have frozen `tierEnabled=true` in the save payload because `loyaltyForm` is never synced from the server → fixed in-scope by passing the server value through in `saveLoyalty`. Minors: POS dropdown chip `flex-wrap` consistency; tightened `segmentColors` to a `SegmentColor` union (mirrors backoffice tagColors). Commit `f5e9632`. **Surfaced a pre-existing out-of-scope bug** (NOT fixed): `loyaltyForm` is never seeded from `lq.data`, so saving loyalty settings clobbers untouched fields with defaults — predates the CRM work; see the ⚠️ note in the COPY-READY block.

## ✅ Verification — builds green (both apps); live/on-device PENDING
`apps/pos` + `apps/backoffice` `tsc -b` + `vite build` both clean. No backend live-check (nothing backend changed; segment-on-POS-reads already proven 18/18 in 5a).

## ✅ ROLLOUT (resolved 2026-06-09)
- **PUSH:** landed — `prod-hardening` through `f5e9632` is on the remote; backoffice "Sistem Tier" removal live via Cloudflare.
- **APK BUILT:** `android-release.yml` run #27181965221 → success → artifact **`mandalika-pos-release-apk`** (13.7 MB, expires 2026-09-07).
- **STILL USER-PENDING:** install the APK + on-device check (cashier picker shows the segment chip; no tier text; points still loyalty-gated) + fleet rollout. Old devices keep the old spend-tier until updated — cosmetic, no degradation.
- **Backoffice visual (user-pending):** confirm the Loyalitas settings no longer show "Sistem Tier".

---

# ⭐ PRIOR SESSION — 2026-06-08 (SP-CRM-5a: Configurable Segment Engine — backend + backoffice)

Branch `prod-hardening`. Backend/backoffice only (no APK). Backend **rev `00053-ckl`** (migration **0029** applied + seeded; `/readyz` ok). Commits `fa08789`(spec)→`a29c284`. Built brainstorm→spec→plan→subagent-driven (go-reviewer + typescript-reviewer per batch). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-08-crm-sp5a-configurable-segment-engine*`.

## Scope decision (the big one)
User chose **segments REPLACE tiers, everywhere INCLUDING the POS** — phased like SP-CRM-3: **5a = backend + backoffice (this session)**, **5b = POS cashier swap + APK** (next). Lean delivery to the POS: the segment is **computed server-side from the stored rules and emitted as a tiny `{id,name,color}` on the SHARED `customerObj`** (so it's already on the POS-facing reads — 5b is just a display swap, no rules synced, no on-device compute). This intentionally REVERSES the tags backoffice-only stance (justified: one small field the POS will use).

## What shipped (5a)
- **Migration 0029:** `customer_segments` (R/F/M min/max bounds, color, sort_order, is_active) + seed the **6** (Baru/Juara/Setia/Berisiko/Hilang/Biasa).
- **Computation:** `segmentMatch`/`segmentSel`/`segmentIdSel` — a correlated first-match-by-sort_order sub-select, folded into the shared `customerObj` (+ `customerObjWithTags`). **BARE-column correlation** (`last_visit`/`visit_count`/`total_spent`, not `customers.`-qualified) so it survives `RecentCustomersForOutlet`'s `customers c` alias. null lastVisit → recency rules can't match → falls to a no-recency rule (Baru); no match → null (Biasa catch-all covers default). `Customers(...,segmentId)` filter. `Segments()` list.
- **Backend:** segment CRUD + `ReorderSegments(orderedIds)` (tx, sort_order=index+1, count-guard against partial lists) in `write/segment.go`; validate color + min≤max + non-negative bounds; endpoints `GET/POST /segments`, `PUT/DELETE /segments/{id}`, `PUT /segments/reorder` (registered before `/{id}`), gated `manage_customers`.
- **TS client:** listSegments/createSegment→{id}/updateSegment/deleteSegment/reorderSegments; listCustomers(...,segmentId).
- **Backoffice:** replaced the **tier column → Segmen chip** + **detail tier badge → segment badge** (removed the `tier()` helper + tier props; the Loyalitas "Sistem Tier" toggle is UNTOUCHED); **segment filter dropdown** + **"Kelola Segmen" manager** (`SegmentManager.tsx`: CRUD + up/down reorder + R/F/M bounds editor) + **Segmen export column**.

## Review-caught (all fixed + re-verified)
go-reviewer: first-match tiebreaker (`ORDER BY sort_order, created_at`) for sort_order ties; reorder error-wrap + partial-list count guard; reject negative R/F/M bounds (`9bdeafd`). typescript-reviewer: `move()` swallowed reorder errors → added catch; broad `as Partial<SegmentInput>` cast → typed `numPatch` helper; explicit `EMPTY.isActive` (`a29c284`). Client already used the correct `{id}`/void return types.

## ✅ Authed live verification — DONE (18/18 on rev 00053-ckl)
6 segments seeded + ordered; **new customer (F=0, null lastVisit) → "Baru"** (null-lastVisit semantics); `?segmentId` filter returns ONLY that segment; **segment present on `/sync/customers/lookup` + `/customers/by-phone`** (POS-ready for 5b); segment CRUD + reorder + (invalid color / min>max / partial-reorder) rejection. Temp data cleaned up. Admin login email = `admin@mandalika.test`.

## ▶️ PENDING
- **SP-CRM-5b (POS + APK):** swap the cashier picker to show `customer.segment` instead of `getCustomerTier`; retire `getCustomerTier`; settle the `tierEnabled` toggle. Segment is already on the POS reads — no backend change expected.
- **Visual USER-PENDING:** hard-refresh `mandalika-pos.pages.dev` → Pelanggan: Segmen column/chips, segment filter, "Kelola Segmen" manager (CRUD + reorder), detail segment badge.

---

# ⭐ PRIOR SESSION — 2026-06-08 (SP-CRM-4: Manual Tags)

Branch `prod-hardening`. Backoffice-only (no APK). Backend **rev `00052-8wv`** (migration **0028** applied; `/readyz` ok). Commits `a61361d`(spec)→`6c943d6`. Built brainstorm→spec→plan→subagent-driven (go-reviewer + typescript-reviewer per batch). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-08-crm-sp4-manual-tags*`.

## What shipped
Managed customer tags (colored labels staff apply to customers, organize + filter the base).
- **Migration 0028:** `tags (id, name UNIQUE, color, sort_order, created_at)` + `customer_tags` join (composite PK, both FKs ON DELETE CASCADE) + `idx_customer_tags_tag`.
- **Backend:** tag CRUD (`write/tag.go`, mirrors ingredient-category; preset color palette amber/blue/green/red/purple/gray/pink/teal validated on write; 23505→friendly dup-name); `SetCustomerTags(id, tagIds)` (tx: verify customer → DELETE → bulk INSERT ON CONFLICT DO NOTHING). **Tag hydration is BACKOFFICE-ONLY:** a new `customerObjWithTags` (correlated tags sub-select) is used ONLY by the `Customers` list + `Customer` detail reads; the shared `customerObj` is byte-unchanged so `CustomerByPhone`/`CustomerLookup`/`RecentCustomersForOutlet` (POS sync) stay tag-free. `Customers(...,tagId)` adds an EXISTS tag filter composing with q+sort+pagination. `tags` is an OPTIONAL field on `Customer`.
- **Endpoints** (gated `manage_customers`): `GET/POST /tags`, `PUT/DELETE /tags/{id}`, `PUT /customers/{id}/tags`. `tagId` query param on `listCustomers`.
- **TS client:** `listTags`, `createTag`→`{id}`, `updateTag`→void, `deleteTag`, `setCustomerTags(id,tagIds)`, `listCustomers(...,tagId)`.
- **Backoffice:** `screens/customers/tagColors.ts` (palette→chip classes), `TagManager.tsx` (create/rename/recolor/delete), CustomerDetail tag section (chips + assign/unassign + "Kelola" modal → set-the-whole-set), Customers list tag-filter dropdown + colored row chips (3 + "+N") + a `Tag` export column. (The "Segmen" half of the old placeholder is gone — segments are SP-CRM-5.)

## Review-caught (all fixed + re-verified)
go-reviewer: redundant local `setCustomerTagsBody` → use generated `api.SetCustomerTagsInput`; hardcoded `$4` → `fmt.Sprintf("$%d",len(args))`; documented the `customerObjWithTags` unaliased-FROM constraint + the SetCustomerTags FK assumption (`914fa62`). Client self-caught: `createTag`/`updateTag` typed `Promise<Tag>` but the server returns `{data:{id}}`/`{ok}` → corrected to `Promise<{id}>`/`Promise<void>` (`9ae8434`). typescript-reviewer: `ColorPicker` defined in render body (remount bug) → lifted to module scope; **rapid tag-toggle race that silently dropped changes** → `tagBusy` in-flight guard + disabled chips; palette `Record<TagColor,string>`; hoisted `cTags` (`6c943d6`).

## ✅ Authed live verification — DONE (16/16 on rev 00052-8wv)
tag create + **dup-name 400 + invalid-color 400**; rename+recolor persists; `setCustomerTags` assign → `GET /customers/{id}` includes the tag; **`?tagId` returns ONLY tagged customers**; clear → empty; **regression: `/sync/customers/lookup` + `/customers/by-phone` customers have NO `tags` field** (lean-sync invariant holds); delete tag → gone (cascade). Test tag + assignment cleaned up. Admin login email = `admin@mandalika.test`.

## ▶️ USER-PENDING — visual walkthrough
Hard-refresh `mandalika-pos.pages.dev` → Pelanggan: tag filter dropdown narrows the list; colored chips on rows; open a customer → Tag section assign/unassign chips + "Kelola" manager (create/rename/recolor/delete); the Tag export column.

---

# ⭐ PRIOR SESSION — 2026-06-08 (SP-CRM-3 Phase 1: POS On-Demand Customer Attach)

Branch `prod-hardening`. First **POS-touching** CRM sprint. Backend **rev `00050-2h5`** (migration **0027** applied; `/readyz` ok). Commits `932b04c`(spec)→`76e04de`. Built brainstorm→spec→plan→subagent-driven (go-reviewer + typescript-reviewer per batch). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-07-crm-sp3-pos-ondemand-customer-attach*`.

## What this sprint does + the two-phase rollout
Replaces the unviable global bulk customer sync (POS pulls the WHOLE customer table to every outlet) with on-demand lookup + a bounded per-outlet offline cache — rolled out **APK-first so no deployed device degrades**:
- **Phase 1 (DONE, deployed):** POS picker gains on-demand `api.lookupCustomers(q)` (online, debounced, merged with the local cache; offline → cache only); backend adds dup-detection + the bounded read, with the sync bootstrap **UNCHANGED** (still sends the full list → nothing degrades).
- **Phase 2 (DONE 2026-06-08, rev `00051-qgs`, commit `8b907b0`):** the one-line flip in `sync.go:103` `Customers(1,100000)` → `RecentCustomersForOutlet(ctx, sc.OutletID, 90, 1000)` is deployed after the user confirmed the fleet updated. The sync bootstrap now sends the bounded per-outlet recent set — the heavy-load win is live.

## Decisions (locked with user)
Connectivity varies a lot by outlet → hybrid: on-demand online + bounded offline cache. Cache = **per-outlet recent customers, 90 days / cap 1000**. Offline-miss duplicates = **accept + flag** (never auto-prevent); the merge tool is a deferred **SP-CRM-Merge** sprint (backoffice approval review queue, human-in-the-loop, never auto-merge). Rollout = APK first → confirm fleet → backend flip.

## What shipped (Phase 1)
- **Migration 0027:** `customer_dup_candidates (id, new_customer_id, existing_customer_id, phone, status DEFAULT 'pending', created_at)` + `idx_dup_candidates_status` + **unique** `idx_dup_candidates_pair (new_customer_id, existing_customer_id)` (idempotency) + `idx_orders_outlet_created (outlet_id, created_at DESC)` (supports the bounded read).
- **Backend:** dup-detection in `service.CreateCustomer` (the POS `customer_create` path) — if another customer has the same phone, record a candidate (`ON CONFLICT DO NOTHING`, `slog.Warn` on failure; best-effort, never blocks the create, keeps client-id create so the order stays consistent). New `RecentCustomersForOutlet(outletID, days, limit)` read (bounded per-outlet recent; clamps days/limit) — **built, UNWIRED** (Phase-2 seam).
- **POS (`CashierScreen.tsx`):** debounced on-demand lookup gated on `offlineData.isOnline`, merged dedup-by-id into the picker list (localCreates → snapshot cache → online hits); offline falls back to cache; offline `customer_create` unchanged. **Reaches devices only via an APK build (not yet built).**

## Review-caught (all fixed + re-verified)
go-reviewer: dup-flag wasn't idempotent (replay would double-insert) → unique index + `ON CONFLICT DO NOTHING`; silent INSERT swallow → `slog.Warn`; SELECT tiebreaker (`created_at ASC, id ASC`); clamp days/limit. Commit `13b9c8f`. typescript-reviewer: APPROVED (noted a non-bug seam — the picker re-filters lookup results client-side by name/phone, fine today since the server matches the same fields; tracked follow-up).

## ✅ Verification — DONE (12/12 on rev 00050-2h5)
9 backend DB checks via a tx-rolled-back pgx throwaway (one-time DATABASE_URL): mig-0027 table + all 3 indexes exist; `RecentCustomersForOutlet` returns a bounded 11-row set for a real outlet; dup-detection SELECT finds the same-phone customer, first candidate insert writes 1, **replay is idempotent (0)** — all rolled back, no live data touched. 3 authed checks (SEED_ADMIN_PASSWORD): `/sync/customers/lookup` 401 without token, returns ≤3 with token. Admin login email = `admin@mandalika.test`.

## ✅ Fully shipped + honest gaps (rule 6)
- **APK built + fleet updated** (run #43, `mandalika-pos-release-apk`); **Phase-2 cutover deployed** (rev `00051-qgs`) — sync now sends the bounded per-outlet set. SP-CRM-3 complete.
- **Not exercised over HTTP from here** (verified by construction + on the live DB instead): `/sync/pull` is cashier-outlet-scoped and the seed admin has no outlet (→403), so the `sync.Pull → RecentCustomersForOutlet` path wasn't hit over HTTP this session. It's a verified one-line swap to a pgx-proven bounded read; the definitive proof is a POS device resync (the fleet now does this). On the ~11-row test DB the payload-shrink isn't observable anyway — it only shows at production scale.
- The POS dup-detection Go glue wasn't exercised over HTTP (the exact SQL it runs + idempotency WAS proven via the pgx tx test); it fires for real when an offline-miss duplicate customer is created on a device.

---

# ⭐ PRIOR SESSION — 2026-06-07 (SP-CRM-2: Customer Scale Foundation)

Branch `prod-hardening`. Backend/backoffice only (no APK). Backend **rev `00049-kv7`** (migration **0026** applied; `/readyz` ok). Commits `a60836f`(spec)→`f56f982`. Built brainstorm→spec→plan→subagent-driven (go-reviewer + typescript-reviewer two-stage review per batch). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-07-crm-sp2-customer-scale-foundation*`.

## Why this sprint exists (the scale reframe)
Mid-brainstorm the user corrected a load-bearing assumption: this is a **30+ outlet brand, thousands trx/day, 50k–500k identified customers** — NOT the "few hundred" the earlier work assumed. Code check found real gaps: (1) the POS bulk-syncs the ENTIRE customer table to every outlet (`sync.go:103` `Customers(1,100000)`); (2) SP-CRM-1's list search/sort had NO supporting indexes (seq scan + full sort at scale); (3) SP-CRM-1's phone dup-check fetched 10k rows client-side. SP-CRM-2 fixes the **backend/backoffice** foundation; the POS bulk-sync removal is **SP-CRM-3** (APK + offline design). This also re-decomposed the roadmap (tags → SP-CRM-4, segments → SP-CRM-5, etc. — see the COPY-READY block).

## What SP-CRM-2 shipped
- **Migration 0026:** `CREATE EXTENSION pg_trgm` + 3 GIN trigram indexes (name/phone/email, for `ILIKE '%q%'` substring search) + sort indexes `idx_customers_spent (total_spent DESC, created_at DESC)` and `idx_customers_created (created_at DESC)`.
- **Sort toggle:** `Customers(ctx,page,limit,q,sort)` — `sort=terbaru` → `ORDER BY created_at DESC`, else `total_spent DESC, created_at DESC` (`sort` mapped to a constant ORDER BY, never interpolated). Backoffice list got a **Belanja Tertinggi / Terbaru** toggle; default belanja. `listCustomers(page,limit,q,sort)`.
- **Server-side phone dup-check:** new `GET /customers/by-phone?phone=` (manage_customers, exact via `idx_customers_phone`, **NOT cached** — freshness matters for a pre-create check — **400 on empty phone**). SP-CRM-1's 10k-row `allForDupe` fetch + the `phone.ts` helper were REMOVED; the edit-modal warning now calls `api.getCustomersByPhone` debounced (with an `ignore` flag against stale async).
- **On-demand cashier lookup (SP-CRM-3 seam):** new `GET /sync/customers/lookup?q=&limit=` (cashier authed group, ≤20 rows, exact-phone ranked first, cached — typeahead staleness OK). `api.lookupCustomers(q,limit)`. No consumer yet — intentional.
- **sync.go:** signature updated to `Customers(ctx,1,100000,"","")` — bulk payload **intentionally preserved** (removed in SP-CRM-3).

## Review-caught issues (all fixed + re-verified)
- go-reviewer: `by-phone` was cached (wrong for a dup-check) → made direct/non-cached + empty-phone 400 guard; redundant `phone = $1` OR in the lookup WHERE removed (kept in ORDER BY). Commit `bf5df11`.
- typescript-reviewer: async race in the debounced dup-check effect → added an `ignore` flag in cleanup; minor toolbar spacing. Commit `f56f982`.

## ✅ Authed live verification — DONE (14/14 on rev 00049-kv7)
sort=belanja sorted by totalSpent DESC; sort=terbaru by createdAt DESC; the two orderings differ; by-phone finds an existing customer, empty-result on no match, **400 on empty phone**; lookup returns ≤3, exact-phone ranked first, clamps to ≤20, **401 without token**; q search still matches. (Live DB already has 10+ real customers.) Admin login email = **`admin@mandalika.test`**.

## ✅ Index verification — DONE (via DATABASE_URL + pgx EXPLAIN, throwaway `cmd/explaincheck`, deleted after)
All 7 indexes exist on `customers` (the 5 from mig 0026 + pkey + phone). With `enable_seqscan=off`: order-free `name ILIKE '%…%'` → **Bitmap Index Scan on idx_customers_name_trgm**; `phone ILIKE` → **idx_customers_phone_trgm**; `ORDER BY total_spent…` → **idx_customers_spent**; `ORDER BY created_at` → **idx_customers_created**; `phone = $1` → **idx_customers_phone**. Caveat: the COMBINED search+ORDER-BY query on the tiny (~11-row) live table prefers the sort index + ILIKE filter (a small-table artifact) — at 50k–500k with a selective filter the planner picks the trigram bitmap scans, as proven by the order-free EXPLAINs.

## ▶️ USER-PENDING — frontend visual
Hard-refresh `mandalika-pos.pages.dev` → Pelanggan; confirm the **Belanja Tertinggi / Terbaru** toggle reorders the list, search still works, and entering an existing phone in the add/edit modal still shows the amber dup warning (now server-backed).

---

# ⭐ PRIOR SESSION — 2026-06-07 (SP-CRM-1: Customer Hub Foundation)

Branch `prod-hardening`. **First slice of the new CRM module.** Backend **rev `00048-f2p`** (migration **0025** applied; `/readyz` ok). Backoffice auto-deploys via Cloudflare on push (done). No APK (backoffice-only). Commits `59d9a40`(spec)→`07a81e9`. Built brainstorm→spec→plan→subagent-driven (fresh implementer per batch + go-reviewer/typescript-reviewer two-stage review each). Spec/plan: `docs/superpowers/{specs,plans}/2026-06-07-crm-sp1-customer-hub-foundation*`.

## The CRM decomposition (agreed with user)
The Customers module is being grown into a full CRM, decomposed into sequenced sub-projects (each its own spec→plan→build):
- **SP-CRM-1 — Customer hub foundation** ✅ DONE (this session)
- **SP-CRM-2 — Segments & tags** (tags table + customer_tags join; manual tags + computed auto-segments; filter by tag) — NEXT
- **SP-CRM-3 — Lifecycle, retention & interaction log** (computed new/active/at-risk/churned; dated interaction timeline; birthday/anniversary reminders; wire the existing birthday/anniversary loyalty triggers to actually fire)
- **SP-CRM-4 — Points ledger & manual adjustment** (riskiest — touches the order/earning path; last)
- *(Later)* **SP-CRM-POS** — expose chosen CRM bits to the cashier (APK + sync)
**Module-wide locked decisions:** backoffice now / POS later (data model designed POS-ready = additive nullable, since `customers` is in the POS sync payload + there's a `customer_create` offline outbox); detail surface = **full-page in-screen view swap** (the backoffice has NO router — adding one is its own sprint), mirroring the Inventori drill-in; phone uniqueness = **soft warn, no DB constraint**.

## What SP-CRM-1 shipped
- **Migration 0025** (`0025_customer_crm_fields.sql`): additive nullable `birthday DATE`, `anniversary DATE`, `notes TEXT` on `customers`.
- **Backend**: `customerObj` emits the 3 fields; `Customers(ctx,page,limit,q)` collapsed to ONE parameterized query (mirrors `Ingredients()`) with `WHERE ($3='' OR name/phone/email ILIKE '%'||$3||'%')` + **`ORDER BY total_spent DESC, created_at DESC`** (the tiebreaker is load-bearing — without it LIMIT/OFFSET produced ghost/skipped rows). Write Create/Update persist the 3 fields via `nullStr`/`nullDate`. **GOTCHA found**: `sync.go` (POS bootstrap) also calls `Customers()` — now passes `""`. OpenAPI: 3 fields on `Customer` (nullable) + `CustomerInput` (plain strings, consistent with the sibling `email` field — intentionally NOT marked nullable), `q` param on `listCustomers`; regen + `make gen-check` clean.
- **TS client**: `listCustomers(page,limit,q)` (default limit now 50) + new `getCustomer(id)`.
- **Backoffice** (`screens/Customers.tsx` + new `screens/customers/CustomerDetail.tsx` + `screens/customers/phone.ts`): server pagination (shared `<Pagination/>` 25/50/100) + 300ms debounced server search (replaces the old client-side filter); row click → full-page **Customer Detail hub** (profile incl. birthday/anniversary/notes, stats, relocated purchase history, reserved "segera" placeholders for tags/ledger/timeline, ← Kembali); edit modal gained Ulang Tahun/Hari Jadi/Catatan + a **soft non-blocking phone-dupe warning** (`isDuplicatePhone` over a full-list fetch gated on modal-open). The old per-row "Riwayat" modal was removed (history now lives in the detail page).

## Review-caught bugs (both fixed + re-verified)
1. **Unstable pagination** (go-reviewer): `total_spent DESC` with no tiebreaker → duplicated/skipped rows across pages. Fixed with `, created_at DESC` (+ collapsed to single query).
2. **Edit/Delete silently no-op from the detail view** (typescript-reviewer): the `if (selectedId) return <CustomerDetail/>` early-return rendered BEFORE the shared edit/delete `<Modal>`s, so they never mounted. Fixed by restructuring the render so all modals stay mounted outside the `selectedId` conditional; `del()` also gained try/catch + exits the detail view on success.

## ✅ Authed live verification — DONE (20/20 on rev 00048-f2p)
Scripted authed check passed all 20: create with birthday/anniversary/notes → GET round-trips all 3; update persists; `?q=` narrows by name AND phone AND email (meta.total=1); no-match → empty; pagination meta echoes page/limit; **page 2 ≠ page 1 (proves the tiebreaker)**; delete → 404. Temp customer cleaned up. **Diagnosis note for future live checks:** the deployed admin email is **`admin@mandalika.test`** (NOT `.local`); password = Secret Manager `SEED_ADMIN_PASSWORD` (24 chars, no trailing newline). The default-email 401 cost a detour — remember `.test`.

## ▶️ USER-PENDING — visual walkthrough
Hard-refresh `mandalika-pos.pages.dev` → Pelanggan. Confirm: rows-per-page dropdown + page nav; typing in search narrows server-side (debounced); click a row → full-page detail with ← Kembali, profile (birthday/anniversary/notes), stats, purchase history, and the greyed "segera" tag/ledger/timeline placeholders; **Edit and Delete work FROM the detail page** (the bug that was fixed); add/edit modal has the 3 new fields; saving a customer whose phone matches another shows the amber warning but still saves.

---

# ⭐ PRIOR SESSION — 2026-06-06 (Import/Export rollout + single-unit products + hide variant label)

Branch `prod-hardening`. **Frontend-only** (no backend change, no migration). Backend still rev `00047-5tl`. Commits `7e6d329`→`2752665`. Backoffice auto-deploys via Cloudflare on push; the **POS variant-label change (F14) needs an APK rebuild to reach devices** (NOT built this session — the workflow_dispatch was guardrail-blocked as an unrequested release; build it when ready via the documented `android-release.yml` dispatch).

## F15 — Self-describing export filenames (`2752665`)
Exports were named just `{module}` + the util's auto-appended `_YYYY-MM-DD`, so filtered exports were indistinguishable. Added `buildExportName(base, parts[])` to `lib/csvUtils.ts` (slugifies + joins non-empty parts; the export fns still append the generation date). Each filtered/scoped export now encodes its active context:
- **Transfers** (`transfer-produk` / `transfer-bahan`): status label + location name + `dari-`/`sd-` dates.
- **Error logs** (`log-error`): active source filter.
- **Orders** (`transaksi`): outlet scope + status + payment + search.
- **Reports** (`laporan-transaksi` / `laporan-shift`): outlet scope + status/payment + date range.
- **Products** (`produk`): outlet scope (the list is X-Outlet-Id scoped).
- **Opname produk** (`opname-produk`): outlet scope.
Left as-is (no active filter → module+date already differentiates): Customers, Bahan Daftar (+template), Promotions/Discount, Users, product Categories, ingredient Opname. Empty filters are omitted so an unfiltered export stays short; a filtered one gains tokens, e.g. `transfer-produk_selesai_mandalika-bsd_dari-2026-05-01_sd-2026-05-31_2026-06-06.csv`.

## F14 — Hide the single-unit variant label ("Satuan" sentinel) (`155d28e`)
- New shared helper in `@mandalika/types`: `SINGLE_UNIT_SIZE = 'Satuan'` + `variantLabel(size)` → returns `''` for the sentinel (trims). Backoffice `Products.tsx` save() uses `SINGLE_UNIT_SIZE` (no more magic string).
- `variantLabel()` applied at all **customer/transaction-facing** variant displays so a single-unit product shows NO size label: POS `Cart`, `ProductGrid` (card + variant popup), `ReceiptPreview`, `OrderHistoryPanel`, `RefundDialog`, `CashierScreen` (toast + checkout/reprint `variant:` mapping → printer already skips falsy), `receive/ReceiveTransferPanel`; backoffice `Orders.tsx` order lines, `transfers/Transfers.tsx`, `transfers/docs/SuratJalanDoc.tsx`, `transfers/ReceiveModal.tsx`.
- **Left RAW on purpose** (management/edit context must show the real stored value): the Products edit-modal Ukuran input, the product-list "Varian & Stok" badges (so they read "Satuan: 0"), and all Inventori stock/overview/opname tables. Keys/filters (`${productId}-${variantSize}`, `lineKey`, add-to-cart on `v.size`) all still use the RAW value — only display text changed.

## ✅ Live verification on the backoffice (rev backoffice bundle from `155d28e`)
Confirmed via Playwright + the user's own real data: 8 products / 6 categories now exist. **CANVAS BAG** and **KARTU GARANSI** saved as single-unit products (list shows "Satuan: 0"); CANVAS BAG edit modal round-trips with one variant, Ukuran="Satuan" (editable), SKU KEM-CAN — proves the **no-size save (F13)**. Imported products (THE ONLY ONE, UNSTOPPABLE, NO1, ONLY THE BRAVE) + auto-created categories (GIFT-SET, HAMPERS, KEMASAN) prove the **`;`-delimiter + auto-create-category import (F13/F12)** work end-to-end. The F14 label-hide on transaction surfaces is verified by build/logic; the POS side awaits an APK device test (no Satuan-product order exists yet to show the hidden label in backoffice Orders).

## F13 — Two follow-up fixes (`ce4494a`)

## F13 — Two follow-up fixes (`ce4494a`)
- **CSV import delimiter auto-detect** (`lib/csvUtils.ts`): `parseCSV` now detects the field delimiter from the header line (`,` vs `;` vs tab) instead of hardcoding `,`. Excel in comma-decimal locales (Indonesia/Europe) exports CSV with `;`, which previously imported as one giant column → "0 dibuat, 0 diperbarui". Also normalizes `\r\n`/`\r`. Benefits every importer (products, ingredients, users). Export stays `,` (canonical); round-trips fine since import auto-detects.
- **Single no-size products** (`Products.tsx` `save()`): a product can now be saved with **one variant and a blank Ukuran** (e.g. merch like a Canvas Bag) — the blank size defaults to **"Satuan"**. Previously `save()` hard-rejected any empty size. Backend `validateVariants` never required size (only SKU+unique barcode), so this was a pure frontend-guard relaxation. Multi-variant products still require a **non-empty, distinct** size per row (added a dup-size guard too). The outlet-config write now uses the normalized variant list. Form hint added for the single-variant case. NOTE: a "Satuan" variant shows as "Produk · Satuan" in POS/exports (no "Name — Name" duplication); fully hiding the label in the POS would be a separate APK-side change.

## F12 — Import/Export across the backoffice (QoL)
- **Shared `<ImportExportBar>`** (`apps/backoffice/src/components/ImportExportBar.tsx`): one toolbar for everything — Export ▾ (CSV / XLSX menu) always; Template + Import buttons only when `onImport` is passed. Handles the hidden file input + `parseCSV` + busy state + an `importMessage` line. Built on the existing `lib/csvUtils.ts` (`exportToCSV`/`exportToXLSX`/`parseCSV`).
- **Products** (`Products.tsx`): refactored toolbar onto the bar; the CSV importer now **auto-creates missing product categories** (`api.createCategory`, deduped per import) instead of dropping them. Product CSV was already consistent with the current model (Stok excluded everywhere; Barcode defaults to SKU; Jual/Aktif/Unggulan round-trip).
- **Ingredients / Bahan → Daftar** (`DaftarTab.tsx`): full **Export + Import + Template** (cols: Nama, SKU, Satuan, Kategori, Biaya Default, Catatan, Status). Import **auto-creates missing ingredient categories**, upserts by SKU→name, dedupes rows within a file, continues on per-row error (reports `{n} dibuat, {m} diperbarui, {k} dilewati, {e} gagal`). Catalog is fetched ONCE for matching (no per-row N+1). **Category auto-create on import is the agreed substitute for a separate category import/export UI** — importing products/ingredients with a new Kategori makes it appear in the Kategori tab automatically.
- **Export-only** (CSV/XLSX via the bar, fetches the FULL filtered dataset with `limit:10000`, not just the current page):
  - **Customers** (`Customers.tsx`) — Nama, Telepon, Email, Poin, Total Belanja, Jumlah Kunjungan.
  - **Promotions** (`Promotions.tsx`) — one bar whose export target switches with the active tab: **Promosi** (Nama, Tipe, Nilai, Min. Belanja, Mulai, Selesai, Aktif) / **Kode Diskon** (Kode, Tipe, Nilai, Min. Belanja, Kuota, Terpakai, Aktif).
  - **Product Transfers** (`transfers/Transfers.tsx`) + **Ingredient Transfers** (`ingredients/TransferTab.tsx`) — No, Sumber, Tujuan, Status, Dibuat (respects the active F7 filters).
  - **Product Opname** (`StockCount.tsx`) + **Ingredient Opname** (`ingredients/OpnameTab.tsx`) — Nama, Lokasi, Tipe Lokasi, Status, Tanggal Rencana, Selesai.
  - **Error logs** (`ErrorLogs.tsx`) — Sumber, Jenis, Pesan, Aksi, Outlet, Pengguna, Perangkat, Versi, Waktu (respects the source filter).
- Already had import/export before this session and left as-is: **Users** (full), **Orders/Transaksi** + **Reports** (export-only, read-only).

## ▶️ USER-PENDING — visual walkthrough
Hard-refresh `mandalika-pos.pages.dev`. Confirm: the Export ▾ (CSV/XLSX) appears on Customers, Promosi/Kode Diskon, Transfer (Produk + Bahan), Opname (Produk + Bahan), Log Error; Bahan → Daftar has Export/Import/Template; importing a product or ingredient CSV with a brand-new Kategori value auto-creates that category. (Build + tsc verified locally; no API/behavioral script run — these are client-side using existing endpoints.)

---

# ⭐ PRIOR SESSION — 2026-06-01 (Recipe/ingredient consistency: empty-version flask + deletable historical refs)

Branch `prod-hardening`. Backend **rev `00047-5tl`** (migration **0024** applied; `/readyz` ok). Commits `6ff6c03`→`4b93edd`. Builds backend-only (no frontend change — the existing UI consumes the changed endpoint responses automatically).

## F11 — Recipe/ingredient consistency fix
**Problem the user hit:** removed an ingredient from a variant's recipe (saved a new empty version) but (a) the gold "Resep" flask still showed the variant had a recipe, and (b) the ingredient still couldn't be deleted (the F10 delete-guard from the prior session, compounded by the DB FK).

**Two root causes + the coherent fix:**
1. **Gold flask** (`RecipeVariantIDs`, `read/repo.go`) returned any variant with a `recipes` row, ignoring whether the CURRENT version had ingredients. → Added `AND r.current_version_id IS NOT NULL AND EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.version_id = r.current_version_id)`. Empty current version ⇒ neutral flask.
2. **`recipe_ingredients.ingredient_id`** was `NOT NULL … ON DELETE RESTRICT` AND part of the composite PK `(version_id, ingredient_id)` — so HISTORICAL version snapshots blocked ingredient deletion forever. The frozen `name_at_save`/`unit_at_save`/`cost_at_save` snapshot columns exist precisely so history survives ingredient changes, so the FK should be `SET NULL`. **Migration 0024**: drop composite PK → surrogate `id uuid` PK; `ingredient_id` nullable + `ON DELETE SET NULL`; partial unique index `(version_id, ingredient_id) WHERE ingredient_id IS NOT NULL` (preserves live-ingredient dedup); plain `(version_id)` index (restores the lookup index the dropped PK provided).
3. **`IngredientUsage`** (the F10 delete-warning read) now joins `recipes.current_version_id = ri.version_id` → only ACTIVE recipe usage surfaces in the warning (historical refs excluded).
4. **`DeleteIngredient`** gained an authoritative current-version guard: if the ingredient is in any recipe's CURRENT version → friendly 400 "bahan masih dipakai di resep aktif — hapus dari resep dulu". Historical-only refs no longer block (FK SET NULL nulls them on delete; the snapshot columns keep old versions intact via the existing `COALESCE(ing.name, ri.name_at_save)` reads).

**Net behavior:** empty current recipe version ⇒ flask neutral + ingredient deletable; ingredient still in an active recipe ⇒ flask gold + delete blocked with a clear message.

## ✅ Authed live verification — DONE (12/12 on rev 00047-5tl)
Migration 0024 (the PK swap) applied cleanly on Neon (`/readyz` ok). Scripted authed checks all passed: flask endpoint exactly matches current-version ingredient presence across all 3 HOLY SWEET variants; an ingredient in a current recipe → usage non-empty + delete blocked ("bahan masih dipakai di resep aktif — hapus dari resep dulu"); after removal from the current version (historical-only ref) → usage empty + delete **succeeds** (SET NULL nulls the old refs, snapshot preserved). Test ingredient cleaned up; variant recipe restored.

## ▶️ USER NOTE — your specific case
HOLY SWEET 10ml ATOMIZER (the one you emptied to Versi 4) now shows a **neutral** flask, and "No-SKU One" is deletable IF it's no longer in any variant's CURRENT recipe version. If it still shows linked, open the affected variant's Resep and save a version without it first, then delete.

---

# ⭐ PRIOR SESSION — 2026-05-31 / 06-01 (Inventori restructure + Bahan tidy + global white-bg fields)

Branch `prod-hardening`. Five batches across two days. Backend **rev `00044-dhp`** (`/readyz` ok, **no migration this session**). Backoffice auto-deploys via Cloudflare on push. Plans: `docs/superpowers/plans/2026-05-31-inventory-movement-summary.md`. Commits `cc21d53`→`e406a11`.

## F4 — Pagination rows-per-page dropdown (`cc21d53`)
Shared `<Pagination/>` got `pageSize` + `onPageSizeChange` + `pageSizes` (default `[25, 50, 100]`). Wired across 6 paginated lists: product Transfers, ingredient Daftar / Transfer, both Opnames, and `ErrorLogs` (migrated off its inline footer). Each caller resets `page=1` on size change. Footer reads: `[Baris: 25 ▾] · Hal 1/4 · 87 catatan · [Sebelumnya] [Berikutnya]`.

## F5 — Inventory Movement Summary (`a8bba83`→`328ab79`)
New `GET /api/v1/inventory/movement-summary?kind=&id=&from=&to=&page=&limit=`. 8-CTE-per-movement-type aggregation in `read/repo.go` (current stock, goods-in, sold, refund/cancel, transfer in, transfer out, koreksi count, opname diff). Outlet branch full; warehouse branch drops sold+refunded CTEs and zeros those fields. New `MovementSummary.tsx` rendered as a "Pergerakan" sub-tab in Stok Produk: location picker + Dari/Sampai date pickers (default last 30d) + paginated table (25/50/100). Bundles excluded; refund timestamp = `COALESCE(refunded_at, created_at)`; date range half-open `[from, to)`. **9/9 authed checks passed.**

## F6 — Outlet/Gudang CRUD moves to Settings; Overview becomes primary (`63af60d`)
- **Settings → Outlet & Gudang** (new section, placed first): hosts ALL outlet + warehouse CRUD — Tambah Outlet (Edit / Toggle aktif-nonaktif), Tambah Gudang (Edit / Hapus). Pure CRUD; no stock affordances. Reuses the existing `OutletFormModal` / `WarehouseFormModal`. `refreshOutlets()` still wired on outlet save/toggle so the topbar switcher stays in sync.
- **Stok Produk** lost its Lokasi sub-tab. Now just **Overview · Pergerakan**, defaulting to Overview. `StokProduk.tsx` slimmed from 413 → 30 lines.
- **OverviewMatrix** rewritten self-contained:
  - Owns its drill-in state — clicking a location column header opens `LocationStockView` for that location (Barang Masuk + Koreksi + PAR). No more separate Lokasi list as a pre-step.
  - **Location-type toggle** `[Outlet | Gudang | Semua]` (default Outlet) to cut the column count on multi-location deployments.
  - **Product search** input (filters productName / sku / variantSize substring).
  - **Row pagination** using the F4 `<Pagination/>` with 25/50/100 dropdown — client-side after the search/type filters apply.
  - **Sticky first column (Varian) + sticky Total column** with left border so they remain visible while horizontally scrolling.

## F7 — Transfer list filters: status, date range, location (`a17ed6d`)
Backend: `read/repo.go` `Transfers()` and `IngredientTransfers()` accept `from`, `to`, `locKind`, `locID` query params. Location filter matches "any side" — `(t.source_outlet_id = $X OR t.dest_outlet_id = $X)` for outlets, same shape for warehouses. Handlers validate `locKind ∈ {outlet, warehouse, ''}`. OpenAPI updated, regen + TS client signatures switched to opts bag. **Gotcha:** the URL param name is `locID` (capital), the TS client opt is `locId` — the impl maps `locId` → `locID` in the query string (`client.ts:468`). Anyone hand-curling the API directly must use `locID`.
Frontend: both `Transfers.tsx` and `ingredients/TransferTab.tsx` render the same compact filter row above the table — Status dropdown, Lokasi picker (Outlet/Gudang optgroups), Dari/Sampai date inputs. Page resets on any filter change.

## F8 — Bahan Overview matrix (`e406a11`)
New `GET /api/v1/inventory/ingredient-overview` mirroring `getInventoryOverview` but for ingredients. Outlets first, all active ingredients as rows, `qty` is fractional (numeric). Reuses the generic `InventoryOverviewLocation` schema. No `belowPar` (ingredients have no PAR). Schemas use `number` which oapi-codegen maps to `float32` in Go — fine for typical qtys (precision ~7 sig digits); flag for review only if someone needs very high-precision ingredient totals.
Frontend `IngredientOverviewMatrix.tsx` mirrors the post-F6 product Overview exactly: location-type toggle, search (ingredientName / sku), row pagination 25/50/100, sticky Bahan + Total columns, click column header → drills into `IngredientLocationStockView` for Barang Masuk + Koreksi at that location. Wired into Bahan tab as the **new first sub-tab** "Overview" (order: Overview / Daftar / Stok / Stok Masuk / Penyesuaian / Transfer; default Overview).

## ✅ Authed live API verification — DONE (14/14 on rev 00044-dhp)
F7: status filter returns only completed, 2020 date range returns empty, location filter actually narrows to source-OR-dest matches (sample dest=Mandalika BSD), bad locKind → 400, ingredient transfers symmetric. F8: ingredient overview returns `{locations, rows}` envelope, outlets-first (sample first = Mandalika BSD), row has expected keys, cells have NO `belowPar`, `row.total === sum(cells.qty)` within 0.001 tolerance, auth gate → 401.

## F9 — Bahan tidy + global white-bg fields + category delete (`7701fd4`)
- **Bahan tab tidy**: removed the **Stok** sub-tab (Overview already covers it via column-header drill-in). Bahan tabs are now: Overview / Daftar / Stok Masuk / Penyesuaian / Transfer (default Overview). `StokTab.tsx` is now orphaned — left in place out of scope.
- **Ingredient category delete UI** finally wired up (backend `deleteIngredientCategory` had existed all along but had no caller). Extracted `apps/backoffice/src/screens/ingredients/CategoryManager.tsx`. Inside `IngredientFormModal`, a "Kelola kategori" toggle expands the existing categories with hover-reveal trash icons; clicking opens an inline confirm panel ("Bahan yang memakai kategori ini tetap ada — FK SET NULL"). Deletes refetch the list and clear the selected category if it was the deleted one.
- **Global white-bg inputs**: `apps/backoffice/src/ui/Field.tsx` `fieldClass` changed from `bg-gray-50` → `bg-white`. Single-token edit affects every `<Input>`/`<Select>`/`<Textarea>` site-wide. Filter/search bars now read as clearly interactive against the cream theme; modal forms (already on white card backgrounds) remain visible via `border-gray-200`.

## F10 — Ingredient delete + linked-recipe warning + Daftar search fix (`3208d09`, `bf2f362`)
- **Daftar search bar** had a hardcoded `bg-gray-50` className (missed by the F9 global change) — now uses the shared `fieldClass` (white). 
- **Delete ingredient** finally wired in the Daftar list: a Trash2 button per row → `DeleteIngredientModal` (new component). On open it calls the **new** `GET /api/v1/ingredients/{id}/usage` (recipes-gated) which returns the product variants whose recipes reference the ingredient (across ALL recipe versions, matching the `ON DELETE RESTRICT` FK). If linked → amber warning + variant list + **Hapus disabled** ("hapus dari resep dulu"). If unlinked → normal confirm + enabled red Hapus → `deleteIngredient`.
- **Backend FK safety net**: `DeleteIngredient` now maps pg `23503` to a friendly Indonesian message ("bahan masih dipakai di resep produk — hapus dari resep dulu") in case of a race.
- **Gotcha fixed (`bf2f362`)**: `IngredientUsage` originally returned a nil Go slice → JSON `null` for unused ingredients; now initialized to `[]`. (Frontend was already defensive with `resp.variants ?? []`, so no crash — but the contract is now correct.)
- **Verified 7/7 on rev 00045-jfx → bf2f362 deploy**: create temp ingredient → usage `[]` → delete 200; a recipe-linked ingredient (No-SKU One, used in 2 HOLY SWEET variants) → delete blocked 400 with the friendly message.

## ▶️ USER-PENDING — visual UI walkthrough on the live backoffice
Hard-refresh `mandalika-pos.pages.dev` (Cloudflare deploying frontend) and confirm:
0. **Bahan → Daftar**: search bar is white (not cream); each row has a delete (trash) button; deleting an ingredient used in a recipe shows the amber warning + disabled Hapus; deleting an unused ingredient works.
1. **Pengaturan → Outlet & Gudang** (new first section): outlet Tambah/Edit/Toggle + warehouse Tambah/Edit/Hapus; no stock affordances.
2. **Inventori → Stok Produk** has only Overview + Pergerakan; clicking a location column header in Overview drills into that location's stock view; the type toggle + search + pagination + sticky Total column all work on a many-location matrix.
3. **Inventori → Transfer** filter row (Status / Lokasi / Dari / Sampai) narrows the list. Same in **Bahan → Transfer**.
4. **Bahan → Overview** (new first sub-tab) renders the ingredient × location matrix; outlets-first; sticky Bahan + Total; clicking a location header opens that location's ingredient stock view.
5. **Bahan tab** has no Stok sub-tab; Overview / Daftar / Stok Masuk / Penyesuaian / Transfer only.
6. **Bahan → Daftar → Tambah/Edit Bahan modal**: under the Kategori dropdown, the "Kelola kategori" link expands a list of categories with delete trash icons (with inline confirm).
7. **Every search + filter bar** (Transfer filters, Movement Summary, Daftar search, etc.) renders on **white** background, clearly interactive against the cream page bg.

---

# ⭐ PRIOR SESSION — 2026-05-31 (Pagination dropdown + Movement Summary report)

Branch `prod-hardening`. Two follow-ups on the Inventori work: every paginated list got a rows-per-page dropdown, and Inventori → Stok Produk gained a new **Pergerakan** (Movement) sub-tab — per-location, date-range product movement summary. Backend **rev `00042-247`** (`/readyz` ok, **no migration**). Backoffice auto-deploys via Cloudflare. Commits `cc21d53`→`328ab79`. Plan: `docs/superpowers/plans/2026-05-31-inventory-movement-summary.md`.

## F4 — Pagination rows-per-page dropdown (`cc21d53`)
- Extended the shared `<Pagination/>` UI helper with `pageSize`+`onPageSizeChange`+`pageSizes` props (default `[25, 50, 100]`). Footer now reads: `[Baris: 25 ▾] · Hal 1/4 · 87 catatan · [Sebelumnya] [Berikutnya]`.
- Wired the dropdown into ALL 6 paginated screens: product Transfers, ingredient Daftar, ingredient Transfers, product Stock Counts, ingredient Stock Counts, plus `ErrorLogs` (which was migrated off its inline footer onto the shared helper). Each caller resets `page` to 1 on size change.

## F5 — Inventory Movement Summary (`a8bba83`→`328ab79`)
- **Backend** (`2b619eb`): new `MovementSummary(ctx, kind, id, from, to, page, limit)` read in `read/repo.go` using an 8-CTE-per-movement-type pattern (current stock, goods-in, sold, refund/cancel, transfer in, transfer out, koreksi count, opname diff). Outlet and warehouse get separate SQL strings (warehouse branch drops the `sold`/`refunded` CTEs and hardcodes them to 0). Pagination via `COUNT(*) OVER ()` mirror of `IngredientTransfers`. New endpoint `GET /api/v1/inventory/movement-summary?kind=&id=&from=&to=&page=&limit=` gated `manage_inventory`. New `MovementSummaryRow` + `MovementSummaryResponse` schemas + TS client `getMovementSummary`.
- **Frontend** (`328ab79`): new `apps/backoffice/src/screens/inventory/MovementSummary.tsx` rendering a header (location picker with Outlet/Gudang optgroups, Dari/Sampai date pickers defaulted to last-30-days) + a wide table with columns **Produk · Ukuran · SKU · Stok Saat Ini · Stok Masuk · Terjual · Refund/Batal · Transfer Masuk · Transfer Keluar · Koreksi · Selisih Opname**. Warehouses render `—` in Terjual + Refund/Batal. Pagination uses the F4-upgraded helper (with 25/50/100 dropdown). Wired into `StokProduk.tsx` as a third sub-tab "Pergerakan" alongside Lokasi + Overview.
- **Locked behaviors:** bundles (`oi.is_bundle=true`) EXCLUDED from sold/refund counts; refund timestamp = `COALESCE(refunded_at, created_at)` because `orders` has no `cancelled_at`; date range is half-open `[from, to)`.

## ✅ Authed live API verification — DONE (9/9 on rev 00042-247)
The verification script tested the new endpoint: noauth→401, missing params→400, outlet summary returns the full 12-column envelope with correct `meta.total`, warehouse correctly returns 0 in `sold`/`refunded` for every row, pagination meta echoes `page=2, limit=5`. Read-only — no mutations to restore.

## ▶️ USER-PENDING — visual UI walkthrough on the live backoffice
Hard-refresh `mandalika-pos.pages.dev` and confirm:
1. Every paginated list shows the **Baris: 25 ▾** dropdown next to "Hal X/Y" (try Transfers, Bahan Daftar / Transfer, both Opnames, Error Log). Changing the size resets to page 1.
2. **Inventori → Stok Produk → Pergerakan** (new third sub-tab): pick a location, set a date range, see per-variant movement table. Switch between outlet and warehouse — warehouse should show "—" for Terjual + Refund/Batal. Pagination behaves correctly with the new dropdown.

---

# ⭐ PRIOR SESSION — 2026-05-30 (Inventori polish + Ingredient Stock at Outlets)

Branch `prod-hardening`. Three follow-up batches on top of the previous day's Inventori work, all built subagent-driven (Go + TS reviews each phase, fixes applied). Backend **rev `00041-l6h`** (migration **0023** applied; `/readyz` ok). Backoffice auto-deploys via Cloudflare on push. POS untouched. Commits `08d0956`→`8a1f398`. Plan: `docs/superpowers/plans/2026-05-30-ingredient-stock-at-outlets.md`.

## F1 — Outlet management moved into Inventori (`08d0956`, `9da846b`)
- Removed the standalone **Outlet** top-level sidenav. Outlet CRUD now lives in **Inventori → Stok Produk → Lokasi → Outlet section** (Tambah Outlet + per-row Edit + Toggle aktif/nonaktif). `screens/Outlets.tsx` deleted; `screens/inventory/OutletFormModal.tsx` extracted. `useOutlet().refreshOutlets()` is called on both save and toggle so the topbar outlet switcher stays in sync.
- Lokasi list rows became info-rich cards: per-location `{N} varian · {N} unit` summary, with a red "{N} stok rendah" badge on outlets that have variants below their PAR. Summary computed in ONE pass from `getInventoryOverview()` and memoized. Inactive locations dimmed + "Nonaktif" badge. Subtle hover state.
- TS review found + fixed: `toggleOutlet` floating promise (now try/catch with user-visible error); summary map memoized.

## F2 — Lokasi side-by-side, list pagination, Opname restructure (`30b444f`)
- Stok Produk's Outlet + Gudang sections now sit **side-by-side** on `lg:` screens (grid-cols-1 lg:grid-cols-2), stacked on small.
- Extracted a reusable `<Pagination/>` UI helper (`apps/backoffice/src/ui/Pagination.tsx`) from the existing ErrorLogs pattern (`Hal X/Y` footer + Prev/Next). PAGE_SIZE=25 wired into **5 lists**: product Transfers, ingredient Daftar, ingredient Transfers, product Stock Counts, ingredient Stock Counts.
- **Opname** tab restructured: now has **Produk / Bahan** sub-tabs (Bahan only when `recipesEnabled`). `OpnameSection.tsx` wrapper renders `<StockCount/>` or `<OpnameTab/>` based on sub-tab. The standalone Opname sub-tab inside Bahan was removed (Bahan now has Daftar/Stok/Stok Masuk/Penyesuaian/Transfer only).

## F3 — Ingredient Stock at Outlets (`5f0c3c3`→`8a1f398`)
- **Migration 0023:** new `ingredient_outlet_stock(outlet_id, ingredient_id, qty numeric(14,3))` table + polymorphic `outlet_id`/`warehouse_id` columns (with `num_nonnulls=1` CHECKs) on `ingredient_goods_receipts`, `ingredient_stock_adjustments`, `ingredient_transfers` (mesh: source+dest each polymorphic), and `ingredient_stock_counts`. Mirrors migration 0022 for products.
- **Backend:** ingredient goods-in + koreksi rewritten location-polymorphic (`CreateIngredientGoodsReceipt`/`AdjustIngredientStock` take `LocKind`+`LocID`); transfer logic rewritten as a mesh (mirror `transfer.go`); stock-count polymorphic (mirror `stockcount.go`); new `IngredientLocationStock` read; new endpoints `POST /inventory/ingredient-goods-receipt` / `POST /inventory/ingredient-adjust` / `GET /inventory/ingredient-location-stock` (gated `manage_inventory`); old `/ingredients/{id}/goods-receipt` + `/ingredient-adjust` + `/ingredients/{id}/stock` REMOVED. **CRITICAL invariant:** ingredients are NOT POS-synced, so NO `content_version` bump anywhere in the ingredient write path (different from product inventory). Pure validators table-tested.
- **Go review found + fixed:** nil-deref guards in `addIngStockDelta` + `CompleteIngredientStockCount` outlet branch (convert corrupt-row case from panic to error); `IngredientTransfer` single-record query had a dead `WITH s AS (... LIMIT 1)` CTE shadowed by a re-joined `app_settings` table — restored CTE reference (`LEFT JOIN s ON true`) to prevent fan-out if `app_settings` ever has more than one row.
- **Backoffice:** `Bahan → Stok` rewritten location-first (mirrors Stok Produk): outlet + gudang sections, drill into either → `IngredientLocationStockView` with Barang Masuk + Koreksi. Ingredient modals generalized to `location: {kind,id,name}` (optional — modal shows its own location picker when omitted, used by the global Stok Masuk / Penyesuaian history views). `IngredientTransferForm` source/dest pickers now span outlets + warehouses with kind tags. `OpnameTab` (under Inventori→Opname→Bahan) location picker extended to outlets too. History views + `IngredientReceiveModal` + `IngredientSuratJalanDoc` updated for polymorphic `source.name`/`dest.name`.

## ✅ Authed live API verification — DONE (13/13 on rev 00041-l6h)
The verification script logged in, exercised the new ingredient endpoints, and restored all mutations to baseline. **13/13 passed** incl. the load-bearing ones: outlet ingredient goods-in (+5), outlet koreksi (absolute set), no-reason→400, negative→400, warehouse goods-in via the new endpoint (+10), **mesh transfer warehouse→outlet** (create→send→receive: warehouse -2, outlet +2 — proves all four polymorphic legs deduct/credit correctly), old `/ingredients/{id}/goods-receipt` returns 404. Final stocks restored to 0 / 0.

## ▶️ USER-PENDING — visual UI walkthrough on the live backoffice
The API behavior is fully proven; what remains is eyes on the new UI. Hard-refresh `mandalika-pos.pages.dev` and confirm:
1. Sidenav no longer has "Outlet" (consolidated into Inventori).
2. **Stok Produk → Lokasi** side-by-side (Outlet + Gudang columns), each row has the variant/unit summary + low-stock badge for outlets; Tambah/Edit/Toggle for outlets, Tambah/Edit/Hapus for warehouses.
3. **Bahan → Stok** is now location-first (Outlet + Gudang); drill into either → ingredient list with Barang Masuk + Koreksi.
4. **Bahan → Transfer** form allows source/dest = any outlet or warehouse (mesh); creating + sending + receiving a warehouse→outlet transfer works end-to-end.
5. **Inventori → Opname → Bahan** lets you create an ingredient opname targeting an outlet (not just warehouses).
6. Pagination (25/page) on Transfers, Daftar, Bahan Transfer, both Opname lists.

---

# ⭐ PRIOR SESSION — 2026-05-29 (Inventory Stock Consolidation → "Inventori" module)

Branch `prod-hardening`. Shipped **Inventory Stock Consolidation**: all product stock (outlets + warehouses) is now managed in one renamed **Inventori** module; stock no longer lives in the Product module. Built **subagent-driven** (fresh implementer per task + go-reviewer on backend, typescript-reviewer on frontend). Backend **rev `00040-fgk`** (migration **0022** applied; `/readyz` ok). Backoffice auto-deploys via Cloudflare on push. **No APK** (backoffice-only; POS untouched except it resyncs outlet stock via the existing content_version path). Spec/plan: `docs/superpowers/{specs,plans}/2026-05-29-inventory-stock-consolidation*`. Commits `7b34f48`→`fa5b159`.

## What shipped
- **Migration 0022**: `goods_receipts` + `warehouse_stock_adjustments` made **location-polymorphic** (nullable `outlet_id` added, `warehouse_id` made nullable, CHECK `num_nonnulls(outlet_id,warehouse_id)=1`) — mirrors the `stock_counts` pattern (mig 0015). Existing rows valid (warehouse_id set).
- **Backend** (`write/warehouse.go`, `write/stock_logic.go`, `read/repo.go`, `handlers/writes.go`, `server/server.go`): location-polymorphic **`CreateLocationGoodsReceipt`** + **`AdjustLocationStock`** + **`SetOutletPar`** keyed by `{kind:"outlet"|"warehouse", id}`. **CRITICAL invariant:** OUTLET stock writes bump that outlet's `content_version` under "products" (via new `bumpOutletTx`) so the POS resyncs; WAREHOUSE writes use `noBumpTx` (not POS-synced). Outlet upserts touch ONLY `stock` (preserve `available`+`par_level`); PAR upsert touches ONLY `par_level`. New read **`InventoryOverview`** (variant×location matrix, outlets-first, per-row total, per-outlet-cell `belowPar`). Pure validators unit-tested (`validateGoodsReceipt`/`validateLocationAdjust`).
- **New endpoints** (gated `manage_inventory`): `POST /api/v1/inventory/goods-receipt?kind=&id=`, `POST /api/v1/inventory/adjust?kind=&id=`, `PUT /api/v1/inventory/outlet-par?id=`, `GET /api/v1/inventory/overview`. **REMOVED** the superseded warehouse-only `POST /api/v1/warehouses/{id}/goods-receipt` + `/adjust` (kept `/stock`). **`getInventoryOverview` returns a BARE `{locations,rows}`** (no `data` envelope → TS client uses raw `request<T>`, like the gold-tint endpoint).
- **Decoupled product outlet-config write** (`SetProductOutletConfig`): now writes ONLY per-outlet **price + availability** (`OutletConfigItemInput` = `{outletId,variantSize,price?,available}`); it NEVER touches `outlet_variant_stock.stock`/`par_level`. The READ (`getProductOutletConfig`→`OutletVariantConfig`) still returns stock/parLevel (modal ignores them). **GOTCHA:** the new backend tolerates extra fields, so an old frontend sending `stock` is safely ignored — this is why backend was deployed BEFORE the frontend push.
- **Backoffice**: `Gudang` → **`Inventori`** (`apps/backoffice/src/screens/Warehouses.tsx` is the shell). Tabs: **Stok Produk · Transfer · Bahan · Opname**. The standalone "Stock Count" top-level nav item was REMOVED and folded in as the **Opname** tab. Nav perm gate: Inventori shows if user has `manage_inventory` **OR** `manage_stock_count`; tabs gated individually (Stok Produk/Transfer = manage_inventory, Bahan = +recipesEnabled, Opname = manage_stock_count) with first-visible-tab default.
  - **Stok Produk → Lokasi** (`screens/inventory/StokProduk.tsx` + `LocationStockView.tsx`): grouped location list (Outlet / Gudang) → drill into a location → its stock table with **Barang Masuk** + **Koreksi** (the generalized `warehouses/GoodsInModal.tsx`+`AdjustModal.tsx`, now take a `location:{kind,id,name}` prop). **PAR** is an inline editable field shown ONLY for outlets (`setOutletPar`). **Warehouse CRUD preserved**: moved into the Gudang section (`WarehouseFormModal.tsx` + Tambah/Edit/Hapus). Outlets are still managed in the separate "Outlet" screen (read-only here).
  - **Stok Produk → Overview** (`OverviewMatrix.tsx`): read-only variant×location matrix; `belowPar` cells red; click a location header → drill into its Lokasi view.
  - **Product modal** (`Products.tsx`): per-outlet matrix slimmed to **Harga + Jual** ("Harga & Ketersediaan per Outlet"); Stok + PAR columns removed; the create-time base Stok input removed (base `product_variants.stock` kept at 0, vestigial); CSV export/template/import dropped the `Stok` column.

## ✅ Authed live API verification — DONE (user authorized one-time secret fetch; 18/18 passed on rev 00040-fgk)
An authed script exercised the live endpoints and **restored all mutations** afterward. **18/18 passed**, incl. the load-bearing ones: outlet goods-in (+7) + koreksi (absolute set); koreksi/PAR preserve the other columns (column isolation); no-reason→400 + negative→400; PAR set leaves stock untouched; overview is outlets-first with `total==sum(cells)` + correct `belowPar`; warehouse goods-in via the new `/inventory/*` endpoint; **product outlet-config save does NOT change stock or PAR** (the decouple invariant); old `/warehouses/{id}/goods-receipt` → 404. (Test fixture: HOLY SWEET 10ml ATOMIZER @ Mandalika BSD — left at baseline stock 59.)

## ▶️ USER-PENDING — only visual + on-device checks remain (API behavior already proven)
Verify on the live site (admin login, hard-refresh `mandalika-pos.pages.dev`):
1. Nav shows **Inventori** (no standalone "Stock Count"); tabs Stok Produk/Transfer/Bahan/Opname.
2. Stok Produk → Lokasi: outlets+warehouses grouped; drill into an **outlet** → Barang Masuk adds stock, Koreksi sets absolute+reason, **PAR** inline edit persists (outlets only), low-stock row red. Drill into a **warehouse** → same minus PAR. **Tambah/Edit/Hapus Gudang** still work.
3. Stok Produk → Overview: matrix totals correct, below-PAR cells red, click a location header drills in.
4. Produk → Edit: matrix shows only Harga + Jual (no Stok/PAR); create form has no Stok field; saving a product does NOT change stock (the load-bearing check).
5. **POS sync regression (load-bearing):** change an outlet's stock via Inventori Koreksi → on the POS (after sync) the cashier sees the new on-hand (proves the content_version bump).
6. Permission: a `manage_stock_count`-only user reaches Inventori and lands on Opname; Stok Produk/Transfer hidden for them.

## Optional follow-ups (typescript-reviewer minors, non-blocking)
- Extract the duplicated `LocationTarget {kind,id,name}` interface (in StokProduk/LocationStockView/OverviewMatrix) to a shared `screens/inventory/types.ts`.
- Products.tsx list column header still reads "Varian & Stok" + per-row `{size}: {stock}` badge (server aggregate) — consider relabeling now that stock is managed in Inventori.
- `StokProduk` delete-warehouse confirm button has no busy/disabled guard (rapid double-click could double-submit).

---

# ⭐ PRIOR SESSION — 2026-05-29 (Recipe gold-tint indicator + POS transfer-history/reprints)

Branch `prod-hardening`. Two follow-up features shipped, both **subagent-driven** (fresh implementer per task + live/controller verify). Backend **rev `00038-85j`** (`/readyz` ok; **no new migration** — both use read-only queries over existing tables). Commits `1af3cb0`→`eef564e`, pushed. Specs/plans: `docs/superpowers/{specs,plans}/2026-05-29-recipe-variant-indicator*` + `2026-05-29-pos-transfer-history-reprints*`.

## 1) Recipe gold-tint indicator (backoffice) — DONE & UI-VERIFIED LIVE
The Resep flask in the product edit modal is now **gold-tinted** on variants that already have a recipe (was the SP-Recipe-2 deferred ●/filled cut). New endpoint `GET /api/v1/products/{productId}/recipe-variant-ids` (gated `manage_inventory` + `recipes_enabled`) returns the variant ids with a recipe; `Products.tsx` fetches the set on modal-open and re-fetches on slide-over close. **GOTCHA:** this endpoint returns a **BARE** `{variantIds:[]}` (handler `writeJSON(... api.RecipeVariantIdsResponse{...})`, no `{data}` envelope) — so its TS client method uses the raw `request` helper, NOT `data<T>` (which unwraps `.data`). Verified live: HOLY SWEET shows 2 gold "Resep tersedia" + 1 neutral "Belum ada resep", matching the endpoint. Screenshot `recipe-gold-tint.png`.

## 2) POS transfer-history + reprints — CODE COMPLETE; APK built; ON-DEVICE VERIFY USER-PENDING
Bundled (one APK): **APK run 26623193405 success → artifact `mandalika-pos-release-apk`**.
- **Hamburger combined dot** (`CashierScreen.tsx`): the header menu dot now lights when `pendingCount > 0` **OR** an inbound transfer awaits receipt (`inbound.length > 0`).
- **Outlet transfer history**: new cashier-scoped `GET /api/v1/sync/outlet-transfers?status=completed|cancelled` (`read.OutletTransferHistory` — `WHERE (source_outlet_id=$1 OR dest_outlet_id=$1) AND status=$2`, i.e. incoming + outgoing; handler scopes to JWT outletId, mirrors `GetInboundTransfers`; route in the cashier `sync` group). New `apps/pos/src/cashier/TransferHistoryPanel.tsx` (tabs **Selesai/Dibatalkan** + detail) reached via a new **"Riwayat Transfer"** MenuDrawer item; completed rows offer **"Cetak Ulang Tanda Terima"**. Endpoint live-verified (per-outlet scoping: BSD=2/PMS=3 completed; bad status → 400; DTO hydrates source/dest/items).
- **Order-history receipt reprint** (`OrderHistoryPanel.tsx`): **"Cetak Ulang"** in the order detail reprints the sales receipt, reusing the checkout `ReceiptData` mapping (`Order` list carries full data; customer phone not stored → omitted on reprint). Currently shown for orders of ANY status.
- **Shared REPRINT marker** (`@mandalika/printer` `escpos.ts`): `buildReceipt`/`buildTandaTerima` gained an optional `reprint` param → stamps a centered bold `*** CETAK ULANG (REPRINT) ***` at **top AND bottom**; threaded via `print.ts` `PrintJob`/`TandaTerimaJob.reprint`. The POS `printer.tsx` wrapper (`print(...)` and `printTandaTerima(...)`) was extended with a `reprint` passthrough. Only history-triggered reprints set it; original prints (checkout, auto post-receive prompt) stay unmarked. Vitest 7/7 (marker present×2 when reprint, absent by default).

### ▶️ USER-PENDING (this session)
1. **Install APK `mandalika-pos-release-apk`** (run 26623193405) + pair a BLE printer, then verify on device: (a) hamburger dot lights on an inbound transfer; (b) Menu → Riwayat Transfer tabs + detail; (c) "Cetak Ulang Tanda Terima" and order "Cetak Ulang" print with the REPRINT marker top+bottom; (d) original checkout receipt + auto post-receive tanda terima print WITHOUT the marker.
2. Decide whether order "Cetak Ulang" should be restricted (e.g. hide on refunded orders) and whether to include the customer phone (not currently stored on the order).

---

# ⭐ PRIOR SESSION — 2026-05-28 (SP-Recipe-2 + UI redesign + Neon fix) — kept for context

Branch `prod-hardening`. Shipped **SP-Recipe-2 (Recipes & Versioning)** end-to-end, a recipe-editor **UI clarity redesign**, and a **Neon connection-pool hardening** fix. Backend **rev `00036-kqm`** (migration 0021 applied; `/readyz` ok — SP-Recipe-2 deployed at `00035-68t`, then the pgxpool-fix redeploy `00036-kqm`). Backoffice auto-deploys via Cloudflare. **No APK** (backoffice-only). Commits `cbb18af`→`fdc8fc0`, pushed. Built **subagent-driven** (fresh implementer per task + reviews/live-verify).

## SP-Recipe-2 — Recipes & Versioning: CODE COMPLETE & deployed
Spec `docs/superpowers/specs/2026-05-28-recipe-sp2-recipes-versioning-design.md` · plan `docs/superpowers/plans/2026-05-28-recipe-sp2-recipes-versioning.md` (phases A–E, 15 tasks).
- **Migration 0021**: `recipes` (`variant_id` UNIQUE → product_variants ON DELETE CASCADE; `current_version_id` is a write-maintained pointer, intentionally NOT a hard FK — avoids a circular create-order dep on first save), `recipe_versions` (append-only, `version_no`, `total_cost_cached`), `recipe_ingredients` (frozen snapshot `name/unit/cost_at_save`, `qty` CHECK>0, FK → ingredients ON DELETE RESTRICT).
- **Backend**: `write/recipe.go` — `SaveRecipe` + `RestoreRecipeVersion` + pure helpers (`versionMatches`/`computeTotalCost`/`newlyAddedInactive`, unit-tested). Optimistic lock via `expectedCurrentVersionId` → **409** on mismatch; snapshot uses TODAY's ingredient cost (restore recomputes); inactive ingredient = warn-but-allow existing / block-new-add → 400; zero-line save clears the recipe. pgx conn-busy discipline (drain reads before writes). Read `read/repo.go`: `VariantRecipe`/`RecipeVersions`/`RecipeVersion` hydrate current name/cost + `onHandTotal` (sum across warehouses); 404 when no recipe. 5 handlers + routes under `/api/v1/products/{productId}/variants/{variantId}/recipe*`, gated `manage_inventory` + `recipes_enabled`.
- **OpenAPI/TS**: 8 schemas + 5 ops; `@mandalika/api` methods `getVariantRecipe`(→null on 404)/`listRecipeVersions`/`getRecipeVersion`/`saveVariantRecipe`/`restoreRecipeVersion`.
- **Backoffice** `apps/backoffice/src/screens/recipes/`: `useRecipe` hook, `RecipeIngredientPicker`, `VersionHistoryDropdown`, `RecipeSlideOver`; **Resep flask button per SAVED variant row** in the Products edit modal (disabled on unsaved variants → "Simpan produk dulu"), flag-gated via `getAppSettings().recipesEnabled`. POS untouched.
- **Live-verified via API (rev 00035-68t)**: 404 → v1 (`totalCost=500000`) → v2 → 409 (stale version) → restore (recomputes at today's cost) → inactive-add 400 → empty-clear 201; version list shows author. Go unit tests green.
- **USER-VERIFIED UI**: Resep flask shows + opens; save/persist; version dropdown + restore flow exactly as designed; Settings ON/OFF hides both the flask and the Gudang **Bahan** tab. ✓
- **MVP cuts (deferred)**: no production/auto-deduct; no recipe-exists ●/filled button indicator; stock hint only on server-loaded lines (not freshly-added); no per-warehouse stock breakdown.

## SP-Recipe-2 recipe-editor UI clarity redesign (after user hands-on test)
Spec `docs/superpowers/specs/2026-05-28-recipe-sp2-ui-redesign-design.md`. Commits `cfd0cb2`(spec) → `8160e6e`(impl) → `69589e7`(picker-width fix). Behavior unchanged; clarity only:
- Add-ingredient is now a dashed gold **"+ Tambah Bahan"** button → reveals the picker (collapse via **Tutup** / Escape; stays open after a pick for rapid multi-add).
- Column headers **Bahan / Jumlah / Satuan**; calm gray **"stok gudang N {unit}"** subtitle (escalates to amber ⚠ only when on-hand < the line's qty); the **nonaktif** badge stays prominent.
- Footer cost row always renders: a Rupiah value, or **"belum tersedia ⓘ"** (title tooltip: "Ada bahan tanpa biaya satuan…").
- **Picker-width bug fixed** (`69589e7`): `fieldClass` (in `apps/backoffice/src/ui/Field.tsx`) bakes in `w-full`, which collided with `flex-1`/`w-32` siblings in a flex row → the search input collapsed to a sliver and clipped typed text. Now a full-width search bar (Search icon + "Cari bahan (nama / SKU)…") on its own row, category filter below, results in-flow. **GOTCHA: never combine `fieldClass` with `flex-1`/`w-*` in a flex row — it already sets `w-full`.**

## Neon connection-pool hardening (`fdc8fc0`)
`backend/internal/db/db.go` `Connect()` now uses `pgxpool.ParseConfig` + `NewWithConfig` with `MaxConnIdleTime=1m`, `MaxConnLifetime=30m` (+5m jitter), `HealthCheckPeriod=30s`. **WHY:** Neon free-tier silently drops idle connections, so a stale pooled conn made the FIRST write after idle fail — surfaced as intermittent **400s** during SP-Recipe-2 live verify (a tx-step connection error wraps to 400 via `h.created`). Retiring idle/old conns before Neon does eliminates the stale-conn handoff with zero per-request overhead. If transients ever persist, the next lever is a `BeforeAcquire` ping (adds acquire-time latency). Memory: `neon-stale-connection-transient`. **App-wide fix — not recipe-specific.**

## ▶️ USER-PENDING (this session)
1. Re-confirm the **redesigned** recipe slide-over visually after login: full-width search bar; "+ Tambah Bahan" reveal; column headers; calm gray stock hint; cost "belum tersedia ⓘ". **NOTE: `recipes_enabled` is currently OFF** (toggled off during the ON/OFF test) — flip Settings → "Resep & Bahan" back ON first, or the Resep flask + Gudang Bahan tab won't show and `/api/v1/ingredients*` + `/recipe*` return 404.
2. (Optional) Watch whether the first-write-after-idle 400 is gone now (Neon fix).

---

# ⭐ PRIOR SESSION — 2026-05-28 (SP-Recipe-1 ingredient inventory) — kept for context

Branch `prod-hardening` · **SP-Recipe-1 (Ingredient Inventory Subsystem) CODE COMPLETE + SKU/Kategori/UOM follow-up DONE, deployed & pushed.** Backend **rev 00034-9jc** (migrations 0019 + 0020 applied; `/readyz` ok). 30 commits on `prod-hardening` (`2e2c81b`→`4f6ad6a`). Backoffice auto-deploys via Cloudflare from this branch. **No APK needed** — SP-Recipe-1 is backoffice-only (POS untouched).

**▶️ USER-PENDING UI verify** (any browser, admin login). Hard-refresh first to pick up the latest bundle:
1. Open `https://mandalika-pos.pages.dev` → login as admin → **Pengaturan** → confirm new "Resep & Bahan" section appears with the toggle (currently ON from live verify).
2. Open **Gudang** → confirm a 3rd tab **Bahan** appears (visible only because flag is ON). Toggle flag OFF in Settings, reload, confirm Bahan tab + section disappear; toggle back ON.
3. Walk the 6 inner tabs: **Daftar** (create + edit + search by name OR SKU, Kategori filter, UOM dropdown w/ Lainnya fallback, inline "+ Tambah kategori baru"), **Stok** (warehouse picker → stock table), **Stok Masuk** (goods-in modal w/ multi-line items), **Penyesuaian** (set absolute qty + required reason), **Transfer** (create draft → Kirim → Terima w/ optional shortfall + reason → completed; verify ISJ-2026-NNNNN + ITT-2026-NNNNN + `SuratJalanIngredientPanel` Bagikan/Unduh PDF/Unduh PNG/Lihat), **Opname** (create → Mulai → Simpan counted → Selesai → difference shown).
4. Verify SKU uniqueness: create an ingredient with SKU `RO-001`; try a 2nd ingredient with the same SKU → friendly inline error "SKU bahan sudah dipakai".

After UI verify: the next module is **SP-Recipe-2 (Recipes & versioning)** — per-variant recipes inside the product modal with full version history. See the COPY-READY block at the bottom of this file for the new-session kickoff prompt.

## ⭐ SP-Recipe-1 — Ingredient Inventory Subsystem: CODE COMPLETE (2026-05-28)
Spec `docs/superpowers/specs/2026-05-27-recipe-sp1-ingredients-design.md` · plan `docs/superpowers/plans/2026-05-27-recipe-sp1-ingredients.md` (5 phases A–E, 27 tasks, subagent-driven on `prod-hardening` directly). Commits `2e2c81b`→`8f2b552`, **pushed**.

**Module-wide locked decisions:** scope = reference-only formula + live ingredient-stock view (no auto-deduct on "produce") · ingredient model = separate `ingredients` table with `numeric(14,3)` qty (warehouse-only, never POS-synced) · recipes per-variant w/ full versioning (SP-Recipe-2) · POS exposure = none (`@mandalika/sync` untouched) · reuse `manage_inventory` perm · module gate `app_settings.recipes_enabled boolean` DEFAULT false (Mandalika stays quiet; Flamboyan / Performance flip it on) · cost = informational only.

**Built & live-verified (backend rev 00033-5vs):**
- **Migration 0019** (7 new tables — `ingredients`, `ingredient_warehouse_stock` (numeric qty!), `ingredient_goods_receipts(_items)`, `ingredient_stock_adjustments`, `ingredient_transfers` w/ ITRF- sequence + ISJ/ITT doc fields, `ingredient_transfer_items`, `ingredient_stock_counts(_items)`; one ALTER adding `app_settings.recipes_enabled`).
- **Backend (Go):** `write/ingredient.go` (CRUD + goods-in + adjust), `write/ingredient_transfer.go` (send/receive/cancel w/ idempotent replay + cancel-in-transit stock restore — caught & fixed pgx "conn busy" bug in commit `93c17e6` by collecting rows before exec), `write/ingredient_stockcount.go` (create/start/save/complete; snapshot ingredient_name+unit at start), `nextDocNo` extended via new kind literals `"ISJ"` + `"ITT"` (no schema change — `doc_sequences` already polymorphic). Read: `Ingredients`/`IngredientStock`/`IngredientTransfers`/`IngredientTransfer` (letterhead via SP4 `string_to_array` pattern verbatim), `IngredientStockCounts`/`IngredientStockCount`. Middleware: new `RequireRecipesEnabled` factory + `Repo.RecipesEnabled` helper — 404s every ingredient endpoint when flag is off. AppSettings round-trip extended for `recipesEnabled` (read JSON + write `*bool`). Go tests: `formatDocNo` ISJ/ITT cases pass; `validateIngTransfer` table-driven 4 cases pass.
- **OpenAPI:** 27 new schemas + 13 new paths under `/api/v1/ingredients`, `/api/v1/ingredient-transfers`, `/api/v1/ingredient-stock-counts`. `AppSettings.recipesEnabled?: boolean`. Existing `Letterhead` schema (SP4) reused for ingredient transfer letterheads.
- **TS client (`packages/api`):** 14 new type re-exports + 20 new Api methods + impls. `getAppSettings()` exposes `recipesEnabled`.
- **Backoffice (Cloudflare auto-deploys):** New `screens/ingredients/` folder with Bahan tab inside Gudang (flag-gated via app-settings fetch on mount), 6 inner tabs (Daftar / Stok / Stok Masuk / Penyesuaian / Transfer / Opname) + their modals (IngredientFormModal, IngredientGoodsInModal, IngredientAdjustModal, IngredientTransferForm, IngredientReceiveModal), cloned **SuratJalanIngredientPanel** + **IngredientSuratJalanDoc** (reuses SP4 `render.ts` unchanged for HTML→PNG→PDF→Web Share with anchor fallback). Settings → new "Resep & Bahan" toggle section. All gold-palette consistent; `npx tsc -b` clean.

**Live-verify highlights (test artifacts left in DB):**
- Flag-gate: `recipesEnabled=false` → 404 on every ingredient endpoint ✓; `recipesEnabled=true` → 200.
- CRUD: create Rose Oil (g, Rp 15000 cost) → list returns 1 row → update cost to 16500 → delete returns 200 (FK from goods-receipt-items blocks if stock exists — matches SP1 pattern).
- Goods-in 1000g → stock=1000 ✓; adjust to 945.5 (fractional!) ✓; no-reason adjust 400 ✓; negative qty 400 ✓.
- Transfer W1→W2 200g: send → `ISJ-2026-00001` + W1 stock 500→300 ✓; receive 190g w/ reason "susut perjalanan" → `ITT-2026-00001` + W2 stock=190 + difference=-10 ✓; receive without reason → 400 ✓.
- Self-transfer 400 ✓; oversend (9999>300) 400 ✓.
- Cancel-in-transit (after bug fix `93c17e6`): W1 300→250 after send, → 300 after cancel-in-transit ✓.
- Letterhead resolution: `sender.locationName=Gudang Pusat (contoh)` + `addressLines=['Jl. Override SP4', 'Line 2']` (string_to_array(\\n) parsed correctly); receiver similar; `brandName=Mandalika POS` from app_settings fallback ✓.
- Opname: create → start (snapshotted 2 active ingredients) → save counted=295.5 on item 1 → complete → status=completed + difference=-650 computed + W1 stock=295.5 ✓.

**Backend revs deployed this session:** 00029-f6m (A) → 00030-89p (B) → 00031-wql (C) → 00032-xvk (cancel fix) → 00033-5vs (D) → 00034-9jc (SKU/Kategori/UOM follow-up).

**Follow-up F1–F4 (2026-05-28, commits `76f1420`→`4f6ad6a`):** at user's request after live UI verify — ingredients gained:
- **SKU** (unique catalog-wide via partial index `idx_ingredient_sku WHERE sku <> ''` — mirrors SP1.5 product-variant barcode pattern). Friendly 400 `"SKU bahan sudah dipakai"` on duplicate via `pgconn.PgError` 23505 mapping.
- **Kategori** — new `ingredient_categories` table (id, name UNIQUE, sort_order, created_at), FK `ingredients.category_id ON DELETE SET NULL` (delete category → ingredients keep their rows, category_id nulled). Full CRUD endpoints under `/api/v1/ingredient-categories` (recipes-enabled gate).
- **UOM dropdown** — common units (g/kg/mg/ml/L/drop/pcs) + "Lainnya" → free-text fallback. `apps/backoffice/src/screens/ingredients/units.ts` exports `COMMON_UNITS` const.
- **Backend search** — `Ingredients` list now matches by name OR sku (`name ILIKE OR sku ILIKE`); ORDER BY `c.sort_order NULLS LAST, name`.
- **`IngredientFormModal`** — added SKU input, Category dropdown w/ inline "+ Tambah kategori baru" creator (replaces dropdown row temporarily with name input + Simpan/Batal, auto-selects newly created category), UOM `<select>` w/ Lainnya reveals custom-text input. **`DaftarTab`** — added SKU + Kategori columns (between Nama/Satuan and Satuan/Biaya respectively), Kategori filter dropdown next to search.
- **Migration 0020** applied live. Test artifacts left in DB: 3 categories (Fragrance Oil, Fixateur — Carrier was deleted to test SET NULL), 4 ingredients incl. `Rose Otto Premium` (SKU `RO-001`, cat Fragrance Oil).
- **Live verified end-to-end:** 9 scenarios passed (category CRUD, duplicate-name 400, duplicate-SKU 400, empty-SKU permitted twice, JOIN resolves categoryName, search-by-SKU, SET NULL on category delete).

**SP-Recipe-2 (NEXT, separate brainstorm+spec):** `recipes`, `recipe_versions`, `recipe_ingredients` tables + per-variant slide-over editor inside the product modal + full version history (Versi 3 of 5 dropdown, "Pulihkan ke versi ini" creates new version from snapshot) + cost estimation UI. All decisions in spec front-matter under "Module-wide locked decisions".

---

# ⭐ PRIOR SESSION — 2026-05-26 (kept for context)

Branch `prod-hardening` · Inventory **SP4 (transfer documents & sharing) CODE COMPLETE, reviewed, deployed & PUSHED** — the final Inventory slice. Backend **rev 00028-gw6** (migration 0018 applied; `/readyz` ok; `SJ-2026-NNNNN` + `TT-2026-NNNNN` assigned + resolved letterheads verified via live API). Backoffice pushed (Cloudflare auto-deploys). Signed APK built (run **26441658450** on commit `40481bc`, artifact `mandalika-pos-release-apk`). **▶️ TWO USER-PENDING re-tests** (both need a physical device + an admin/cashier login the agent can't self-auth):
1. **SP3 on-device re-test** (still pending from prior session) — FU-1 non-blocking inbound poll + FU-2 clean rejected-receive + original informed-count/PIN/lockout/offline E2E.
2. **SP4 on-device verify** — install latest APK, do a receive → confirm TandaTerimaPrompt auto-pops, "Cetak" prints a clean 32-col thermal slip (header + Krm/Trm/Sel table + Diterima oleh + signature line); also verify "Cetak Ulang Tanda Terima" persists on the inbound list. Backoffice (any browser, no device needed): send a transfer → SuratJalanPanel appears with Bagikan/Unduh PDF/PNG/Lihat; Bagikan opens OS share-sheet on mobile/Chrome desktop (falls back to anchor-download on Firefox).

After both re-tests: the next module is **Recipe / Formula per product** (for Flamboyan & Performance Perfume brands) — own brainstorm→spec→plan. See `product-module-roadmap` memory.

## ⭐ SP3 — POS-side receiving + PIN: CODE COMPLETE (2026-05-25)
Spec `docs/superpowers/specs/2026-05-25-inventory-sp3-pos-receiving-pin-design.md` · plan `docs/superpowers/plans/2026-05-25-inventory-sp3-pos-receiving-pin.md` (phased A–E, subagent-driven). Commits on `prod-hardening` (`e541236`→`d3d1c03`), **pushed**.

**Locked design (9 decisions):** per-user PIN + **manager step-up** on the cashier device · **on-device** argon2id verify (hash-wasm) + server re-validate · **informed count** (sentQty pre-filled) · **POS primary + backoffice override** (warehouse-dest stays backoffice) · **per-role org-wide** approver config · **admin-assigned** PINs · PIN-hash sync **scoped to outlet+admins** · **optimistic local credit + reconciliation** · atomic receive.

**Built & verified (non-device):**
- Migration **0017** (users.receive_pin_hash/_set_at; transfers.received_by/_via/_idempotency_key; app_settings.receive_approver_roles) — applied live (`/readyz` ok).
- Backend: `transfer_receive` sync handler (re-validates PIN+role+**scope**, idempotent via received_idempotency_key) → reuses `ReceiveTransfer` (now takes `ReceiveMeta`); pull bundle carries in-transit transfers + scoped approvers; set/clear-PIN endpoint (admin). Go tests: `approverAllowed`, `receiveScope`. `go build`+`go test`+`make gen-check` green.
- `packages/sync`: `verifyPin` (hash-wasm), pure `lockout`, `pendingCredits`/`applyCredits`/reconcile, engine credited-snapshot + `enqueueTransferReceive`. **12 vitest pass** incl. Go↔JS argon2id round-trip. POS prod build OK (hash-wasm bundles).
- POS UI: "Terima Transfer" menu+badge, inbound list + informed-count receive screen, manager PIN step-up modal (lockout), optimistic credit + dead-letter rollback notice.
- Backoffice: per-user receive-PIN field (Users), approver-roles toggles (Settings), outlet-dest "force receive (override)" caption.
- **Final opus review:** core (idempotency/reconciliation/data-integrity) sound, no double-count/lost-rollback. **2 HIGH fixed:** (a) server now re-validates scope (`3663583`), (b) PIN redacted from dead-letter error-log + shareable sync-log (`5874f17`).

**Device-test follow-ups SHIPPED (2026-05-25, rev 00027-5cd):**
- **FU-1 — non-blocking inbound poll** (`d8cd8f0`→`d3d1c03`): inbound transfers reach the POS via a lightweight **cashier-scoped poll** `GET /api/v1/sync/inbound-transfers` (~20s, offline-tolerant KV cache) instead of the heavy version-gated bundle — badge+receive list update **without a sales-blocking full resync**. `transfers` REMOVED from the pull bundle (`receiveApprovers` stays). Engine: `pollInbound()`/`getInboundTransfers()`, wired into `start()`. POS reads `engine.getInboundTransfers()`. WHY: device test showed a sent transfer didn't surface until a manual sync, and full-resync-on-every-stock-change felt redundant.
- **FU-2 — clean rejected-receive** (`2244a3f`): a `transfer_receive` that gets a deterministic server rejection (e.g. already received via backoffice override) now rolls back IMMEDIATELY in `flush()` — `pending.remove` + `outbox.discard` + one `onReceiveRejected` toast — **no retry, no dead-letter, no POS "sync failed" false-alarm, no error-log entry**. Transient failures still retry/dead-letter normally. WHY: device test rollback worked but surfaced a scary "Sinkronisasi gagal" on the POS for a handled case.

**MINOR follow-ups — ALL DONE (2026-05-25, commits `4a7005a`/`cfed5e8`/`1c8ac0b`, pushed):** (1) PIN lockout now uses the durable secure KV (`getKV`+readJSON/writeJSON) not raw `localStorage`. (2) `lockout.recordFailure` grants a fresh attempt batch after cooldown (no instant re-lock) + new test (sync vitest now 13). (3) Settings approver UI shows **admin as always-on (disabled, honest)** since admins always approve server-side; only manager/cashier are real toggles; DEFAULT aligned to `[]`. No backend change in these (POS + backoffice only).

**USER-PENDING re-test:** install latest APK; verify FU-1 (transfer sent → badge appears on POS within ~20s WITHOUT manual sync / no sales block) and FU-2 (offline receive → backoffice force-receive same → reconnect → quiet rollback toast, NO failed-sync alarm). Plus the original E2E: informed count w/ discrepancy; PIN accept/reject+lockout; offline receive→reconnect→credit-once.

## ⭐ SP4 — Transfer documents & sharing: CODE COMPLETE (2026-05-26)
Spec `docs/superpowers/specs/2026-05-26-inventory-sp4-transfer-documents-design.md` · plan `docs/superpowers/plans/2026-05-26-inventory-sp4-transfer-documents.md` (5 phases A–E, 23 tasks, subagent-driven). Commits on `prod-hardening` (`b52aa08`→`40481bc`), **pushed**.

**Locked design (11 decisions):** hybrid architecture (backoffice web PDF+PNG share + POS native thermal **tanda terima** at receive) · POS scope = tanda terima only · branding C2 (brand default in `app_settings.documents` + per-location override on outlets/warehouses; **reuses the existing `address` + `phone` columns**, adds only `logo_url`) · client-side render (html-to-image + jsPDF) · surat jalan L2 layout (Dari/Untuk, 2 sig lines, no Sopir) · backoffice trigger = inline "Surat jalan siap" panel + Bagikan auto-opens Web Share API · POS trigger = auto-prompt modal after server-acknowledged receive · separate numbering (`SJ-yyyy-NNNNN` at send, `TT-yyyy-NNNNN` at receive; per-year `doc_sequences` counter) · permissions = existing `manage_inventory` (no new perm) · share payload = PNG only · **refinement vs spec:** server-side letterhead resolution shipped on every Transfer DTO (single source of truth for both clients).

**Built & verified (non-device):**
- Migration **0018** (`app_settings.documents_*` 5 cols; `warehouses.logo_url` + `outlets.logo_url`; `transfers.surat_jalan_no UNIQUE` + `tanda_terima_no UNIQUE`; new `doc_sequences (kind, year, next_seq)` counter table) — applied live (`/readyz` ok at rev 00028-gw6).
- Backend: `nextDocNo` + `formatDocNo` (pure, tested); `SendTransfer` stamps SJ in-tx; `ReceiveTransfer` stamps TT in-tx and skips on idempotent replay; `transferObj` COALESCE-resolves sender/receiver letterheads with `app_settings.documents_*` fallback; `app_settings.documents` round-trip; warehouse/outlet `logo_url` round-trip; `transfer_receive` sync ack ships full completed `Transfer` snapshot + `tandaTerimaNo`. OpenAPI extended (Letterhead + DocumentSettings + Transfer doc-numbers + letterheads + SyncItemResult.{tandaTerimaNo, transfer}). Go tests: `TestFormatDocNo` (5 cases). `go build` + `go test` + `make gen-check` green.
- `packages/sync`: new `onReceiveAccepted(transfer: Transfer)` event fires from the 'ok' branch (not 'duplicate'); **16 vitest pass** (added `engine.receive-accepted.test.ts` with 3 cases incl. Node 24 `navigator.onLine` stub).
- `packages/printer`: `buildTandaTerima` ESC/POS (32-col K/T/S layout; 3 vitest pass — content checks, no-discrepancy variant, header-width 32) + `printTandaTerima` job. Vitest added to printer package.
- Backoffice: Settings → new "Dokumen" section (brand-level letterhead + logo upload via existing Cloudinary `uploadImage`); per-warehouse + per-outlet edit modals carry a `logo_url` upload (the existing `address`+`phone` are now also the letterhead override); transfers detail mounts `<SuratJalanPanel>` with Bagikan/Unduh PDF/Unduh PNG/Lihat (off-screen mounted `<SuratJalanDoc>` for `html-to-image`, A4 inline-CSS, system fonts, `crossOrigin="anonymous"` for Cloudinary logos); `render.ts` covers Web Share with `canShare({files})` guard + anchor-download fallback; Lihat opens scaled preview modal (disabled while a render is in-flight). Outlet `toggle()` now forwards `logoUrl` so quick active/inactive flip doesn't wipe the logo.
- POS: `usePrinter().printTandaTerima(data, settings)`; `buildTandaTerimaData` pure mapper (5 vitest pass incl. brand/locationName/dest.name fallback chain + empty-discrepancy + null-receivedQty defaults); `TandaTerimaPrompt` modal (Cetak disabled when `!isPaired`; Lewati safe; inline error keeps modal open on print failure); CashierScreen wires `SyncReceiveAcceptedRefContext` and holds a `completedTransfers` array (cap 10) so `ReceiveTransferPanel` can offer "Cetak Ulang Tanda Terima" for recently-completed transfers in the same session.
- **Final reviews:** all 14 implementer tasks reviewed by both spec-compliance and code-quality agents. **Real fixes shipped during the loop:** (a) A1 migration originally tried to ADD `phone` columns that already existed on outlets/warehouses (migration 0001/0015) — design call resolved to **reuse the existing columns** and only add `logo_url`; plan + migration rewritten (`9f5eae4` → `b52aa08`). (b) A2 wrapped `nextDocNo` DB error with `fmt.Errorf %w` for actionable diagnostics. (c) A5 OpenAPI missed `OutletInput.logoUrl` + `WarehouseInput.logoUrl`; follow-up commit `1d230ff` added them. (d) A7 wrapped the `documents` UPDATE error similarly. (e) B3 `toggle()` now preserves `logoUrl`. (f) C3 "Lihat" disabled during in-flight render to avoid concurrent `html-to-image` traversal of the same node. (g) D1 column-math JSDoc qualified for `|difference| >= 100` overflow case. (h) E2 lockfile mismatch (D1 added `vitest` devDep to printer without regenerating) — fixed in `40481bc` and APK build succeeded on re-dispatch.

**Live-verify at A10 (backend rev 00028-gw6):** PUT `/app-settings` with `documents.brandName/addressLines/phone/npwp` → round-trip OK; warehouse PUT with `logoUrl` + multi-line `address` → round-trip OK (newlines stored); created TRF send → `suratJalanNo: "SJ-2026-00001"`, both letterheads resolved (sender = warehouse override values, receiver = brand fallback); received → `tandaTerimaNo: "TT-2026-00001"`, status `completed`; per-year sequence increments verified (`SJ-2026-00001` → `SJ-2026-00002`). Test artifacts left in DB.

**USER-PENDING SP4 re-test:** install latest APK; on the POS, **send** a transfer from backoffice (or via API) then **Terima** it on the device → confirm the "Tanda terima siap. Cetak sekarang?" modal pops on server-ack (not optimistic credit) → tap **Cetak** with a paired BLE printer → verify the slip prints with the receiver letterhead (brand + addressLines + phone), K/T/S table, discrepancy line, "Diterima oleh: <cashier>" + signature line. Then dismiss the modal and reopen "Terima Transfer" → confirm "Cetak Ulang Tanda Terima" persists on the completed row. Backoffice (no device needed, any browser): send a transfer → SuratJalanPanel appears under PageHeader → **Bagikan** opens OS share-sheet (mobile Chrome + Chrome desktop), or downloads the PNG with a toast on Firefox; **Unduh PDF** + **Unduh PNG** download the files; **Lihat** opens a scaled preview modal.

---

### (Superseded) prior SP2 next-action
SP2 (transfers) was DONE & deployed (rev 00023-tz9); SP3 above is the successor.

## ‼️ Production status correction
The app is **deployed & functional on free-tier infra but runs TEST DATA ONLY —
NOT real sales, NOT fully production-ready** (user confirmed 2026-05-25). The
walkthrough's "live and selling" = the `/goal` (proving a cashier *can* sell +
the deploy works), not real usage. So **do NOT over-caution about disturbing
real sales** — deploys/migrations need basic hygiene, not kid-gloves. Pre-prod
checklist = `DEV_TO_PROD_WALKTHROUGH.md` Part D.

## The 6 working rules (user-required, confirm on new sessions)
ask don't assume · don't touch unrelated · flag uncertainty · verify on failure ·
show changes · admit gaps. (Memory: `working-rules-six`.)

## DONE this session (commits on prod-hardening, all pushed)
1. **UPC → per-variant scan-to-cart redesign** (spec `docs/superpowers/specs/2026-05-25-per-variant-scan-to-cart-design.md`, plan `…/plans/2026-05-25-per-variant-scan-to-cart.md`). Backend **LIVE rev 00019-q4r**:
   - migration **0014**: per-variant `product_variants.barcode` (defaults to SKU, catalog-wide unique via partial index `idx_variant_barcode`; dedupe before index). `products.upc` DROPPED FROM API but COLUMN KEPT DEAD (expand/contract — **TODO: drop in a later migration** once no old revision reads it).
   - backend write defaults empty barcode→SKU (`variantBarcode`), within-product dup check, `barcodeConflict` maps pg 23505 → friendly 400.
   - read emits per-variant `barcode`. Verified live (round-trip + dup-reject 400).
   - Backoffice: per-variant Barcode field (blank⇒SKU at save) + CSV `Barcode` column; parent UPC input removed.
   - POS scan-to-cart: pure `apps/pos/src/cashier/scan.ts` (`buildScanIndex`/`resolveScan`) + **keyboard-wedge** (Enter in product search → add 1, stock-guarded, toast) + **camera** (`@capacitor-mlkit/barcode-scanning@8.1.0`, QR+1D; CAMERA perm + `uses-feature required=false`).
   - **Pure-function unit tests added** — Go (`backend/internal/write/repo_test.go`) + **first JS test runner: Vitest 4.1.7** in apps/pos (`apps/pos/src/cashier/scan.test.ts`; `test`=`vitest run`; `*.test.ts` excluded from prod `tsc -b`).
   - **APK built**: CI run 26369022325 success, artifact `mandalika-pos-release-apk`. **ON-DEVICE VERIFY = still USER-PENDING** (camera QR+1D, wedge, backoffice barcode UI/CSV).
2. **Phase 4 — product import-template** (`be66137`): "Template" button in Products toolbar downloads `template_produk_mandalika_<date>.csv` (importer columns + 2 example variant rows) via exportToCSV. Backoffice-only.

## Product-module phase mapping (clarified 2026-05-25)
- Phase 1 = per-outlet inventory & pricing → DONE.
- Phase 2 = (was a multi-step wizard) → **REPLACED** by cherry-picked single-modal enhancements (PAR/UPC/sellable/multi-image) + per-variant availability + stable variant identity + scan-to-cart. DONE, no wizard.
- **Phase 3 = Inventory / Warehouse module → IN PROGRESS (planning done, see below).**
- Phase 4 = import-template → DONE.

## ▶️ NEXT: Inventory module (Phase 3) — decomposed into SP1–SP4
Spec (incl. full module decomposition + module-wide locked decisions): `docs/superpowers/specs/2026-05-25-inventory-sp1-warehouse-foundation-design.md`.
**Module-wide LOCKED decisions:** mesh topology (any↔any) · two-step send→receive with in-transit · **separate** warehouse subsystem (own tables, never POS-synced) · goods-in entry (cost informational only) · receive-actual-and-record-discrepancy · **draft** transfers · authoritative **PIN + selected roles** for approval · new `manage_inventory` permission.
- **SP1 — Warehouse foundation** (backoffice). ✅ **FULLY DONE & VERIFIED LIVE (backend rev 00021-d5c, migration 0015; backoffice pushed `131f4e2`).** Warehouses CRUD + `warehouse_variant_stock` + goods-in (additive) + adjust (absolute set + reason) + Gudang screen/nav + `manage_inventory` perm + **warehouse stock-count** (chose option (a): extended the unified opname screen with an Outlet/Gudang location picker; `stockcount.go` location-polymorphic; handlers warehouse-aware; read emits `warehouseId`). VERIFIED via authed API: goods-in 10→15, adjust→7, 400 on no-reason; **outlet opname regression intact (→55) AND warehouse opname create→complete (→33)**; warehouse counts list under admin "Semua". Demo warehouse "Gudang Pusat (contoh)" left in DB. Minor UX: warehouse counts list only in admin "Semua outlet" mode (cross-outlet). **NEXT module work = SP2 (transfers).**
- **SP2 — Transfers core** (backoffice): ✅ **DONE & DEPLOYED (backend rev 00023-tz9, migration 0016; all commits pushed `fcb3427`→`f557fa8`).** draft→send→in-transit→receive→discrepancy→completed + cancel (draft void / in-transit restore source); **mesh** polymorphic source/dest via separate nullable FK cols (`transfers`/`transfer_items`); implicit in-transit (deduct@send, credit-actual@receive); per-outlet-leg `content_version` bump via `bumpVersionOutlets(...,"products")` (warehouse legs don't bump); `manage_inventory`-gated. Backoffice: **Transfer tab inside Gudang** (`screens/transfers/` + tabbed `Warehouses.tsx`). Spec `docs/superpowers/specs/2026-05-25-inventory-sp2-transfers-core-design.md`, plan `docs/superpowers/plans/2026-05-25-inventory-sp2-transfers-core.md`. **VERIFIED LIVE via authed API**: wh→wh send/receive w/ discrepancy (difference −2 recorded), receive-no-reason→400, cancel-in-transit restored source, oversend→400, self-transfer→400, wh→outlet receive credited outlet stock (+3), location-stock input guard (bad/empty kind→400, valid→200). Go write logic go-reviewed; full-feature review = 0 critical/high (2 Important + 2 Minor fixed in `f557fa8`). **UI VERIFIED via Playwright** (2026-05-25) on `mandalika-pos.pages.dev`: Gudang|Transfer tabs render; created **TRF-00005** through the form (mesh source/dest dropdowns + live on-hand fetch) → Kirim → Terima with shortfall 2→1 + required reason → Selesai (Selisih −1 + reason shown); 0 console errors. content_version *integer* increment not asserted directly (outlet credit path proven; SP3 consumes it on POS). Test artifacts left in DB (test-data env): warehouses "SP2 Verify Src/Dst" + transfers TRF-00001..00005.
- **SP3 — POS-side receiving + PIN**: in-transit transfers sync to destination outlet's POS; receiver confirms on-device with REAL counted qty (cross-checks admin input); offline-capable enqueue; authoritative PIN + role gate. (brainstorm→spec→plan when reached.)
- **SP4 — Transfer documents & sharing**: ✅ **CODE COMPLETE, deployed & pushed 2026-05-26** (backend rev 00028-gw6, migration 0018; commits `b52aa08`→`40481bc`). Hybrid architecture: backoffice (web) renders surat jalan as client-side PNG + PDF and shares via Web Share API (with anchor-download fallback); POS (native) thermal-prints tanda terima after a server-acknowledged receive via the existing BLE `@mandalika/printer`. C2 branding (brand default in `app_settings.documents` + per-location override using existing `address`+`phone` + new `logo_url`). Separate per-year `SJ-yyyy-NNNNN` (send) and `TT-yyyy-NNNNN` (receive) numbering via new `doc_sequences` counter. Server resolves+ships letterheads on every Transfer DTO. APK run 26441658450. Spec/plan: `docs/superpowers/{specs,plans}/2026-05-26-inventory-sp4-transfer-documents*`. **USER-PENDING:** on-device verify (see top-of-file pending items).

## ▶️ THEN (do NOT forget): Recipe / Formula per product module
After Inventory SP1–SP4. Tie a formula/recipe to each product for production tracking — wanted for the **Flamboyan Perfume** & **Performance Perfume** brands (this POS is a 3-brand template). Own brainstorm→spec→plan. (Memory: `product-module-roadmap`.)

## Execution method in use
Subagent-driven development (fresh implementer per task + spec & code-quality review) on `prod-hardening` directly (NOT worktrees — Cloudflare auto-deploys backoffice from this branch; backend via `gcloud run deploy`; APK via GH Actions dispatch). All deploy/APK commands are below in the older sections (still valid).

---

## Purpose / how to use this doc
The app is **live and selling** (free-tier cutover). Work is an iterative
UI/UX + correctness polish loop driven by on-device testing. **Next focus:
Backoffice** (see "Next: Backoffice"). This file carries full context into a
fresh session — read it first, then trust:
- **Initial product goal:** `DEV_TO_PROD_WALKTHROUGH.md` → PART B (the `/goal`).
  All 6 success criteria are met (deployed; see PART 0 there).
- **Ops runbook:** `RUNBOOK.md` (deploy / rollback / DB restore / secrets).
- **Current state:** `DEV_TO_PROD_WALKTHROUGH.md` → PART 0 + this file.

---

## Live infrastructure
| Thing | Value |
|---|---|
| GCP project | `mandalika-pos` (number `538849926142`) |
| Region | `asia-southeast2` (Jakarta) |
| Backend | Cloud Run `mandalika-pos`, rev **00013-q9b**, `API_URL = https://mandalika-pos-538849926142.asia-southeast2.run.app` |
| DB / cache | Neon Postgres + Upstash Redis (TLS) — via GCP Secret Manager |
| Backoffice | Cloudflare Pages `https://mandalika-pos.pages.dev` — **auto-deploys on push** to `prod-hardening` (`VITE_API_URL` set there) |
| POS APK | GitHub Actions `.github/workflows/android-release.yml` (workflow_dispatch on `prod-hardening`) → artifact `mandalika-pos-release-apk` |
| Repo | `github.com/Epheyy/mandalika-pos` |

Secrets in **Google Secret Manager**: `DATABASE_URL REDIS_URL JWT_ACCESS_SECRET
JWT_REFRESH_SECRET SEED_ADMIN_PASSWORD SENTRY_DSN CLOUDINARY_API_SECRET`
(SENTRY_DSN IS set → backend errors reach Sentry). Migrations auto-apply on
backend boot (`cmd/server/main.go`).

### Test creds
- Admin (backoffice): `admin@mandalika.test` — pwd in Secret Manager `SEED_ADMIN_PASSWORD` / memory `prod-cutover-deploy-ready.md`.
- Cashier (POS): `test@mandalika.test`, role `cashier`, one outlet ("Mandalika").
- Keystore `mandalika-release.jks` (repo root, **gitignored, irreplaceable** — user must back up). CI uses repo secrets `ANDROID_KEYSTORE_BASE64` / `_PASSWORD` / `ANDROID_KEY_ALIAS=mandalika` / `_KEY_PASSWORD`.

---

## ⭐ The agent CAN deploy + build APK itself (changed this session)
`gcloud` is authed (`reffyvee@gmail.com`) and works from the Bash tool with
`dangerouslyDisableSandbox: true`. The APK workflow is dispatched via the GitHub
REST API using the token from `git credential fill` (has `workflow` scope). So
the full deploy → APK loop is automatable — no need to hand commands to the user.

```bash
# Backend deploy (run in background; ~4–6 min; migrations auto-apply on boot)
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet

# OpenAPI codegen after editing backend/api/openapi.yaml
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd .. && corepack pnpm --filter @mandalika/api gen     # regen TS types

# Dispatch the signed APK build (prod-hardening), then poll the run for the artifact
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Epheyy/mandalika-pos/actions/workflows/android-release.yml/dispatches \
  -d '{"ref":"prod-hardening","inputs":{"api_url":"https://mandalika-pos-538849926142.asia-southeast2.run.app"}}'
```
Standard loop each batch: edit → typecheck (`pnpm --filter <app> exec tsc --noEmit`)
+ build → (if backend) deploy + verify `/readyz` → commit → push → dispatch APK → poll.

---

## Done this session (2026-05-23) — commits on `prod-hardening`
Backend revisions deployed: **00009 → 00013**. Migrations added: **0006–0009**.

1. `6ab4480` — gated `[sync]` console logs behind a `debug` flag (kept ON for the polish phase; see "before final build").
2. `0e6312f` — **shift reconciliation** (per-method counted/Terhitung, backend `shifts.counted_by_method`, migration **0006**), recap/history polish, removed view-switching → single adaptive layout, product-card image-fallback + cleaner design.
3. `14e67ab` — **discount source**: `orders.discount_label` (migration **0007**), shown in POS history; backoffice orders **Export (XLSX)**; card price/stock toggles; shift-detail popover fix.
4. `b8e63ba` — recap/history **portrait responsive** (top tabs + overlay detail); **per-variant** card price/stock; **itemized discount breakdown** `orders.discount_breakdown` (migration **0008**).
5. `e55fb75` — **print shift recap** via BLE (`buildRecap` in `@mandalika/printer`, `printer.printRecap`); "Cetak Rekap" in Rekapan + Riwayat.
6. `693ecbe` — fix Riwayat column drift (fixed grid template).
7. `db3531d` — **close shift routes through the recap** with **mandatory counted income**; **active outlet name** in snapshot (`SyncPullBundle.outletName`) used by recap/print (was hardcoded "Mandalika").
8. `0ea78ec` — **central error log** (migration **0009** `error_logs`): `POST /api/v1/error-logs` (any authed), admin `GET /api/v1/error-logs`; POS reports sync dead-letters (auto), runtime errors (global handler), print failures, with **breadcrumb trail** (`apps/pos/src/lib/activityLog.ts` + `errorReporter.ts`); backend panics persist too; new **Backoffice → Log Error** screen.

---

## Next: Backoffice (the requested focus)
1. **User → outlet placement** (explicitly requested; e.g. "Ryan = cashier @ Mandalika PMS").
   - POS already consumes `snapshot.outletName` and scopes by the cashier's `outletId` from their JWT. **Remaining work is backoffice-side:** the Users screen needs to assign/edit a user's outlet, persist `users.outlet_id`, and ensure login returns it (`auth` already sets `authStore.outletId = user.outletId`). Check `apps/backoffice/src/screens/Users.tsx` + the user write path + `CreateUserRequest`/`UpdateUserRequest` for an `outletId` field.
2. **Backoffice UI/UX polish** (user expects this to be the largest chunk) — apply the same anti-template quality bar used on the POS.

---

## ⚠️ Before a TRUE-FINAL build — revert the polish-phase debug aids (3 edits)
Documented in `DEV_TO_PROD_WALKTHROUGH.md` PART 0. Currently ON so the CI release
APK is inspectable during polish:
1. `apps/pos/capacitor.config.ts` → remove `android.webContentsDebuggingEnabled: true`; set `loggingBehavior: 'production'`.
2. `apps/pos/src/cashier/SyncProvider.tsx` → `debug: true` → `import.meta.env.DEV`.
3. `packages/sync/src/engine.ts` → nothing (the `debug` gate stays — permanent).

---

## Gotchas / facts
- **`/healthz` is swallowed by Google's edge (404)** — monitor `/readyz` instead. App routing is fine.
- **Two `0005` migrations** (`0005_order_scheme_outlet_code.sql`, `0005_payment_method_freeform.sql`) — both applied; the runner tracks by full filename. **Do NOT rename.** New migrations start at the next number (now 0010+).
- **Commit hook blocks `--no-verify`** AND false-positives on chained `git commit && …`. Run `git commit` on its own line, then push separately.
- Local APK build is **blocked on Windows** (space in path breaks BLE plugin Gradle) — use CI only.
- `error_logs` capture is **forward-only**; `discount_label`/`discount_breakdown` are denormalized per-order going forward (old orders show the single collapsed line).
- gofmt aligns structs; run `gofmt -w internal/` before committing backend.
- CI backend gate (`make gen-check`) fails if `api.gen.go` drifts — always commit the regenerated file.

---

## ✅ DONE 2026-05-28 — SP-Recipe-2 shipped (see ⭐ LATEST SESSION at top). The kickoff prompt below is kept only as a historical record.

## (HISTORICAL) COPY-READY: start SP-Recipe-2 (Recipes & versioning) brainstorm in a new session

SP-Recipe-1 (ingredient inventory) is DONE — including the SKU + Kategori + UOM-dropdown follow-up (backend rev `00034-9jc`, last commit `4f6ad6a`). The next module slice is **SP-Recipe-2: per-variant recipes with full version history + cost estimate**. Paste this as the first message in a fresh session:

```
continue Mandalika POS / brainstorm SP-Recipe-2 (Recipes & versioning, per-variant slide-over editor inside the product modal) — read SESSION_HANDOFF.md (⭐ LATEST SESSION at top) + product-module-roadmap memory first, then kick off superpowers:brainstorming for SP-Recipe-2.

SP-Recipe-1 (ingredient inventory subsystem) is DONE & deployed (backend rev 00034-9jc; ingredients have SKU, category, UOM dropdown). SP-Recipe-2 builds ON TOP of it: recipes attach to product variants and reference ingredients. Module-wide decisions are already locked in the SP-Recipe-1 spec front-matter ("Module-wide locked decisions" section at the top of docs/superpowers/specs/2026-05-27-recipe-sp1-ingredients-design.md). Confirm the 6 working rules. Same brainstorm → spec → plan → subagent-driven build loop. Spec/plan go in docs/superpowers/{specs,plans}/2026-..-recipe-sp2-*.
```

### Module-wide decisions already locked (carry into SP-Recipe-2 brainstorm — don't relitigate)

- **Per-variant recipes** (not per-product) — each variant (30ml / 50ml / 100ml) has its own recipe row.
- **Full version history** — every save creates a new `recipe_versions` row with full ingredient snapshot (`unit_at_save`, `cost_at_save` frozen so historical versions don't break if an ingredient is renamed/repriced).
- **POS exposure = none** — backoffice-only; `@mandalika/sync` untouched.
- **Permission = reuse `manage_inventory`** (admin implicit).
- **Module gated** by the existing `app_settings.recipes_enabled` flag — currently ON in test deployment (Settings → Resep & Bahan toggle).
- **Cost = informational** — recipe screen shows "Estimasi biaya bahan: Rp X" computed from `qty × default_unit_cost`; auto-hide if any ingredient lacks a cost.
- **UI placement** — Resep button on each variant row in the product edit modal → opens a **right-side slide-over panel** (chose layout A during SP-Recipe-1 brainstorm).

### Proposed SP-Recipe-2 scope (open the brainstorm with this — confirm or adjust)

- **Tables (migration 0021):**
  - `recipes (id, variant_id UNIQUE, current_version_id, created_at, created_by)` — one recipe per variant; `current_version_id` is the "live" version pointer.
  - `recipe_versions (id, recipe_id, version_no int, notes, total_cost_cached numeric(14,2) nullable, created_at, created_by; UNIQUE(recipe_id, version_no))` — history rows.
  - `recipe_ingredients (version_id, ingredient_id, qty numeric(14,3), unit_at_save text, cost_at_save numeric(14,2) nullable, sort_order int)` — snapshot at save time.

- **Backend (Go + OpenAPI):**
  - `POST /api/v1/products/:productId/variants/:variantId/recipe` — creates a NEW `recipe_versions` row; updates `recipes.current_version_id`. Snapshot ingredient unit + cost at save time. Recomputes `total_cost_cached`.
  - `GET .../recipe` — returns the current version (with `name`/`unit`/`stock` hydrated for each ingredient).
  - `GET .../recipe/versions` — list of all versions (no items).
  - `GET .../recipe/versions/:id` — specific snapshot.
  - `POST .../recipe/versions/:id/restore` — creates a new version from a historical snapshot's items (atomic).
  - 400 if any referenced ingredient is inactive or unknown; 400 if qty ≤ 0.

- **Backoffice UI:**
  - Inside the existing Products edit modal: a "Resep" button on each variant row.
  - Clicking opens a **slide-over panel** (~480px wide, right side). Header: variant identity ("Parfum Aurora — 50ml") + version selector dropdown ("Versi 3 (kini) ▾" → opens history list with date + author + notes; clicking a historical row loads it read-only; "Pulihkan ke versi ini" creates a new version from snapshot).
  - Ingredients table: ingredient autocomplete (search by name OR SKU — SKU is now indexable from F1-F4) + qty input (numeric, fractional) + auto-fill unit from ingredient + stock-availability hint per warehouse with low-stock ⚠ icon. Optional Kategori filter on the autocomplete dropdown.
  - Footer: cost estimate (sum of `qty × default_unit_cost`, hidden if any ingredient has null cost); "Catatan versi" textarea; "Simpan versi baru" button.

- **Out of scope (deferred):**
  - "Produksi" auto-deduct button — module-wide locked OUT in SP-Recipe-1.
  - POS exposure of recipes — never.
  - Recipe-level photos / instructions / steps — keep MVP focused on ingredient list + qty.

### Files the brainstorm should reference first

1. `docs/superpowers/specs/2026-05-27-recipe-sp1-ingredients-design.md` — the SP-Recipe-1 spec, especially the "Module context" section at the top (lists the SP-Recipe-2 scope) and the "Deferred to SP-Recipe-2" section.
2. `docs/superpowers/plans/2026-05-27-recipe-sp1-ingredients.md` — patterns the SP-Recipe-2 plan should mirror.
3. The existing product edit modal: `apps/backoffice/src/screens/Products.tsx` — the new "Resep" button will mount inside the variant rows here.
4. `apps/backoffice/src/screens/ingredients/IngredientFormModal.tsx` — the existing UOM-dropdown + Category-dropdown patterns to reuse in the recipe ingredient picker.

### Open brainstorm questions (queue these for the new session)

1. **Cost recompute on edit-vs-restore:** should `total_cost_cached` be recomputed from CURRENT ingredient costs when a user clicks "Pulihkan ke versi ini" (creates a new version using restored snapshot ingredients) — or kept as the historical snapshot's cached cost? Default: recompute on restore (the new version reflects today's prices).
2. **Concurrent edits:** if two users save the same recipe within seconds, both become consecutive `version_no` rows. Acceptable, or do we need optimistic locking via an `If-Match` header on the current version id?
3. **Soft-delete an ingredient referenced by a recipe:** what happens? Ingredient `is_active = false` is already supported; the recipe view should warn but not break. The historical version stays intact because `recipe_ingredients.unit_at_save` + `cost_at_save` are snapshots.
4. **Recipe deletion:** delete `recipes` row → cascade to all `recipe_versions` + `recipe_ingredients`? Or block delete if any version exists (force "archive" via `is_active`)? Default proposal: cascade-delete (with confirm modal), since per-variant recipes are tightly coupled to the variant itself which can also be deleted.
5. **Recipe-level Kategori:** any need for a recipe-level metadata (e.g., perfumery base/middle/top notes) beyond just ingredient lines? Strongly recommend NO for MVP — keep recipe = list of ingredient + qty + notes.

(Spec/plan will live at `docs/superpowers/{specs,plans}/2026-..-recipe-sp2-*`. Migration slot: 0021.)
