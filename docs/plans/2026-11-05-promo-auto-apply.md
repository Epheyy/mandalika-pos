# Promo auto-apply (per-promotion setting): plan

Date: 2026-11-05. Status: plan only, no code. Branch `docs/promo-auto-apply-plan` off `prod-hardening` `d474f4fb`.
Source: QA item P-21 (`docs/design-kaca/QA-FINDINGS.md`, in git history: `git show 9e781db3:docs/design-kaca/QA-FINDINGS.md`): the backoffice says promos are "Diskon otomatis di kasir", but the cashier has to tap
"+ Tambah" for each one. Owner decision (2026-11-05): auto-apply is a **per-promotion setting** in the backoffice, default off, not a global
change. Binding: no PIN or permission gates (D-11), no see-through dialogs, never auto-merge customers.
Every file:line below was read from `d474f4fb` in this session, not taken from memory or older docs.

## 0. Current state (what the code does today)

- **Server resolves only what the POS sends.** `CreateOrder` -> `resolvePromos` (`backend/internal/service/promo_resolve.go:171-336`) loads each
  `promotionIds` entry with `loadPromoSpec` (`:99-155`, `WHERE id=$1 AND is_active=true`) and runs `ValidatePromo` (`promo_validate.go:112-139`: dates,
  min purchase, day, hours, outlet). It blocks `code_only` on the direct path (`:204-210`), resolves codes (linked ones use the promotion's
  mechanics), then applies `combinabilityViolation` (`:15-26`): if there is more than one discount, every one must be combinable. The server **recomputes money**
  (`Compute`, `order.go` ~382-395). The client breakdown is stored raw (`discount_breakdown` jsonb). It has **no "best promo" selection anywhere**.
- **Tablet sales are always "offline" to the server.** The POS only enqueues to `/api/v1/sync/batch` (`packages/sync/src/engine.ts:1543`), which
  builds `CreateOrderInput{Offline: true}` (`backend/internal/sync/sync.go:~380`). The online 422 branch (`POST /orders`, `handlers/orders.go:87-93`)
  is never hit by a tablet sale. In practice "hybrid enforcement" means **record + `discount_warning`** for anything the POS gets wrong. That makes the
  POS validator (`apps/pos/src/cashier/promoValidate.ts`, a 1:1 port, shared golden fixtures) the only real-time guard.
- **POS applies promos one tap at a time.** `PromoPanel.tsx:122-128` lists `isActive && !codeOnly` promos with `validatePromo`. The per-card cart
  preconditions (`bxgyUnmet`, `bundleUnmet`) live inline in the panel (`:262-298`). The tap goes to `CashierScreen.tsx:567-577` `applySelection`, which calls
  `planPromotionFulfillment` (`promotionFulfillment.ts:61-130`). That returns `simple` / `toggle` (dispatch `APPLY_PROMOTION`), `ready` (dispatch
  `APPLY_FULFILLMENT`), or `bxgy-picker` / `bundle-picker` (opens the picker in the sheet). Exclusivity: an incoming non-combinable promo, or any
  exclusive one already applied, evicts the whole set (`cashierReducer.ts:502-516`, `promotionFulfillment.ts:35-42`, `evictAllForExclusive`).
- **Removal when a promo stops qualifying:** only *physical* promos (bundle, separate-set BXGY, key overlap) are removed reactively
  (`CashierScreen.tsx:633-635` -> `invalidPhysicalPromotionIds`). Percentage, fixed, tiered, BOGO and same-set BXGY promos that lapse stay in the cart until the pay-time
  `resolveConfirmGuard` (`confirmGuard.ts:130-139`, used at `CashierScreen.tsx:742-772` and by held/open-cart restore `heldRestore.ts:115-125`).
- **Customer attach** (`SET_CUSTOMER`, reducer `:401-421`) strips every reward line and drops bundle / separate-set BXGY promos, after a confirm
  (`customerAttachImpact.ts`). Promotions have **no customer rule** (only codes do), so attach/detach never changes a promotion's eligibility.
- **Held order / open-cart draft** (`heldOrders.ts:26-45`, `openCartDraft.ts`, OTA 2.6.0) store `promotions: {id,name}[]`, `codes`, `rewardPicks`.
  Restore (`planHeldRestore`) dispatches `CART_CLEAR`, re-prices, re-plans each promo through the planner, and runs the confirm guard.
- **Backoffice:** `PromotionsTab.tsx:94` subtitle "Diskon otomatis di kasir. ..." (misleading). The form is `PromoFormSlideOver.tsx` (`SwitchRow`, the
  `codeOnly` toggle at `:146` is the closest pattern). `promotionToInput` (`promotionForm.ts:56-80`) carries every field because the PUT rewrites
  every column (the past wipe bug). It is used by edit, duplicate (`duplicateInput :83`), the status Switch and undo. List badges: `PromotionsTable.tsx:41-44`.

## 1. Data model

**Migration** `backend/internal/db/migrations/0082_promo_auto_apply.sql` (or the next free number at merge; other branches may claim 0082):

```sql
-- 0082_promo_auto_apply.sql: a promotion marked auto_apply enters the POS cart on its own when it qualifies.
-- Default false = every existing promotion keeps today's manual "+ Tambah" behaviour.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS auto_apply boolean NOT NULL DEFAULT false;
```
This is a constant default, so the rewrite is metadata-only on PG 11+ (no table rewrite, short lock). No backfill.

**OpenAPI** `backend/api/openapi.yaml`: `autoApply: { type: boolean }` on `Promotion` (`:1522-1558`, next to `codeOnly :1544`) and on
`PromotionInput` (`:2760-2790`, next to `codeOnly :2781`). It is **optional and non-nullable**, exactly like `codeOnly`, so the codegen gate's approved-nullable list
is untouched. Regenerate `backend/internal/api/api.gen.go` (`cmd/codegen`, `-check` = drift gate; `scripts/ci/codegen_gate.py`) and
`packages/api/src/schema.d.ts` (`corepack pnpm --filter @mandalika/api gen`; `gen:check` in CI). No new top-level test in `internal/api` or
`internal/codegen`. If one is added, register it in `codegen_gate.py` CONTRACT/GUARD.

**Every SQL path (the SP-Promo-3a lesson: read JSON + INSERT + UPDATE, not just OpenAPI + form):**

| Path | File:line | Change |
|---|---|---|
| Read: backoffice full list, paged list, POS pull bundle | `backend/internal/read/promotions.go:11-25` `promotionObj` | add `'autoApply',auto_apply`. This one constant feeds `Repo.Promotions` (`:34-37`), `PromotionsPage` (`read/promotions_page.go:62`) and the sync pull (`internal/sync/pull.go:132`) |
| Write struct | `backend/internal/write/promotion.go:134-156` | `AutoApply *bool \`json:"autoApply"\`` (pointer: absent != false, see below) |
| INSERT | `write/promotion.go:201-211` | column `auto_apply`, `$22`, arg `COALESCE` semantics: `p.AutoApply` nil -> `false` (`COALESCE($22::boolean,false)`) |
| UPDATE | `write/promotion.go:258-268` | `auto_apply = COALESCE($22::boolean, auto_apply)`, `WHERE id=$23` |
| Validation | `write/promotion.go` `validatePromotionBasics` (~`:308-316`) | reject `autoApply && codeOnly` (400 "Promo khusus kode tidak bisa diterapkan otomatis.") **regardless of isActive** |
| Server resolve | `service/promo_resolve.go:107-118` `loadPromoSpec` | **no change**: the server never needs the flag (section 3) |
| Firestore import | `internal/fsmigrate/tables.go:159-193` | no change (it already omits `code_only`/configs; the DB default applies) |
| Preflight scan | `internal/promotionpreflight/scan.go:23` | no change |
| Test seeds enumerating columns | `handlers/*_integration_test.go` (5 files) | no change (DEFAULT covers them) |

**Why `*bool` + COALESCE (a deliberate deviation from "PUT rewrites every column").** `decodeWrite` uses `httpx.DecodeLoose`, so a body without
`autoApply` decodes fine. A plain `bool` would turn every PUT from a client that does not send the field (a backoffice tab cached before the
release, a script, the status Switch of an old bundle) into `auto_apply=false`. The flag would switch off silently, which is the same wipe class as the
`openEditPromo`/`promotionToInput` bug. With `*bool` and COALESCE, an absent field keeps the stored value, and an explicit `false` clears it. The new backoffice always sends it.

## 2. POS behaviour

### 2.1 Model: one pure reconcile, auto entries only

New pure module `apps/pos/src/cashier/autoPromos.ts`:

```
reconcileAutoPromos(state, ctx) -> { next: CashierState, changed: boolean, prompts: AutoPrompt[] }
ctx = { promotions, products /* displayProducts, stock-adjusted */, now, outletId, timezone }
```

- **Auto candidates** = promotions with `isActive && autoApply && !codeOnly`, not in `state.dismissedAutoPromotionIds`, not already applied
  manually.
- New state (`cashierReducer.ts` `CashierState`, `:22-80`):
  - `autoPromotionIds: string[]`: which applied promotions the reconcile installed.
  - `dismissedAutoPromotionIds: string[]`: auto promos the cashier removed for this sale.

  Both reset on `CART_CLEAR`, `RESET_SALE` and `CLOSE_SUCCESS`.
- **Base state:** take the current state and remove every *auto* entry's effect (`removePromotionEffect`, restoring bundles). Manual promos and codes are
  untouched. The reconcile computes the target set from this base every time, so the result depends only on what the cashier rang and chose, never on
  the order earlier auto installs happened in. That makes it idempotent: same inputs give the same target, so `changed=false`.
- **Dispatch:** one new reducer action `RECONCILE_AUTO_PROMOS { ctx }`. The reducer calls the pure function and swaps in `next` atomically: no
  intermediate render, and no loop of N `APPLY_PROMOTION`s that each trigger the eviction logic.
- **Trigger:** one effect in `CashierScreen.tsx`, keyed on a fingerprint of the *rung cart* (paid lines plus every bundle's moved units put back, the
  same projection `heldOrderFromState` uses), the manual promo and code ids, the dismissed set, the promotions snapshot version, and the minute. Installing
  auto promos never changes the rung cart (bundles move units, they don't add or remove them), so the effect cannot re-trigger itself.

  The effect is gated off while any of these hold:
  - the catalogue is not ready;
  - a picker is pending;
  - the success view is open;
  - a held / open-cart restore is running;
  - the customer-attach confirm is open;
  - split-tender lines are entered (the total is locked).

### 2.2 When an auto promo enters and leaves

- **Enters** as soon as it qualifies: gating (`validatePromo`) **and** the cart precondition. That precondition is the panel's `bxgyUnmet` / `bundleUnmet` /
  `promotionHasKeyOverlap`, which moves into a shared helper `promoEligibility.ts`. The panel and the reconcile both use it, so they cannot drift.
  The panel refactor is behaviour-preserving.
- **Evaluation order:**
  1. Plan physical auto promos (bundle, separate-set BXGY) first on the base, in a stable order.
  2. Gate the simple ones (percentage, fixed, tiered, BOGO, same-set BXGY) against the resulting cart. `minPurchase` uses that subtotal, which is the
     subtotal the server will see.
  3. If a simple promo's gate depends on a physical one that later loses the winner selection, re-gate once against the final set. That second pass is
     **remove-only**, so there are 2 passes at most. The result is always valid, never oscillates, and in rare chains may leave out a promo a cleverer search would have kept.
- **Leaves** automatically when it stops qualifying: item removed, quantity down, the outlet's active hours end (re-checked on the next cart change,
  on the minute in the fingerprint, and at confirm), or the promotion is deactivated by a sync pull. It comes back by itself if it qualifies again.
  This auto-removal covers **auto entries only**. Manual promos keep today's behaviour (physical ones reactive, the rest at the confirm guard), so a
  cashier-added promo never disappears under them mid-sale.
- **Customer attach/detach:** promotion eligibility is customer-independent. `SET_CUSTOMER` still strips reward lines and physical promos as today.
  The reconcile then re-installs the auto ones on the next run. `customerAttachImpact` must list only **manual** physical promos in its "will be removed"
  confirm, or the cashier is warned about promos that come straight back.

### 2.3 Cashier removes an auto promo

- The "×" on an auto promo (panel "Diterapkan" list and cart row) calls `REMOVE_PROMOTION`. When the id is in `autoPromotionIds`, the reducer also adds it to
  `dismissedAutoPromotionIds`. "Hapus semua" (`CLEAR_PROMOTIONS`) dismisses every auto entry.
- It **stays removed for this sale**: through cart edits, customer attach, hold/restore and app reload (section 2.6). It resets with a new sale.
- "+ Tambah" on a dismissed or not-chosen auto promo is a normal **manual** apply: the promo leaves the dismissed set and is treated as manual from then on.
- No PIN or permission gate (D-11). Removing a discount only raises the recorded total, so there is no cash-integrity risk to gate.
- When the confirm guard drops an auto promo because it lapsed, that is **not** a dismissal. It comes back if it qualifies again.

### 2.4 Interaction with manual promos, codes and `combinable`

**Manual always wins; an auto promo never evicts a cashier's choice:**
- If any manual promo or code is non-combinable, there are no auto promos (all held back, not dismissed).
- If manual entries exist and all are combinable, only combinable auto promos may join.
- Applying a manual non-combinable promo or code evicts the auto entries through the existing `evictAllForExclusive` path. They are not dismissed, and
  they come back when that manual discount is removed.

**Winner when several auto promos qualify** and nothing manual blocks them:
- The options are the set of all qualifying combinable auto promos (they stack), and each qualifying non-combinable auto promo on its own.
- The option with the **largest customer saving** wins.
- Ties go to the option whose earliest promotion has the oldest `createdAt`, then lowest `id`. This is deterministic across tablets on the same catalogue.

**Saving measure** (`autoSaving(option, base)`). This cannot be `calcPromoDiscount` alone, which is 0 for separate-set BXGY and bundles:
- the money discount from `computePricing(nextState).appliedPromoDiscountAmount`, after the existing manual+promo cap; plus
- for each separate-set BXGY reward line, `(catalogue full price - net) x qty`; plus
- for each bundle, the sum of `(fullPrice - net) x qty` over `bundleFreed`. This is the same figure the panel shows (`PromoPanel.tsx:141-146`).

**The server never picks.** It validates the submitted set exactly as today, so no new Go parity is needed for selection. Determinism matters
between tablets, not against Go. Two other rules still keep the reconcile consistent with Go:
- the reconcile's output must satisfy `combinabilityViolation`;
- the reconcile's output must pass `ValidatePromo`.

Both are covered by TS tests (section 6, S3) on top of the existing shared golden fixtures.

### 2.5 Promos that need a choice (pickers) and reward stock

- **Auto-install only when the planner returns `ready` with no choice needed:**
  - BXGY separate-set: exactly one reward option and `due === 1` (`promotionFulfillment.ts:117`);
  - bundle: no slot has more matching units than needed (`:81`).
- **The planner has no stock check, but the picker caps gifts at stock** (`BxgyRewardModal.tsx:64-74`, independent of `allowNegativeStock`). The auto
  path adds the same cap. It never auto-adds a BXGY gift whose variant has `stockFor(displayProducts) < due`. Bundle units are already in the cart, so they need no stock check.
- **When a choice or stock is missing,** the reconcile returns an `AutoPrompt` instead of installing. The cart shows one quiet row,
  "Promo {nama} berlaku · Pilih hadiah". Tapping it runs the existing `applySelection`, which opens the picker in the Promo sheet. **Never open a picker or
  sheet unprompted** while the cashier is scanning.
- A promo confirmed through a prompt counts as **manual** (the cashier chose the gift). From then on the existing reactive physical-removal path owns
  it, so the reconcile never has to remember a choice.

### 2.6 Held orders, open-cart draft (OTA 2.6.0), reload

- `HeldOrder` gains an **optional** `dismissedAutoPromotionIds?: string[]`. Neither `v: 1` nor `OPEN_CART_VERSION` is bumped: a bump drops every
  stored draft and breaks an OTA rollback. `isHeldOrder` / `isDraft` must keep accepting a missing field.
- `heldOrderFromState` stores **only manual** promotions in `promotions`. Auto entries are not stored, because they are recomputed after restore. An older bundle (rollback)
  reading such a draft simply restores the manual ones, which is correct, because the older bundle has no auto-apply.
- `planHeldRestore` dispatches `CART_CLEAR` first, which resets both new arrays. The restore must therefore set `dismissedAutoPromotionIds` **after** the clear
  (in the restore plan's final state), or a dismissed promo comes back.
- The effect is gated off while a restore runs. Once the restore commits, the reconcile runs on the rebuilt cart. Restore re-plans only manual promos,
  so the two can never install the same promo twice.
- `useOpenCartDraft` already rewrites the draft on applied-promo changes. Auto entries are excluded from the stored payload, so a reconcile does not
  churn the draft beyond the dismissed set.
- `autoPullGate.ts` counts applied promotions when deciding whether a catalogue swap may happen. Check whether auto entries should count. They are
  recomputed after a swap, so excluding them is likely right. The cart itself still blocks the swap.

### 2.7 Checkout

- `handleConfirmPayment` (`CashierScreen.tsx:728+`) runs the reconcile first. If it would change the auto set (hours ended, a promo was deactivated
  by a pull), it commits the change, toasts "Promo otomatis diperbarui, cek total." and returns. That is the same pattern as today's guard, so the cashier always
  confirms the total they saw.
- The existing guards (`invalidPhysicalPromotionIds`, `resolveConfirmGuard`, `breaksCombinableRule`) are unchanged. Auto entries satisfy them by
  construction, and they still catch manual ones.
- The payload is unchanged: `buildPromotionMetadata` sends `promotionIds` for manual and auto alike. No `auto` marker in v1 (decision 9).

### 2.8 Panel and cart copy (also closes the second half of P-21)

- An "Otomatis" tag (neutral, kit token) on auto entries in the panel "Diterapkan" list and on the cart promo row (`Cart.tsx:309-317`).
- Dismissed auto promos show in "Promo tersedia" as normal "+ Tambah" cards.
- A tiered promo shows one line: "Hemat Rp X · belanja Rp Y lagi untuk hemat Z%". This replaces the two unrelated fragments QA flagged.

## 3. Server

- **The server validates only, as today.** No change to `resolvePromos`, `ValidatePromo`, `Compute`, reward or bundle resolution, grants, or refunds. The
  server does not need to know a promo was auto-applied for correctness, money or stock. It must **not** force auto promos into an order, because the
  cashier may dismiss them.
- **Enforcement in practice:** tablets sync with `Offline: true`. If a POS bug ever submitted an invalid auto set, the order is recorded with
  `discount_warning` and `discount_warning_reason` (not_combinable, below_min_purchase, ...), exactly as for manual promos. The online 422 path is
  unreachable from a tablet sale.
- **Parity:** no Go engine change, so `promo_parity_golden.json` (21 cases), `promo_timezone_vectors.json` and the linked-tier golden stay as they are and
  must stay green. New coverage is TS-side (S3).
- **Write path:** the `autoApply && codeOnly` rejection lives in `validatePromotionBasics` and is mirrored in the backoffice `promotionProblems`.
- **Audit marker (deferred, decision 9):** if the owner later wants "auto vs manual" in reports, add an optional `auto?: boolean` to
  `DiscountComponent` (`openapi.yaml:1778-1785`). It must go into OpenAPI because the typed order read drops unknown keys, even though the jsonb stores
  them raw. Set it in `buildPromotionMetadata`. No migration is needed: the breakdown is jsonb. `promo_reward_grants` would need its own column.

## 4. Backoffice UX

- **Toggle** in `PromoFormSlideOver.tsx`, section "Lokasi dan ketentuan" (`:138-154`, next to `codeOnly :146`), using the existing `SwitchRow`:
  - label "Terapkan otomatis di kasir";
  - hint "Masuk ke keranjang sendiri saat syaratnya terpenuhi. Kasir tetap bisa menghapusnya untuk satu transaksi.";
  - disabled while `codeOnly` is on, with hint "Tidak bisa untuk promo khusus kode.". Turning `codeOnly` on also turns `autoApply` off.
- **Form plumbing:**
  - `EMPTY_PROMO` gets `autoApply: false` (`promotionForm.ts:44-48`);
  - `promotionToInput` gets `autoApply: p.autoApply ?? false` (`:56-80`); this one place covers edit, duplicate, the status Switch and undo;
  - `promotionProblems` (`:152-168`) gets the `autoApply && codeOnly` rule.
- **Duplicate** (`duplicateInput`) keeps `autoApply`. The copy is forced inactive (D-79), so it cannot reach tablets unasked.
- **List indicator:** `<Badge tone="gold">Otomatis</Badge>` in the name-column badge row (`PromotionsTable.tsx:41-44`, beside "Bisa Kombinasi" /
  "Hanya kode"). Add an "Otomatis" Ya/Tidak column to the CSV/XLSX export (`promoDisplay.ts:40-51`).
- **Fix the copy** at `PromotionsTab.tsx:94`: "Promo bertanda Otomatis langsung masuk ke keranjang kasir saat syaratnya terpenuhi; promo lain
  ditambahkan kasir lewat panel Promo. Perubahan dipakai tablet setelah sinkron berikutnya."

## 5. Receipt and reports

- **Receipt (screen + ESC/POS):** no change. An auto promo prints exactly like a manual one: one line "- {nama promo} -Rp X" (`receiptRows.ts:24-47`,
  `packages/printer/src/escpos.ts:217-223`). The customer cares about the discount, not how it got there.
- **Reports:** no change in v1.
  - "Hadiah Promo" (`promo_reward_grants`) and "Kode Diskon" cannot tell auto from manual, and nothing needs them to.
  - The Ringkasan promo tally (by label) counts auto promos like manual ones.
  - If the owner wants the split, see the deferred marker in section 3.

## 6. Slices

Release order is **backend, then Cloudflare, then OTA**, and any order is safe:
- the field is optional;
- an older POS bundle reads `autoApply` as undefined, which means false, so it stays manual exactly as today;
- an older backoffice omits the field, which COALESCE keeps.

The owner turns promos to Otomatis **after the fleet reports 2.7.0**. A tablet still on 2.6.x keeps the manual flow.

| Slice | Scope | Files | Tests | Review | Release | APK |
|---|---|---|---|---|---|---|
| **S1 contract + backend** | migration 0082; OpenAPI `autoApply` on Promotion + PromotionInput; regenerate Go + TS types; `promotionObj`; write `*bool` + INSERT/UPDATE COALESCE; `autoApply && codeOnly` -> 400 | `db/migrations/0082_promo_auto_apply.sql`, `api/openapi.yaml`, `internal/api/api.gen.go`, `packages/api/src/schema.d.ts`, `read/promotions.go`, `write/promotion.go` | write unit test (`codeOnly` conflict); Postgres integration (register in `scripts/ci/postgres_gate.py`, free port): create with true -> GET `/promotions` and the sync pull bundle carry `autoApply:true`; PUT without the field keeps true; PUT false clears; codegen gate | Opus `reviewer` (generated types, migration) | backend deploy (migration 0082), smokes | no |
| **S2 backoffice** | toggle + hint + `codeOnly` coupling; `EMPTY_PROMO`, `promotionToInput`, `promotionProblems`; "Otomatis" badge; export column; subtitle copy | `screens/promotions/{PromoFormSlideOver.tsx, promotionForm.ts, PromotionsTable.tsx, PromotionsTab.tsx, promoDisplay.ts}` | `promotionRoundTrip.test.ts` (add `autoApply` to the key list `:10`, round-trip true/false); `useStatusToggle.test.ts` fixture; `promotionProblems` conflict test | Opus `reviewer` (short: full-body PUT round-trip, the wipe class) | Cloudflare after S1 is live | no |
| **S3 POS engine (pure, no UI)** | extract `promoEligibility.ts` from `PromoPanel.tsx:262-298` (panel uses it, same behaviour); `autoPromos.ts` reconcile: candidates, base, evaluation order, winner, `autoSaving`, stock cap, prompts | `cashier/promoEligibility.ts`, `cashier/autoPromos.ts`, `cashier/PromoPanel.tsx` (refactor only) | unit: idempotence (`reconcile(reconcile(s)).changed === false`); manual-wins (exclusive manual -> no auto; combinable manual -> only combinable auto); winner by saving incl. BXGY / bundle value; tie-break; picker-needed -> prompt; stock 0 -> prompt; min-purchase chain settles in 2 passes; every output passes `validatePromo` + combinability; the panel's eligibility is unchanged (existing PromoSheet / reducer tests) | Opus `reviewer` (pricing, stock) | merges anytime after S1 (needs the regenerated type); ships inside S4's OTA | no |
| **S4 POS wiring + UI** | state fields + `RECONCILE_AUTO_PROMOS`; REMOVE / CLEAR dismiss semantics; manual add un-dismisses; effect + gates; confirm-time reconcile; held / draft optional field + restore ordering; `customerAttachImpact` manual-only; "Otomatis" tags; prompt row; tiered one-liner; `autoPullGate` check | `state/cashierReducer.ts`, `CashierScreen.tsx`, `PromoPanel.tsx`, `Cart.tsx`, `heldOrders.ts`, `heldRestore.ts`, `openCartDraft.ts`, `useOpenCartDraft.ts`, `customerAttachImpact.ts`, `autoPullGate.ts` | reducer: dismiss / un-dismiss / reset; heldRestore + openCartDraft: dismissed survives restore, auto not stored, old draft without the field restores; customerAttachImpact; confirm-time change returns without paying; browser gate: add item -> auto promo row appears, × -> stays gone after qty change and reload | Opus `reviewer` (sync payload, stock, optimistic cart, draft persistence) | POS OTA 2.7.0 after S2; journal ACK (no journal-adjacent file expected to change) | no (web layer only) |

S1 then S2 is a strict chain. S3 can be built beside S2 (branch off S1). S4 stacks on S3. Implementation: Sonnet `implementer`; review per the table.
Live check after OTA: one Otomatis percentage promo + one Otomatis exclusive promo on the test outlet. Add, remove and hold a cart on a tablet, sync, then confirm
`discount_warning=false` on the orders (read-only Neon check).

## 7. Owner decisions (recommended default in bold; none block S1/S2)

1. **Winner** among several qualifying non-combinable auto promos: **the biggest saving for the customer; ties go to the older promo.** All
   qualifying combinable auto promos count as one option and stack.
2. **The cashier can remove an auto promo for this sale (×), with no PIN, and it stays removed** for that sale, including hold/restore and reload. "+ Tambah" brings it back.
3. **Manual wins:** a cashier's exclusive promo or code holds the auto ones back. They return when the manual one is removed. An auto promo never
   replaces something the cashier chose.
4. **BXGY / bundle that needs a choice (several gifts, gift qty > 1, extra bundle items): do not auto-pick.** Show a "Pilih hadiah" row in the cart
   that opens the picker. A single gift with qty 1, or an exact bundle, is applied automatically.
5. **Auto gift only when the gift variant is in stock** (like the picker), even if negative stock is allowed. Otherwise show the "Pilih hadiah" row.
6. **An auto promo that stops qualifying leaves the cart immediately** and returns if it qualifies again. Manual promos keep today's behaviour
   (removed at pay time).
7. **"Hanya via kode" and "Otomatis" cannot both be on** (the form disables it; the server refuses).
8. **Receipt and reports unchanged:** the promo prints and counts the same whether auto or manual. The POS screen shows an "Otomatis" tag.
9. **No "auto vs manual" marker on orders in v1.** It is cheap to add later (OpenAPI + breakdown flag, no migration) if a report needs it.
10. **Rollout:** turn promos to Otomatis only after every tablet runs 2.7.0. Older tablets keep the manual flow for that promo.
