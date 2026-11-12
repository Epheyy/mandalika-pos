# Bundles (POS flow, Backoffice settings, Diskon Bundle, reports) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell the automatic three-piece bundle (large bottle + 10ml atomizer + 2ml vial of the same line) with one tap on the POS, with prices set once in the Backoffice, a "Diskon Bundle" promotion type, ERP lines that add up to the bundle price, whole-bundle refunds and bundle reports.

**Architecture:** Go derives the bundle catalog from the variants (size parsed from the label, line from `erp_category` through `erpmap.Line`) and the new `bundle_prices` table. It serves the catalog to the Backoffice and, inside the existing `/sync/pull`, to the tablets. A bundle in a sale is three ordinary order lines, qty 1 each, tied by a per-order `bundleGroup` number. Both pricing twins reprice the pieces to their share of (bundle price − Diskon Bundle), the line repricing that Paket Bundel and BXGY rewards already use. The ERP payload, stock loop and refund engine therefore need no logic change: the refund engine only gets a new `set:<n>` refund group.

**Tech Stack:** Go 1.26.11 (pgx, chi, oapi-codegen), PostgreSQL, OpenAPI 3 → openapi-typescript, React + Vite (POS on Capacitor, Backoffice), vitest.

**Spec:** `docs/plans/2026-11-12-bundles-design.md` (owner-approved 2026-11-12). Mockups: `docs/plans/2026-11-12-bundles-mockups/` (`bundle-cards.html`, `bundle-backoffice.html`; cart = option Y in `bundle-cart.html`).

## Design deviations found (code vs design)

1. **Price authority.** Tablets send every sale through `/sync/batch` with `Offline: true` (`backend/internal/sync/sync.go:396`). Single-item unit prices are honoured as captured, with no catalog check (`service/order_input.go:69-77`, "never today's catalog price"). Only direct `POST /orders` runs with `Offline: false` (`handlers/orders.go:93`).
   - **Resolution:**
     - The server is authoritative for a bundle's structure (roles, same line, active variants), the Diskon Bundle amount and the split.
     - The bundle list price follows the product-price rule: a tablet sale keeps the price it sent.
     - When that price differs from today's setting, the sale is flagged with `discount_warning` reason `bundle_price_changed`.
     - Direct `POST /orders` with a stale price gets 422, the same path where Paket Bundel gets "Bundel tidak valid".
2. **No size column.** `product_variants` has no numeric size, only the label (`size`, e.g. "120ml EXTRAIT DE PARFUM"). `erp_category` is never exposed to the POS (`read/catalog.go` `productObjScoped`).
   - **Resolution:**
     - Size is parsed from the label with `^\s*(\d+)\s*ml\b` (case-insensitive). The line comes from `erp_category`.
     - Go derives everything. The POS receives the derived catalog (offers plus each piece's role and line) and never derives anything itself.
3. **`lineSizes.ts` does not group by ERP line.** It is the cart line's size switch for one product (`apps/pos/src/cashier/lineSizes.ts:15`).
   - **Resolution:** line grouping comes from the server catalog. `lineSizes.ts` changes only so it refuses a size switch on a bundle piece.
4. **`isBundle` / `order_items.is_bundle` is taken.** It marks the legacy stock-less Firestore bundle header, and several places treat such lines differently:
   - inventory reports exclude them (`read/inventory.go:313,326,332`);
   - the sale stock exception skips them (`service/order.go:535`);
   - refund restock skips them (`service/refund.go:282`).
   - **Resolution:** pieces never set `isBundle`. New fields and columns are used instead.
5. **No discount prints under a receipt line today.** Discounts are order-level rows only (`packages/printer/src/escpos.ts:206-224`).
   - **Resolution:**
     - Add `pieces` and `lineDiscount` to `ReceiptLine`.
     - Keep the receipt snapshot at one line per cart line, with optional bundle fields and **no version bump**. `localReceipts.ts:40` accepts only `v` 1 or 2, and local refunds align `lineNets` per cart line (`localReceipts.ts:70`).
     - Collapse a bundle into one printed line only when `ReceiptData` is built.
6. **"Bundle can't be completed" vs the singles stock rule.** Singles never block: `overstockLines` only warns (`cashier/stock.ts:33-60`), and an out-of-stock tile still adds with `OVERSELL_WARNING`.
   - **Resolution:** decision O1 below.
   - The plan implements the singles rule: an out-of-stock 10ml or 2ml with no in-stock swap stays in the bundle with the oversell warning.
   - The "Habis" bundle button is disabled, as the mockup says ("can't be tapped").
7. **Rp0 ERP lines under a deep Diskon Bundle.** A large discount could floor a small piece's share to Rp0, which is an anti-goal.
   - **Resolution:** the discount is clamped so every piece keeps at least Rp1 (`MinNet`, Task 2.1). Percentage values must be 1–99.

## Open owner decisions (defaults built unless the owner says otherwise)

- **O1, stock.**
  - **Large bottle at 0 or less:** the bundle button shows "Habis" and is disabled. The large bottle can still be sold as a single.
  - **10ml/2ml at 0 or less:** the swap list opens on its own. The out-of-stock piece stays selectable as "Habis · stok akan minus", and the bundle adds with `OVERSELL_WARNING`, the same rule as singles.
- **O2, Diskon Bundle bounds:** percent 1–99. A rupiah amount is clamped per bundle to `price − MinNet`.

## Phases and release order

Each phase is one branch and one PR off `prod-hardening`. Release is backend first. `OrderItem.UnmarshalJSON` ignores unknown fields, so a Phase 3 tablet against an older server would store pieces as loose lines with no refund group.

| Phase | Branch | Ships | Migration |
|---|---|---|---|
| 1 | `feat/bundles-1-settings` | backend + Backoffice | 0089 |
| 2 | `feat/bundles-2-sale-server` | backend | 0090 |
| 3 | `feat/bundles-3-pos` | POS OTA (web only) + Go test harness | — |
| 4 | `feat/bundles-4-diskon` | backend + Backoffice + POS OTA | 0091 |
| 5 | `feat/bundles-5-reports` | backend + Backoffice | — |

**Why Phase 2 and Phase 3 are separate PRs** (the brief suggested one "POS selling" slice):
- The server must be live before any tablet sends bundle fields.
- Phase 3 is the large UI slice and earns its own review.

**Ordering rules:**
- Phases 4 and 5 may run in parallel after Phase 3.
- If a migration number is taken at merge time, renumber it in the same PR. HANDOFF has the 0082→0083 precedent.
- **Release note for Phase 4:** create Diskon Bundles only after every tablet runs the Phase 4 OTA. An older tablet would not reprice the pieces, and its quote would disagree with the server.

## Global Constraints

- **Migrations:**
  - 0089 (Phase 1), 0090 (Phase 2), 0091 (Phase 4). Each starts with `SET LOCAL lock_timeout = '5s';`.
  - Non-destructive. `bundles`, `bundle_items`, `GET /api/v1/bundles` and `api.listBundles` stay, unused by the UI.
- **Large size:**
  - Any size with a standard bundle price.
  - The size key matches `^[0-9]+ml$` ("100ml", "110ml", "120ml").
  - A line price needs the standard price of the same size.
- **Line allowlist:**
  - `erp_category` (spaces collapsed, upper-cased) `EXT` → line `EXTRAIT DE PARFUM`, label `Extrait`, short `EXT`.
  - `PERFUME INTENSE` → line `PARFUM INTENSE`, label `Parfum Intense`, short `PI`.
- **Atomizer:**
  - Size `10ml` and category `ATOMIZER`. The atomizer has no line.
- **Vial:**
  - Size `2ml` and an allowlisted line.
- **Never a piece:**
  - Any other category: `DISPLAY …`, `HAMPER(S) …`, `GLITTER`, `LEATHER`, `GLASS …`.
  - 15ml.
  - Inactive variants.
  - Variants with a single price ≤ 0.
- **No ERP data** is decided on the ERP link (`product_variants.erp_slug IS NULL`, migration 0066), never on `erp_category`. Migration 0068 also stores NULL for an ERP-linked item whose category is blank (`0068_erp_variant_source.sql:8`).
  - An **unlinked** variant (the test catalog) is classified by the size in its label alone, with line `""`.
  - A **linked** variant whose category is blank, or is not ATOMIZER or an allowlisted line, is never a piece.
  - A bundle with line `""` uses the standard price.
- **One bundle instance:**
  - Three sale lines, roles `large`, `atomizer` and `vial`, each `quantity: 1`, sharing one `bundleGroup` (1..32767, unique per order).
  - Never merged with singles or with another bundle.
  - Pieces never carry `isBundle` or `isReward`.
- **Split** (both twins, integer rupiah):
  - `net = price − discount`.
  - Atomizer share = `floor(net·pA/S)`, vial share = `floor(net·pV/S)`, large share = `net − atomizer − vial`.
  - `S = pL+pA+pV` are the pieces' single prices (basis), every one > 0.
  - The discount is split the same way.
- **`MinNet(basis)`** = `max(ceil(S/pA), ceil(S/pV))`.
  - The Diskon Bundle discount is clamped to `price − MinNet`.
  - `priceSetBundle` rejects any group whose `price − discount < MinNet(basis)`, even with no discount.
  - So no piece ever reaches the ERP at Rp0.
- **Split basis:**
  - The single price the tablet showed when the piece entered the cart (`bundleBasisPrice`).
  - The server uses it when > 0. Otherwise it uses `COALESCE(outlet_variant_price.price, product_variants.price)` (the catalog basis).
  - When the client basis fails the `MinNet` rule:
    - online: `bundle_invalid`;
    - offline: the server falls back to the catalog basis and flags `bundle_basis_replaced`. If the catalog basis fails too, the bundle is `bundle_invalid` (kept and flagged).
- **Refund group key** for a bundle: `set:<bundleGroup>` (both twins). The existing whole-group rule then applies unchanged.
- **Product-keyed promotions never see a piece**, either to qualify or as a reward:
  - scoped percent/fixed, BOGO, BXGY (same-set and separate-set);
  - Paket Bundel paid lines;
  - `paidLineInGroup`.
- **Cart-wide discounts** (unscoped percent/fixed, tiered, manual, codes, points) use the subtotal, which already holds the repriced pieces.
- **OpenAPI:**
  - New properties are optional and **not** `nullable`.
  - Never `nullable` on a `$ref`, except by copying the existing `allOf` + `nullable` pattern for promotion configs.
  - Run `corepack pnpm gen:check` and `cd backend && make gen-check`.
  - Add no top-level test in `backend/internal/api` or `backend/internal/codegen`. If unavoidable, add it to `scripts/ci/codegen_gate.py` `CONTRACT`/`GUARD`.
- **Postgres gate:**
  - One new gate `TestBundlesPostgres` (prefix `BN`, port 26481), created in Task 1.2. Later phases add subtests to it.
  - The port range 26439-26480 becomes 26439-26481 in `scripts/ci/postgres_gate.py` (`GATES`), `.github/workflows/postgres.yml` (lines 51 and 53), `scripts/ci/runner-provision.sh:33` and `scripts/ci/README.md` (lines 13 and 102).
  - The self-hosted runner needs its sysctl re-applied, which is an owner/infra step.
- **Dependencies:** no `package.json` change is planned. If one happens, ship `pnpm-lock.yaml`.
- **POS look:** "Kertas & Emas" (`docs/plans/2026-10-27-pos-ux-direction.md`). No dark theme, no discount gate.
  - Visual tasks render the mockups and compare them side by side with the build before the PR.
- **Copy** (exact):

  | Where | Text |
  |---|---|
  | Card button | `Bundle EXT 120ml` with price `Rp 850.000` and subline `120ml + atomizer 10ml + 2ml` |
  | Card button, line `""` | `Bundle 110ml` |
  | Card, 3+ bundles | `Bundle · 4 pilihan` with `mulai Rp 650.000` |
  | Card | `Satuan (pilih ukuran)` and `Habis` |
  | Swap sheets | `Ganti atomizer 10ml`, `Ganti 2ml Extrait` (line `""`: `Ganti 2ml`) |
  | Swap button | `Ganti` |
  | Refund header | `Bundle (refund bersama)` |
  | Missing reasons | `atomizer belum ada`, `2ml Extrait belum ada` (line `""`: `2ml belum ada`) |
  | Violation `bundle_price_changed` | `Harga bundle sudah berubah. Tunggu katalog tersinkron lalu ulangi.` |
  | Receipt line name | `<fragrance> · Bundle EXT 120ml` |
  | Receipt line discount label | the promotion name, or `Diskon Bundle` when unknown |

- **Reviewer tiers** (AGENTS.md): each task names its tier.
  - **Opus 5.5 high** reviews anything touching pricing, stock, sync/outbox, refunds, auth or generated types.
  - **Sonnet 5.5 medium** implements every task.
- **Never:**
  - weaken a stock, sync, outbox or refund guard;
  - change `backend/internal/integration/erp/payload.go`;
  - auto-merge customers;
  - commit secrets.

## Review Focus

1. **A tablet sells offline with a stale bundle price.** The synced sale keeps the tablet's price and total, and the pieces split from it. The order is flagged `bundle_price_changed`. It is never rejected or dropped.
   - Tests: `TestPriceSetBundleStalePriceOfflineKeepsClientPrice` (Task 2.3), Postgres subtest `sale_stale_price_offline` (Task 2.5).
2. **A swapped piece's single price is 0 or missing.**
   - Such a variant is not a piece, so the server rejects the group (keep + flag offline).
   - The POS never lists it in the swap sheet. Basis falls back from client to catalog price, and a basis ≤ 0 never reaches the split.
   - Tests: `TestSplitRejectsNonPositiveBasis` (2.1), `TestPriceSetBundleZeroPricePieceInvalid` and `TestPriceSetBundleShareNeverZero` (2.3), `swapCandidates excludes zero-price variants` (3.1).
3. **A fragrance loses its 2ml mid-shift.**
   - A tablet with the old catalog still sells the bundle. The server finds the vial inactive: online gets 422 `bundle_invalid`; a synced sale is kept, flagged and still refund-grouped.
   - The next pull drops the offer.
   - Tests: `TestPriceSetBundleInactiveVialInvalid` (2.3), `TestDeriveDropsOfferWhenVialInactive` (1.1).
4. **Two Diskon Bundles plus a non-combinable code.**
   - Server: the gate fires (422 online, flag offline).
   - POS: auto-apply installs neither Diskon Bundle while the exclusive code is applied. Without the code, each bundle takes only the bigger discount.
   - Tests: `TestResolvePromosBundleDiscountNotCombinable` (4.2), `reconcileAutoPromos holds Diskon Bundle back behind an exclusive code` (4.3), golden `two_promos_bigger_wins` (4.2).
5. **One piece of a bundle is refunded.** Refused on the server (`ErrRefundGroupSplit`) and locked on the POS (`lineLockReason`).
   - Tests: `TestPlanRefundSetBundleWholeOnly` (2.4), `refundSelection selects the whole bundle` (3.2), Postgres subtest `refund_one_piece_refused` (2.5).
6. **Test-catalog variants "110ml"/"10ml"/"2ml" with no ERP link (`erp_slug` NULL).** They form one bundle, line `""`, at the standard price. Line prices never apply to them. An ERP-linked variant with a blank category is never a piece (`TestClassify`).
   - Tests: `TestDeriveTestCatalogNoErp` (1.1), `TestPriceSetBundleNoLineUsesStandard` (2.3).

---

## Phase 1: Bundle settings, derived catalog, Backoffice tab

### Task 1.1: Pure bundle derivation package (Go)

Reviewer: Opus high (pricing source of truth).

**Files:**
- Create: `backend/internal/bundles/bundles.go`, `backend/internal/bundles/derive.go`
- Test: `backend/internal/bundles/derive_test.go`

**Interfaces:**
- Produces (package `bundles`):
  - `type Role string`; `const RoleLarge Role = "large"`, `RoleAtomizer Role = "atomizer"`, `RoleVial Role = "vial"`.
  - `func ParseSizeML(label string) (size string, ok bool)` returns `"120ml"` for `"120ml EXTRAIT DE PARFUM"` and `"2ml"` for `" 2 ML"`. Returns `ok=false` for `"Satuan"` or `""`.
  - `func LineOf(category string) (line string, ok bool)` implements the allowlist. It collapses spaces, upper-cases, then calls `erpmap.Line` for `EXT` or `PERFUME INTENSE` only.
  - `func LineInfo(line string) (label, short string)`: `("Extrait","EXT")`, `("Parfum Intense","PI")`, and `("","")` for `""`.
  - `type Variant struct { ProductID, ProductName, Label, ErpCategory string; ErpLinked bool; Price float64; Active bool }`.
    - `Label` is `product_variants.size`, the variant label.
    - `ErpLinked` is `erp_slug IS NOT NULL`.
    - An empty `ErpCategory` on a linked variant means "not a piece". It never means "no ERP data".
  - `type Prices struct { Standard map[string]float64; Lines map[string]map[string]float64 }` (line → size → price).
  - `func (p Prices) PriceFor(line, size string) (float64, bool)` returns false when there is no standard price for `size`. A line price overrides the standard one.
  - `func (p Prices) LargeSizes() []string` sorts by numeric value.
  - `type Piece struct { ProductID, VariantSize string; Role Role; Line, Size string }`
  - `func Classify(v Variant, p Prices) (Piece, bool)` implements the Global Constraints rules.
  - `type Offer struct { Line, Size string; Price float64; LargeSize, AtomizerSize, VialSize string }`. The `*Size` fields are variant labels inside the same product.
  - `type Missing struct { Line, Size, Reason, Text string }`. Reason is `"no_atomizer"` or `"no_vial"`.
  - `type ProductBundles struct { ProductID, ProductName string; Offers []Offer; Missing []Missing }`
  - `type Catalog struct { Lines []string; Products []ProductBundles; Pieces []Piece }`
  - `func Derive(vs []Variant, p Prices) Catalog`:
    - `Products` lists products with at least one large piece, sorted by name.
    - `Offers` sort by size number, then line short (`""` first).
    - `Lines` holds the distinct lines of large pieces, sorted.
    - When a product has several atomizers or vials, the first by variant label is used.

- [ ] **Step 1: Write the failing tests** (table-driven):

```go
func TestParseSizeML(t *testing.T)            // "120ml EXTRAIT DE PARFUM"→"120ml"; "110ml"→"110ml"; "10ml ATOMIZER"→"10ml"; "Satuan"→!ok; "ml"→!ok
func TestClassify(t *testing.T)               // 120ml EXT → {large,"EXTRAIT DE PARFUM","120ml"}; 2ml PERFUME INTENSE → vial PI; 10ml ATOMIZER → atomizer line "";
                                              // DISPLAY EXT 120ml → !ok; HAMPERS EXT → !ok; GLITTER 100ml → !ok; 15ml EXT → !ok; 130ml EXT (no standard) → !ok;
                                              // price 0 → !ok; inactive → !ok; unlinked "110ml" → large line ""; unlinked "10ml" → atomizer; unlinked "2ml" → vial line "";
                                              // ErpLinked=true with blank category "120ml EXTRAIT DE PARFUM" → !ok; ErpLinked=true blank "10ml" → !ok
func TestDeriveChampion(t *testing.T)         // EXT120, PI120, A10, EXT2, PI2; standard 120ml=795000, EXT 120ml=850000 →
                                              // Offers [{EXT 120ml 850000}, {PI 120ml 795000}], Missing empty
func TestDerive24HoursFourOffers(t *testing.T)// EXT100/PI100/EXT120/PI120 + A10 + EXT2 + PI2 → 4 offers, order: EXT 100ml, PI 100ml, EXT 120ml, PI 120ml
func TestDeriveMissingReasons(t *testing.T)   // EXT120+PI120+A10+EXT2 → PI 120ml Missing{no_vial,"2ml Parfum Intense belum ada"}; no A10 → every large gets {no_atomizer,"atomizer belum ada"}
func TestDeriveUpgrade110To120(t *testing.T)  // EXT110 + EXT120 + A10 + EXT2 → two offers 110ml, 120ml
func TestDeriveTestCatalogNoErp(t *testing.T) // unlinked "110ml","10ml","2ml", standard 110ml=725000, EXT 110ml=999000 → one offer {Line:"",Size:"110ml",Price:725000}
func TestDeriveDropsOfferWhenVialInactive(t *testing.T) // EXT2 inactive → Offer gone, Missing no_vial
func TestPiecesListEveryClassifiedVariant(t *testing.T) // Pieces contains each large/atomizer/vial once, with role+line
```

- [ ] **Step 2: Run** `cd backend && go test ./internal/bundles/...`. Expected: FAIL (package missing).
- [ ] **Step 3: Implement** the signatures above. Size key ordering uses the parsed integer.
- [ ] **Step 4: Run** `cd backend && go test ./internal/bundles/... && go vet ./internal/bundles/...`. Expected: PASS.
- [ ] **Step 5: Commit** `git add backend/internal/bundles && git commit -m "feat: derive bundle catalog from ERP variants"`

### Task 1.2: `bundle_prices` table, settings and catalog API, sync pull field

Reviewer: Opus high (sync pull, generated types, auth gating).

**Files:**
- Create: `backend/internal/db/migrations/0089_bundle_prices.sql`, `backend/internal/bundles/load.go`, `backend/internal/read/bundles.go`, `backend/internal/write/bundles.go`, `backend/internal/handlers/bundles.go`, `backend/internal/handlers/bundles_integration_test.go`
- Modify:
  - `backend/api/openapi.yaml` (schemas near `BundleConfig` :1515; paths near `/api/v1/settings/app` :5827 and `listBundles` :3911; `SyncPullBundle` :2435)
  - `backend/internal/api/api.gen.go` (generated) and `packages/api/src/schema.d.ts` (generated)
  - `packages/api/src/client.ts` (next to `listBundles` :295/:809)
  - `backend/internal/server/server.go` (auth group :165-173; `manage_products` group :224-236)
  - `backend/internal/sync/pull.go` (`PullBundle` :59, `Pull` :84)
  - `scripts/ci/postgres_gate.py`, `.github/workflows/postgres.yml`, `scripts/ci/runner-provision.sh`, `scripts/ci/README.md` (port 26481, Global Constraints)
- Test: `backend/internal/write/bundles_test.go`, `backend/internal/handlers/bundles_integration_test.go`

**Interfaces:**
- Consumes: Task 1.1 `bundles.Derive`, `bundles.Prices`, `bundles.Variant`, `bundles.LineInfo`.
- **Produces, migration 0089:**
  - `CREATE TABLE bundle_prices (line text NOT NULL DEFAULT '', size text NOT NULL CHECK (size ~ '^[0-9]+ml$'), price numeric(14,2) NOT NULL CHECK (price > 0 AND price = trunc(price)), updated_at timestamptz NOT NULL DEFAULT now(), updated_by text, PRIMARY KEY (line, size))`
  - `line = ''` holds the standard price.
- **Produces, Go:**
  - `bundles.LoadPrices(ctx context.Context, q Querier) (Prices, error)`, with `type Querier interface { Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) }`.
  - `(r *read.Repo) BundleSettings(ctx) (api.BundleSettings, error)`.
  - `(r *read.Repo) BundleCatalog(ctx, sc read.Scope) (api.BundleCatalog, error)`. It loads variants (`size` as `Label`, `COALESCE(erp_category,'')`, `erp_slug IS NOT NULL` as `ErpLinked`, outlet price, `is_active`) with the same filter as the tablet pull (`tabletVariantFilter` when `sc.SellableOnly`) and active products.
  - `write.BundleSettingsInput{ Standard []BundlePriceIn; LinePrices []BundleLinePriceIn }`.
  - `func validateBundleSettings(in BundleSettingsInput, knownLines []string) error`.
  - `(r *write.Repo) UpdateBundleSettings(ctx, userID string, in BundleSettingsInput) error`, inside `r.tx(ctx, "bundle_prices", …)`. It replaces all rows (DELETE + INSERT), so `bumpVersion` fires.
  - Handlers: `GetBundleSettings`, `UpdateBundleSettings` (pattern of `UpdateAppSettings`: `httpx.DecodeLoose` + `h.mutated`) and `GetBundleCatalog` (pattern of `AppSettings`: `h.cached`).
  - `PullBundle.BundleCatalog *api.BundleCatalog \`json:"bundleCatalog,omitempty"\``.
- **Produces, routes:**
  - `GET /settings/bundles` and `GET /bundles/catalog` in the RequireAuth group.
  - `PUT /settings/bundles` in the `manage_products` group.
- **Produces, OpenAPI schemas** (all properties required unless noted, none nullable):
  - `BundlePriceEntry {size, price}`
  - `BundleLinePriceEntry {line, size, price}`
  - `BundleLine {line, label, short}`
  - `BundleSettings {standard: BundlePriceEntry[], linePrices: BundleLinePriceEntry[], lines: BundleLine[]}`
  - `BundleSettingsInput {standard, linePrices}`
  - `BundleSettingsResponse {data}`
  - `BundleOffer {line, lineLabel, lineShort, size, price, largeVariantSize, atomizerVariantSize, vialVariantSize}`
  - `BundleMissing {line, size, reason: enum [no_atomizer, no_vial], text}`
  - `BundleCatalogProduct {productId, productName, offers: BundleOffer[], missing: BundleMissing[]}`
  - `BundlePiece {productId, variantSize, role: enum [large, atomizer, vial], line, size}`
  - `BundleCatalog {lines: BundleLine[], products: BundleCatalogProduct[], pieces: BundlePiece[]}`
  - `BundleCatalogResponse {data}`
  - `SyncPullBundle.bundleCatalog: $ref BundleCatalog` (optional; absent on older servers).
  - OperationIds: `getBundleSettings`, `updateBundleSettings`, `getBundleCatalog`.
- **Produces, TS client** (`packages/api/src/client.ts`): `getBundleSettings(): Promise<BundleSettingsResponse>`, `updateBundleSettings(body: BundleSettingsInput)`, `getBundleCatalog(): Promise<BundleCatalogResponse>`.
- **Validation copy** (400):
  - `Ukuran harus seperti 120ml`
  - `Harga bundle harus bilangan bulat > 0`
  - `Harga lini <size> butuh harga standar <size>`
  - `Lini tidak dikenal: <line>` (line not in the allowlist)
  - `Ukuran <size> dobel`

- **Cache note:** `GET /bundles/catalog` uses `h.cached` like `Products`. It is invalidated by any handler write. It has the same staleness exposure as the product list for catalog changes that bypass handlers (the ERP import). No new invalidation is planned; say so in the PR.

- [ ] **Step 0: Prerequisite, the CI runner.**
  - `postgres.yml` runs on `vars.CI_RUNS_ON` and greps the exact reserved range (line 53). A self-hosted runner has no sudo, so line 51 cannot change the range.
  - Checked 2026-11-12: the main repo sets no `CI_RUNS_ON` variable, so `postgres.yml` runs on GitHub-hosted `ubuntu-latest` and nothing needs provisioning for main. If a self-hosted runner gates a branch later (the mirror backup), re-apply `runner-provision.sh` (range 26439-26481) on it first.
  - Until then, keep the PR in draft.
- [ ] **Step 1: Write failing unit tests** in `write/bundles_test.go`:

```go
func TestValidateBundleSettings(t *testing.T)
// ok: standard {100ml:650000,110ml:725000,120ml:795000}, linePrices {EXTRAIT DE PARFUM,120ml,850000}
// err "Harga lini 110ml butuh harga standar 110ml": linePrices EXT 110ml without standard 110ml
// err "Ukuran harus seperti 120ml": size "120"
// err "Harga bundle harus bilangan bulat > 0": 0, -1, 650000.5
// err "Lini tidak dikenal: GLITTER"
// err "Ukuran 120ml dobel": two standard rows 120ml
```

- [ ] **Step 2: Write the failing Postgres gate** `TestBundlesPostgres` (`gatePool(t, "BN", 26481)`, seeded like `TestPromoAutoApplyPostgres`) with subtests:
  - `settings_roundtrip`: PUT the valid input above with a `manage_products` token returns 200. GET `/settings/bundles` returns the same rows, and `lines` contains `{EXTRAIT DE PARFUM, Extrait, EXT}` once the seeded catalog has an EXT large.
  - `settings_forbidden`: PUT with a token lacking `manage_products` returns 403.
  - `version_bumps`: `content_versions.version` increases after the PUT.
  - `pull_has_catalog`: seed CHAMPION (EXT120, PI120, A10, EXT2, PI2, all with `erp_category`). `GET /sync/pull` gives `bundleCatalog.products[0].offers` = EXT 120ml 850000 and PI 120ml 795000, and `pieces` has 5 entries.
  - `catalog_backoffice`: `GET /bundles/catalog` lists NO1 (EXT120 + EXT2, no atomizer) with `missing[0].text == "atomizer belum ada"`.
- [ ] **Step 3: Run** `cd backend && go test ./internal/write/ -run TestValidateBundleSettings`. Expected: FAIL.
- [ ] **Step 4: Implement** the migration, loaders, repo methods, handlers, routes, OpenAPI and pull field. Then regenerate: `cd backend && make gen-go` and `corepack pnpm --filter @mandalika/api gen`.
- [ ] **Step 5: Run:**
  - `cd backend && go test ./internal/write/ ./internal/bundles/ ./internal/sync/ ./internal/handlers/ && make gen-check`
  - `corepack pnpm gen:check`
  - `python scripts/ci/postgres_gate.py --runtime native --pg-bin <pg18/bin> --no-race` (or the docker runtime). The `BN` gate must PASS.
  - Expected: all pass, and `gen:check` prints no drift.
- [ ] **Step 6: Commit** `git commit -m "feat: bundle price settings, derived bundle catalog in sync pull"`

### Task 1.3: Backoffice "Produk › Bundle" tab

Reviewer: Opus high (consumes the new generated types; price editing).

**Files:**
- Create:
  - `apps/backoffice/src/screens/products/BundleSettingsPanel.tsx` (sections `StandardPricesCard`, `LinePricesCard`, `BundleAromaList`)
  - `apps/backoffice/src/screens/products/bundleSettings.ts`
- Modify: `apps/backoffice/src/screens/Products.tsx:15-24` (`BundlesView` renders `BundleSettingsPanel`)
- Delete: `apps/backoffice/src/screens/products/BundlesPanel.tsx`, plus its test if one exists.
- Test: `apps/backoffice/src/screens/products/bundleSettings.test.ts`, `apps/backoffice/src/screens/products/BundleSettingsPanel.test.tsx`

**Interfaces:**
- Consumes: `api.getBundleSettings`, `api.updateBundleSettings`, `api.getBundleCatalog` (Task 1.2).
- Produces (`bundleSettings.ts`):
  - `type BundleSettingsForm = { standard: Record<string,string>; lines: Record<string, Record<string,string>> }`. Values are raw input strings, and `""` means "use standard".
  - `const DEFAULT_LARGE_SIZES = ['100ml', '110ml', '120ml']`
  - `settingsToForm(s: BundleSettings): BundleSettingsForm`: `standard` always has keys for `DEFAULT_LARGE_SIZES` (value `""` when unset), plus any other stored size, sorted numerically. So an empty `bundle_prices` still shows the three fields.
  - `formToInput(f: BundleSettingsForm): BundleSettingsInput`: drops empty standard and line prices, and parses `Rp 850.000`-style input to integers.
  - `formProblems(f: BundleSettingsForm): string[]`: the same copy as the server validation.
  - `aromaRows(c: BundleCatalog, filter: 'all'|'missing')`: one row per product, with a chip per offer (`EXT 120ml · Rp 850.000`) and a note per missing entry. A product with no offers shows `Tidak ada bundle`.
- Layout follows `bundle-backoffice.html` section 1. The column headers are the standard sizes, and `Kosong = pakai harga standar` sits under "Harga per lini". The filter is `Semua` / `Ada yang kurang`.
- The route stays `perm: 'manage_products'` (`lib/router/routes.ts:107-127`).

- [ ] **Step 1: Write failing tests:**
  - `settingsToForm/formToInput round-trip the CHAMPION example`
  - `formToInput drops empty line prices`
  - `settingsToForm of empty settings shows 100ml, 110ml and 120ml standard fields, empty`
  - `settingsToForm keeps a stored 130ml standard price after the three defaults`
  - `formProblems reports "Harga lini 110ml butuh harga standar 110ml"`
  - `aromaRows filter "missing" keeps only NO1 and ONLY THE BRAVE`
  - `BundleSettingsPanel saves through updateBundleSettings and shows the server error text`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- bundleSettings`. Expected: FAIL.
- [ ] **Step 3: Implement.** Copy is from Global Constraints and the mockup.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/backoffice test && corepack pnpm typecheck:ci`. Expected: PASS. Render `bundle-backoffice.html` next to the local Backoffice and compare.
- [ ] **Step 5: Commit** `git commit -m "feat: Backoffice bundle price settings tab"`

---

## Phase 2: Server sale path for bundles

### Task 2.1: Split and MinNet with a shared golden

Reviewer: Opus high (pricing).

**Files:**
- Create: `backend/internal/bundles/split.go`, `backend/internal/bundles/testdata/split_golden.json`
- Test: `backend/internal/bundles/split_test.go`

**Interfaces:**
- Produces:
  - `func Split(amount int64, basis [3]int64) ([3]int64, error)`. Index order is `[large, atomizer, vial]`. It returns an error when any basis is ≤ 0 or `amount < 0`.
  - `func MinNet(basis [3]int64) int64`.
  - `const MaxBundleMoney int64 = 1_000_000_000`. `priceSetBundle` (Task 2.3) maps any `Split` error to `bundle_invalid`.
  - Golden file format: `[{ "name", "amount", "basis":[L,A,V], "expected":[L,A,V], "minNet" }]`. Task 3.1 reads the same file from TS.

```go
// Split body (the only non-obvious algorithm):
s := basis[0] + basis[1] + basis[2]
// guard first: amount ≤ MaxBundleMoney (1e9) and every basis in 1..MaxBundleMoney, else error
// (so amount*basis ≤ 1e18 < 9.2e18; no overflow)
a := amount * basis[1] / s   // int64 floor
v := amount * basis[2] / s
return [3]int64{amount - a - v, a, v}, nil
```

- [ ] **Step 1: Write the golden + test** `TestSplitGolden` with at least these cases:
  - `champion_ext_120`: 850000, [1200000,250000,60000] → [675498,140728,33774]
  - `discount_share`: 85000, same basis → [67551,14072,3377]
  - `equal_basis_remainder_on_large`: 100, [1,1,1] → [34,33,33]
  - `zero_amount`: 0 → [0,0,0]
  - `min_net`: basis [1200000,250000,60000] → minNet = max(ceil(1510000/250000)=7, ceil(1510000/60000)=26) = 26
  
  Also `TestSplitRejectsNonPositiveBasis` ([x,0,y], negative, and basis or amount > `MaxBundleMoney` → error) and `TestSplitSharesSumToAmount` (randomised, 1000 cases, sum == amount, every share ≥ 1 when amount ≥ MinNet).
- [ ] **Step 2: Run** `cd backend && go test ./internal/bundles/ -run 'TestSplit|TestMinNet'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: bundle price split with remainder on the large bottle"`

### Task 2.2: Sale input fields, `order_items` columns, structural validation

Reviewer: Opus high (sale input, generated types).

**Files:**
- Create: `backend/internal/db/migrations/0090_order_item_bundles.sql`
- Modify:
  - `backend/api/openapi.yaml`: `OrderItemInput` :2269 and `CartItem` :1597
  - generated `api.gen.go` and `schema.d.ts`
  - `backend/internal/service/order.go:54-75` (`OrderItem`)
  - `backend/internal/service/order_input.go` (`ValidateSaleInput` :90)
- Test: `backend/internal/service/order_input_test.go`

**Interfaces:**
- **Migration 0090:**

  ```sql
  ALTER TABLE order_items
    ADD COLUMN bundle_group smallint CHECK (bundle_group BETWEEN 1 AND 32767),
    ADD COLUMN bundle_role text CHECK (bundle_role IN ('large','atomizer','vial')),
    ADD COLUMN bundle_line text,
    ADD COLUMN bundle_size text,
    ADD COLUMN bundle_discount numeric(14,2) CHECK (bundle_discount >= 0),
    ADD COLUMN bundle_promotion_id uuid,
    ADD CONSTRAINT order_items_bundle_pair CHECK ((bundle_group IS NULL) = (bundle_role IS NULL));
  ```

- **OpenAPI, sale input** (on both `OrderItemInput` and `CartItem`, optional, not nullable):
  - `bundleGroup: {type: integer, minimum: 1, maximum: 32767}`
  - `bundleRole: {type: string, enum: [large, atomizer, vial]}`
  - `bundlePrice: {type: number, format: double}`: the list price, before Diskon Bundle, the same on all three pieces.
  - `bundleBasisPrice: {type: number, format: double}`: the piece's single price.
- **OpenAPI, `CartItem` only** (optional, not nullable, written by the POS and the order read):
  - `bundleLine: {type: string}`
  - `bundleSize: {type: string}`
  - `bundleDiscount: {type: number, format: double}`: this piece's share of the Diskon Bundle.
  - `bundlePromotionId: {type: string}`
- **Go `OrderItem` additions:**
  - `BundleGroup int \`json:"bundleGroup"\``
  - `BundleRole string \`json:"bundleRole"\``
  - `BundlePrice float64 \`json:"bundlePrice"\``
  - `BundleBasisPrice float64 \`json:"bundleBasisPrice"\``
  - internal `bundle *setBundleInfo`, where `type setBundleInfo struct { line, size string; discount float64; promotionID string }` (Task 2.3 fills it).
- `func validateBundleFields(items []OrderItem) error`, called from `ValidateSaleInput`. Its 400s use `saleInputError`, with fields such as `items[i].bundleRole`:
  - `bundleGroup` outside 0..32767;
  - group > 0 with a role not in the enum, `Quantity != 1`, `IsReward` or `IsBundle`;
  - group > 0 with `bundlePrice` or `bundleBasisPrice` failing `saleMoney`, not whole rupiah, or above `bundles.MaxBundleMoney` (1e9; exported by Task 2.1). This guards the int64 split against client-supplied values.
  - group == 0 with a non-empty role or a non-zero `bundlePrice`.
  - Group composition is **not** checked here. It is semantic, Task 2.3.

- [ ] **Step 1: Write failing tests:**
  - `TestValidateBundleFields`, one case per rule above, plus a valid 3-piece group.
  - `TestOrderItemDecodesBundleFields`: JSON with the 4 fields round-trips into `OrderItem`.
- [ ] **Step 2: Run** `cd backend && go test ./internal/service/ -run 'TestValidateBundleFields|TestOrderItemDecodesBundleFields'`. Expected: FAIL.
- [ ] **Step 3: Implement.** Regenerate (`make gen-go`, `corepack pnpm --filter @mandalika/api gen`).
- [ ] **Step 4: Run** the same command, `make gen-check` and `corepack pnpm gen:check && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: bundle fields on sale lines and order_items"`

### Task 2.3: `resolveSetBundles`: validate, price and split bundles in the sale

Reviewer: Opus high (pricing, stock-adjacent, sync semantics).

**Files:**
- Create: `backend/internal/service/setbundle.go` (pure core), `backend/internal/service/setbundle_resolve.go` (tx loader + wiring)
- Modify:
  - `backend/internal/service/promo_validate.go:13-38` (new violation)
  - `backend/internal/handlers/orders.go:~294` (`discountRejectMessage`)
  - `backend/internal/service/order.go`: call after `resolveBundleLines` (~:348-360); `order_items` INSERT :638-646 (6 new columns)
  - `backend/internal/read/orders.go:50-56`: item JSON; bundle keys only when `bundle_group IS NOT NULL`, via `(json_build_object(...)::jsonb || CASE WHEN it.bundle_group IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('bundleGroup',…,'bundleRole',…,'bundleLine',…,'bundleSize',…,'bundleDiscount',…,'bundlePromotionId',…) END)`. `bundlePromotionId` is omitted when NULL.
- Test: `backend/internal/service/setbundle_test.go`

**Interfaces:**
- Consumes: `bundles.Classify`, `bundles.Prices`, `bundles.LoadPrices`, `bundles.Split`, `bundles.MinNet` (Tasks 1.1, 1.2, 2.1); `OrderItem` bundle fields (Task 2.2).
- Produces:
  - `const ViolationBundlePriceChanged PromoViolation = "bundle_price_changed"`. Copy: `Harga bundle sudah berubah. Tunggu katalog tersinkron lalu ulangi.`
  - `const ViolationBundleBasisReplaced PromoViolation = "bundle_basis_replaced"`. This is a warning only, never a 422.
  - `type setBundlePiece struct { idx int; role bundles.Role; piece bundles.Piece; classified bool; clientBasis, catalogBasis int64 }`.
    - `clientBasis` is the client `BundleBasisPrice`, 0 when absent.
    - `catalogBasis` is the outlet catalog price.
  - `type setBundleGroup struct { group int; pieces []setBundlePiece; clientPrice float64 }`. `clientPrice` is the large piece's `BundlePrice`.
  - `type setBundlePriced struct { line, size string; price, discount int64; promotionID string; shares, discShares [3]int64 }`
  - `func priceSetBundle(g setBundleGroup, prices bundles.Prices, offline bool) (setBundlePriced, []PromoViolation)`. Task 4.2 adds a `discounts []PromoSpec` parameter.
  - `func loadSetBundleVariants(ctx context.Context, tx pgx.Tx, outletID string, refs []variantRef) (map[variantRef]bundles.Variant, error)`. It uses `COALESCE(op.price, v.price)` for the outlet, plus `size` as `Label`, `erp_category`, `erp_slug IS NOT NULL` as `ErpLinked` and `is_active`. `type variantRef struct{ productID, size string }`.
  - `func (s *OrderService) resolveSetBundles(ctx context.Context, tx pgx.Tx, in *CreateOrderInput) (warn string, err error)`.
- **Rules for `priceSetBundle`** (it returns `ViolationBundleInvalid` unless noted):
  1. The group has exactly 3 pieces, one per role.
  2. Each piece is `classified` with the claimed role. Inactive, price ≤ 0, wrong size or excluded category all fail.
  3. Vial line == large line. The atomizer may come from any product, and the vial from any product with the same line.
  4. `prices.PriceFor(large.Line, large.Size)` exists.
  5. `clientPrice != price`:
     - online: `ViolationBundlePriceChanged`;
     - offline: use `clientPrice` (rounded) and return the violation as a warning (the caller keeps the sale).
  6. Basis: use the client basis when all three are > 0 and `price − discount ≥ MinNet(clientBasis)`. Otherwise:
     - online: `bundle_invalid` when a client basis was sent;
     - offline: use the catalog basis and warn `ViolationBundleBasisReplaced`.
     
     The catalog basis must itself have every value > 0 and `price − discount ≥ MinNet(catalogBasis)`, else `bundle_invalid`. When no client basis is sent, the catalog basis is used with no warning.
  7. Shares come from `Split(price − discount, basis)`. `discount` is 0 until Phase 4. Every share is ≥ 1 by construction.
- **`resolveSetBundles` behaviour:**
  - Group `in.Items` by `BundleGroup > 0`.
  - **Valid group:** set each piece's `Price = Subtotal = share`, and `bundle = &setBundleInfo{line, size, discount: discShare, promotionID}`.
  - **Invalid group, online:** return `&ErrDiscountRejected{Violations}` (422).
  - **Invalid group, offline:** keep the client prices, set `bundle` from whatever classified (line/size empty if not), and add a warning.
  - **Either way:** the group keeps its `bundleGroup`, so the refund group still forms (Task 2.4).
  - **Warnings** join `discountWarnReason` exactly as `bundleWarnReason` does at `order.go:351-358`.

- [ ] **Step 1: Write failing tests** (pure `priceSetBundle`, fixtures from the CHAMPION catalog: standard 120ml 795000, EXT 120ml 850000):

```go
func TestPriceSetBundleValid(t *testing.T)            // EXT120+A10+EXT2, client 850000, basis [1200000,250000,60000] → shares [675498,140728,33774], line "EXTRAIT DE PARFUM", size "120ml"
func TestPriceSetBundleSwapKeepsPrice(t *testing.T)   // atomizer from another product, basis 300000 → Σshares == 850000, price unchanged
func TestPriceSetBundleRejects(t *testing.T)          // table: 2 pieces; two atomizers; PI vial in EXT bundle; 130ml large (no standard); DISPLAY EXT large → []{ViolationBundleInvalid}
func TestPriceSetBundleZeroPricePieceInvalid(t *testing.T) // atomizer catalog price 0 and client basis 0 → bundle_invalid
func TestPriceSetBundleInactiveVialInvalid(t *testing.T)   // vial Active=false → bundle_invalid
func TestPriceSetBundleStalePriceOnlineRejects(t *testing.T)   // client 795000 vs 850000, offline=false → []{ViolationBundlePriceChanged}
func TestPriceSetBundleStalePriceOfflineKeepsClientPrice(t *testing.T) // offline=true → price 795000, shares Split(795000,basis), warn bundle_price_changed
func TestPriceSetBundleNoLineUsesStandard(t *testing.T)  // unlinked "110ml"/"10ml"/"2ml", line price for EXT set → price 725000
func TestPriceSetBundleClientBasisPreferred(t *testing.T) // client basis [1000000,200000,50000] used over catalog
func TestPriceSetBundleShareNeverZero(t *testing.T)       // client basis [1,1000000000,1] on 850000 (MinNet 1000000002 > 850000):
                                                          //   online → bundle_invalid; offline → catalog basis [1200000,250000,60000] used, shares [675498,140728,33774], warn bundle_basis_replaced;
                                                          //   catalog basis [1,1000000,1] too → bundle_invalid (kept + flagged offline)
```

- [ ] **Step 2: Run** `cd backend && go test ./internal/service/ -run TestPriceSetBundle`. Expected: FAIL.
- [ ] **Step 3: Implement** the pure core, the loader, the wiring, the insert columns, the read JSON and the reject copy.
- [ ] **Step 4: Run** `cd backend && go test ./internal/service/ ./internal/handlers/ ./internal/read/`. Expected: PASS, and no golden drift (`TestPromoParityGolden`, `TestAllocateGolden` unchanged).
- [ ] **Step 5: Commit** `git commit -m "feat: server prices and validates bundle sale lines"`

### Task 2.4: Keep pieces out of product-keyed promos; `set:<n>` refund group

Reviewer: Opus high (pricing engine, refunds).

**Files:**
- Modify:
  - `backend/internal/service/pricing.go`: `LineItem` :30 gets `InBundle bool`. Change `calcPromotionDiscount` :496 and `calcBXGY` callers; change `bxgyRewardDue` and `bxgyBuyUnits` callers.
  - `backend/internal/service/order.go:373-376`: set `InBundle: it.BundleGroup > 0`.
  - `backend/internal/service/rewards.go`: in `resolveRewardLines` ~:77-83 and `resolveBundleLines` :226-232, the `paid` lists skip `BundleGroup > 0`.
  - `backend/internal/service/allocate.go`: `promoEligibleLines` :268; `refundGroups` :366 (set keys are computed before the `len(groups)==0` early return); the paid-line `matches` loop skips `BundleGroup > 0`.
- Test: `backend/internal/service/pricing_test.go`, `allocate_test.go`, `refund_plan_test.go`

**Interfaces:**
- Produces:
  - `func promoLines(items []LineItem) []LineItem`: items with `!InBundle`, used for every product-keyed computation.
  - `refundGroups` returns `"set:<BundleGroup>"` for every line with `BundleGroup > 0`.
- **Rules:**
  - Scoped percentage/fixed matches only `promoLines`.
  - BOGO (scoped or not) prices only `promoLines`.
  - BXGY same-set pools and separate-set buy counting use `promoLines`.
  - Unscoped percentage keeps `base = sub`, and unscoped fixed keeps `min(value, sub)` (bundles included).
  - Tiered stays on `sub`.
  - `promoEligibleLines`:
    - scoped and BXGY-with-keys exclude `InBundle` lines;
    - unscoped BOGO and BXGY-with-empty-keys return `nil` when no line is `InBundle`, else the non-bundle line indices.

- [ ] **Step 1: Write failing tests.** Cart for all three tests: bundle pieces (product A 120ml 675498, atomizer B 10ml 140728, vial A 2ml 33774, all `InBundle`) + single A 120ml 1200000.

```go
func TestComputeBundlePiecesIgnoredByProductKeyedPromos(t *testing.T)
// scoped 10% on A → 120000 (single only; not 120000+70927)
// BOGO on A → 0 (one non-bundle unit)
// BXGY same-set buy1get1 empty keys → 0 (only one non-bundle unit)
// unscoped 10% → round(2050000*0.1)=205000 (bundle included at its price)
// tiered minSubtotal 2000000 fixed 100000 → 100000
func TestPromoEligibleLinesSkipsBundlePieces(t *testing.T) // scoped A → [3]; unscoped BOGO → [3]; cart without pieces → nil (unchanged)
func TestRefundGroupsSetBundles(t *testing.T)              // groups 1 and 2 → "set:1"×3, "set:2"×3; a Paket Bundel on A keys only its own lines, never a piece
func TestPlanRefundSetBundleWholeOnly(t *testing.T)        // refund_group "set:1": one piece → ErrRefundGroupSplit; all three full qty → ok, amount = Σ net
```

- [ ] **Step 2: Run** `cd backend && go test ./internal/service/ -run 'TestComputeBundlePieces|TestPromoEligibleLinesSkips|TestRefundGroupsSetBundles|TestPlanRefundSetBundle'`. Expected: FAIL. (The last test may already pass on the existing group rule; keep it as the pin.)
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd backend && go test ./internal/service/...`. Expected: PASS, including the unchanged goldens.
- [ ] **Step 5: Commit** `git commit -m "feat: bundle pieces skip product-keyed promos and refund as one group"`

### Task 2.5: ERP and end-to-end pins

Reviewer: Opus high (stock, ERP, refunds).

**Files:**
- Modify: `backend/internal/integration/erp/payload_test.go` (test only; `payload.go` unchanged), `backend/internal/handlers/bundles_integration_test.go`

- [ ] **Step 1: Write the tests:**
  - `TestBuildDocumentBundlePiecesSumToBundleNet` (`payload_test.go`): three sale movements, qty 1, with `OrderInfo.LinePrice` {675498,140728,33774}. Lines carry those `unit_price`s, their sum is 850000, and none is 0.
  - `TestBundlesPostgres` subtests:
    - `sale_sync_bundle`: a `/sync/batch` sale of EXT 120ml with a swapped atomizer from product B. It gives 3 `order_items` with `bundle_group=1`, roles large/atomizer/vial, prices 675498/140728/33774 (client basis), `refund_group='set:1'` and `is_bundle=false`. `outlet_variant_stock` drops by 1 for A 120ml, B 10ml and A 2ml.
    - `sale_stale_price_offline`: client `bundlePrice` 795000 is stored, with order `discount_warning=true` and the reason containing `bundle_price_changed`.
    - `sale_invalid_online`: `POST /orders` with a PI vial in an EXT bundle gives 422 `Bundel tidak valid atau syaratnya tidak terpenuhi`.
    - `refund_one_piece_refused`: refunding only the atomizer gives 400 "Barang promo paket/beli-gratis harus direfund bersamaan seluruhnya.". The whole bundle refunds 850000 and restocks all 3.
    - `order_read_bundle_fields`: `GET /orders/{id}` items carry `bundleGroup`, `bundleRole`, `bundleLine`, `bundleSize`. A non-bundle line has none of these keys.
- [ ] **Step 2: Run** `cd backend && go test ./internal/integration/erp/ -run TestBuildDocumentBundlePieces`, then the Postgres gate for `BN`. Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "test: pin bundle sale, stock, ERP and refund behaviour"`

---

## Phase 3: POS selling (OTA, web layer only)

### Task 3.1: POS bundle helpers (pure) and split twin

Reviewer: Opus high (pricing twin, stock).

**Files:**
- Create: `apps/pos/src/cashier/setBundles.ts`
- Test: `apps/pos/src/cashier/setBundles.test.ts`, `apps/pos/src/cashier/setBundleSplit.golden.test.ts` (reads `backend/internal/bundles/testdata/split_golden.json`, the same way `allocateNet.golden.test.ts` reads its fixture)

**Interfaces:**
- Consumes: `components['schemas']['BundleCatalog' | 'BundleOffer' | 'BundlePiece' | 'CartItem' | 'Product']`; `stockFor` (`stock.ts:23`).
- Produces:
  - `splitBundleAmount(amount: number, basis: [number, number, number]): [number, number, number]`: the Go `Split` twin. Throws when a basis is ≤ 0, when a value is not a safe integer (`Number.isSafeInteger`), or when a value exceeds 1e9.
  - `minNet(basis: [number, number, number]): number`
  - `type BundleRole = 'large' | 'atomizer' | 'vial'`
  - `isSetBundlePiece(c: CartItem): boolean` (`c.bundleGroup != null`)
  - `cardOffers(catalog: BundleCatalog | undefined, productId: string): BundleOffer[]`
  - `offerButtonMode(offers: BundleOffer[]): 'none' | 'buttons' | 'list'` (0 / 1–2 / 3+)
  - `offerSoldOut(offer: BundleOffer, productId: string, products: Product[], cart: CartItem[]): boolean`: `stockFor(large) !== null && stockFor(large) − inCart(large) ≤ 0`. `inCart` counts singles and pieces of that variant, the same subtraction `needsSwap` uses.
  - `lineShort(line: string): string`: `"EXTRAIT DE PARFUM"`→`"EXT"`, `"PARFUM INTENSE"`→`"PI"`, `""`→`""`, anything else → the line itself. It mirrors Go `bundles.LineInfo` and is used by receipts and the cart, where only `bundleLine` is stored.
  - `nextBundleGroup(cart: CartItem[]): number`: max + 1, starting at 1
  - `buildBundleLines(offer, product, catalog, products, group): { lines: CartItem[]; needsSwap: Array<'atomizer' | 'vial'> }`:
    - Pieces come in the order large, atomizer, vial, each `quantity: 1`.
    - Each has `bundleGroup`, `bundleRole`, `bundlePrice: offer.price`, `bundleBasisPrice` (the variant's outlet price), `bundleLine: offer.line` and `bundleSize: offer.size`.
    - `needsSwap` lists the roles whose stock (in-cart quantity subtracted) is ≤ 0.
  - `swapCandidates(catalog, products, cart, role, line): SwapOption[]`, with `SwapOption = { productId, productName, variantSize, price, stock }`:
    - atomizer: every `pieces` entry with role atomizer;
    - vial: role vial and `line === line`;
    - only variants with price > 0 and stock > 0 after subtracting the in-cart quantity. Untracked stock (`stockFor` → `null`) counts as in stock;
    - sorted by name;
    - the current piece is excluded from the result. The sheet (Task 3.4) shows it separately as `Habis · stok akan minus` when its stock is ≤ 0 (O1).
  - `repriceBundles(state: CashierState): CashierState` (type-only import of `CashierState`). Task 4.3 needs `appliedPromotions` and `appliedPromoCodes`. Per group: `price = bundlePrice`, `discount = 0` (Phase 3), `shares = splitBundleAmount(price − discount, basis)`. It sets `price = subtotal = share` and `bundleDiscount = 0`, and returns the **same object** when nothing changed.

- [ ] **Step 1: Write failing tests:**
  - `split golden matches Go` (every case in `split_golden.json`)
  - `offerButtonMode 1→buttons, 2→buttons, 4→list`
  - `buildBundleLines CHAMPION EXT 120ml gives 3 qty-1 lines summing to 850000`
  - `buildBundleLines flags atomizer when its stock is 0`
  - `swapCandidates vial offers only same-line 2ml`
  - `swapCandidates excludes zero-price variants`
  - `swapCandidates excludes out-of-stock variants (incl. in-cart quantity) and keeps untracked (null) stock`
  - `swapCandidates excludes the current piece`
  - `offerSoldOut subtracts the large bottle already in the cart (stock 1, one in cart → sold out)`
  - `lineShort maps EXTRAIT DE PARFUM→EXT, PARFUM INTENSE→PI, ""→""`
  - `repriceBundles is idempotent and returns the same object`
  - `repriceBundles keeps Σ = bundlePrice after a swap to a pricier atomizer`
  - `repriceBundles never throws: a group with a basis ≤ 0, or with price − discount < minNet(basis), keeps its current prices`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/pos test -- setBundle`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): bundle catalog helpers and price split twin"`

### Task 3.2: Cart reducer actions and guards for bundle pieces

Reviewer: Opus high (cart state, stock, refunds).

**Files:**
- Modify:
  - `apps/pos/src/cashier/state/cashierReducer.ts` (actions union :92-140; `cashierReducer` :270 wraps with `repriceBundles`; `CART_REMOVE_ITEM` :382, `CART_SET_QTY` :401)
  - `apps/pos/src/cashier/promotionEffects.ts` (`upsertCartItem` :20 never merges into a piece; `reducePaidQty` :44 skips pieces)
  - `apps/pos/src/cashier/lineSizes.ts` (`planSizeSwitch` :49 returns null for a piece)
  - `apps/pos/src/hooks/useCart.ts` (new actions)
  - `apps/pos/src/cashier/saleLineData.ts` (`refundGroups` :96 emits `set:<n>`; `paidLineInGroup` :84 and `promoEligibleLines` :23 skip pieces, mirroring Task 2.4)
  - `apps/pos/src/cashier/RefundDialog.tsx:109` (header `Bundle (refund bersama)` when the group key starts with `set:`)
  - `apps/pos/src/cashier/heldRestore.ts:69-76`:
    - Today each held line comes back through `CART_ADD_ITEM` at the catalog single price. Piece lines instead come back per group through `CART_ADD_SET_BUNDLE`.
    - `bundlePrice` is refreshed from `env.bundleCatalog`, the offer matching `bundleLine` + `bundleSize` of the large piece's product. The basis is refreshed from the current variant price.
    - When the offer or a piece variant is gone, the pieces are left out with the note `Bundle <name> tidak bisa dipulihkan`.
    - `HeldRestoreEnv` gains `bundleCatalog?: BundleCatalog`.
  - `apps/pos/src/cashier/heldOrders.ts:82`: `restoreAllBundles(...)` must keep piece lines and their fields; held `lines` are whole `CartItem`s.
- Test: `state/cashierReducer.test.ts`, `saleLineData` tests (new `saleLineData.bundles.test.ts`), `refundSelection.test.ts`, `lineSizes.test.ts`, `heldRestore.test.ts`, `openCartDraft.test.ts`

**Interfaces:**
- Consumes: Task 3.1 `repriceBundles`, `isSetBundlePiece`.
- Produces:
  - Actions:
    - `{ type: 'CART_ADD_SET_BUNDLE'; lines: CartItem[] }`
    - `{ type: 'CART_REMOVE_SET_BUNDLE'; bundleGroup: number }`
    - `{ type: 'CART_SWAP_BUNDLE_PIECE'; bundleGroup: number; role: 'atomizer' | 'vial'; piece: { productId: string; productName: string; variantSize: string; basisPrice: number } }`
  - `useCart` methods: `addSetBundle(lines)`, `removeSetBundle(group)`, `swapBundlePiece(group, role, piece)`.
  - `cashierReducer(state, action) = repriceBundles(withAutoBookkeeping(state, baseReducer(state, action), action))`.

- [ ] **Step 1: Write failing tests:**
  - `CART_ADD_ITEM of A 120ml next to a bundle adds a separate single line`
  - `CART_REMOVE_ITEM A 120ml removes the single, keeps the bundle's large piece`
  - `CART_SET_QTY never touches a piece`
  - `CART_SWAP_BUNDLE_PIECE swaps the atomizer and keeps Σ = 850000`
  - `CART_REMOVE_SET_BUNDLE removes exactly its 3 lines`
  - `two bundles of the same offer stay two groups`
  - `planSizeSwitch returns null for a piece`
  - `refundGroups gives set:1 to the three pieces`
  - `refundSelection selects the whole bundle when one piece is ticked; lineLockReason locks after a partial`
  - `discountComponents attribution skips pieces for a scoped promo`
  - `hold and restore a cart with two bundles of the same offer: 6 lines, 2 groups, Σ unchanged`
  - `restore after a bundle price change uses the current offer price`
  - `restore of a bundle whose offer is gone leaves it out with the note`
  - `open-cart draft round-trips bundle fields`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/pos test -- cashierReducer saleLineData refundSelection lineSizes`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/pos test`. Expected: all PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): bundle cart lines, swap and whole-bundle refund group"`

### Task 3.3: TS pricing twin skips pieces; parity golden cases

Reviewer: Opus high (pricing twins).

**Files:**
- Modify:
  - `apps/pos/src/cashier/pricing.ts`: `calcBXGY` :112, `bxgyBuyUnits` :156, `bxgyRewardDue` :174, `bxgyRewardOptions` :210, `calcPromoDiscount` :248 (scoped matching and BOGO use `promoLines`)
  - `apps/pos/src/cashier/bundle.ts`: `computeBundleFreed`, `bundleStillApplicable` on non-piece lines
  - `apps/pos/src/cashier/promoEligibility.ts:28`
  - `backend/internal/service/testdata/promo_parity_golden.json` (+5 cases)
  - `backend/internal/service/promo_parity_golden_test.go`: the count pin :77 21→26; the cart line decode carries `bundleGroup` into `LineItem.InBundle`
  - `apps/pos/src/cashier/promoParity.test.ts`: count pin :46 21→26
- Test: the two parity tests above

**Interfaces:**
- Produces: `promoLines(items: CartItem[]): CartItem[]` in `pricing.ts`, the twin of the Go `promoLines`.
- Golden cases use the cart from Task 2.4:
  - `bundle_scoped_pct_ignores_pieces`
  - `bundle_bogo_ignores_pieces`
  - `bundle_bxgy_same_set_ignores_pieces`
  - `bundle_unscoped_pct_includes_bundle_price`
  - `bundle_tiered_on_subtotal`
  
  The expected values are the ones listed in Task 2.4. Never edit a golden to match an engine.

- [ ] **Step 1: Add the 5 cases and bump both pins.**
- [ ] **Step 2: Run** `cd backend && go test ./internal/service/ -run TestPromoParityGolden` (expected PASS: Go was done in Phase 2) and `corepack pnpm --filter @mandalika/pos test -- promoParity` (expected FAIL).
- [ ] **Step 3: Implement the TS exclusions.**
- [ ] **Step 4: Run** both commands. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): product-keyed promos skip bundle pieces (parity)"`

### Task 3.4: POS UI: bundle buttons, list sheet, cart line, swap sheet

Reviewer: Opus high (cart and stock flows); visual compare required.

**Files:**
- Create:
  - `apps/pos/src/cashier/BundleButtons.tsx` (card buttons + `Satuan (pilih ukuran)` link)
  - `apps/pos/src/cashier/BundleListSheet.tsx` (3+ offers, grouped by line label)
  - `apps/pos/src/cashier/BundleCartLine.tsx`
  - `apps/pos/src/cashier/BundleSwapSheet.tsx`
- Modify:
  - `apps/pos/src/cashier/ProductGrid.tsx` (props :340-358 gain `bundleCatalog?: BundleCatalog`, `onBundleTap(product, offer)`; the card renders `BundleButtons`; `Satuan` opens the existing `variantPopup`)
  - `apps/pos/src/cashier/Cart.tsx` (lines with the same `bundleGroup` render once as `BundleCartLine`)
  - `apps/pos/src/cashier/CashierScreen.tsx`:
    - `const bundleCatalog = snapshot.bundleCatalog` near :333;
    - `handleBundleTap` next to `handleProductTap` :475, with the same `ensureShift` / `offlineLock` gates as `addWithStockWarning` :455;
    - swap-sheet state.
- Test: `BundleButtons.test.tsx`, `BundleCartLine.test.tsx`, `BundleSwapSheet.test.tsx`

**Interfaces:**
- Consumes: Tasks 3.1 and 3.2.
- **Card behaviour:**
  - Card tap keeps today's behaviour.
  - `offerButtonMode` decides between 1–2 gold buttons (`Bundle EXT 120ml`, price, subline) and one `Bundle · N pilihan` / `mulai Rp …` button that opens `BundleListSheet`.
  - A sold-out offer shows `Habis` and is disabled (O1).
- **`handleBundleTap(product, offer)`:**
  - `buildBundleLines` → `addSetBundle`.
  - When `needsSwap` is non-empty, open `BundleSwapSheet` for each role in order (atomizer, then vial). The vial sheet opens when the atomizer sheet closes, whether the cashier picked or kept.
  - Each sheet lists `swapCandidates` (in stock only) plus, when its stock is ≤ 0, the current piece as `Habis · stok akan minus` (O1). Keeping it shows `OVERSELL_WARNING`.
  - The success toast is `Ditambahkan · Bundle EXT 120ml <fragrance>`.
- **`BundleCartLine`:**
  - Title `<fragrance> · Bundle EXT 120ml`, amount = Σ piece subtotals.
  - Three piece rows (`productName variantLabel(size)`). The atomizer and vial rows each have `Ganti`.
  - Remove dispatches `removeSetBundle`.
  - Under the title, a `bundleDiscount` row appears only when > 0 (Phase 4 fills it).

- [ ] **Step 1: Write failing component tests:**
  - `one offer renders one gold button with price`
  - `two offers render two buttons`
  - `four offers render one "Bundle · 4 pilihan" button opening the list`
  - `sold-out offer is disabled with Habis`
  - `tapping a bundle with no atomizer stock opens the atomizer swap sheet`
  - `with atomizer and vial both out of stock, the vial sheet opens after the atomizer sheet closes`
  - `swap sheet shows the out-of-stock current piece as "Habis · stok akan minus" and keeping it shows the oversell warning`
  - `swap sheet for vial lists only same-line 2ml`
  - `cart shows one bundle line with three pieces and two Ganti buttons`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/pos test -- Bundle`. Expected: FAIL.
- [ ] **Step 3: Implement** in the "Kertas & Emas" tokens. Render `bundle-cards.html` and `bundle-cart.html` (option Y) next to the dev build at tablet width and record the comparison in the PR.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/pos test && corepack pnpm typecheck:ci && corepack pnpm browser:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): bundle buttons, bundle cart line and swap sheet"`

### Task 3.5: Receipt: one bundle line with its pieces

Reviewer: Opus high (receipt totals must add up; quote snapshot).

**Files:**
- Modify:
  - `packages/printer/src/escpos.ts`: `ReceiptLine` :15 gains `pieces?: string[]` and `lineDiscount?: ReceiptDiscountRow`; the line loop :206-213.
  - `apps/pos/src/cashier/receiptQuote.ts`:
    - `QuoteLineInput` :10 and `ReceiptSnapshotLine` :21 gain optional `bundleGroup`, `bundleRole`, `bundleLine`, `bundleSize`, `bundleDiscount` and `bundlePromotionId`. The snapshot stays **one line per cart line, `v` unchanged**.
    - `buildReceiptQuote` :88 copies the fields.
    - `receiptFromQuote` :142 collapses groups through `collapseBundleLines` when it builds `ReceiptData.lines`.
  - `apps/pos/src/cashier/localReceipts.ts:80-86`: `localReceiptOrder` (:66) items copy the bundle fields, so a local reprint collapses. `lineNets` and `lineGroups` stay per cart line.
  - `apps/pos/src/cashier/CashierScreen.tsx:1031` (`reprintOrder` collapses groups through the same helper)
  - `apps/pos/src/cashier/ReceiptPreview.tsx` (renders pieces + line discount)
- Create: `apps/pos/src/cashier/bundleReceipt.ts`
- Test: `packages/printer/src/escpos.receipt.test.ts`, `apps/pos/src/cashier/receiptQuote.test.ts`, `apps/pos/src/cashier/bundleReceipt.test.ts`

**Interfaces:**
- Consumes: Task 3.1 `lineShort`.
- Produces (`bundleReceipt.ts`):
  - `interface BundleLineSource { name: string; variantSize: string; amount: number; bundleGroup?: number; bundleRole?: BundleRole; bundleLine?: string; bundleSize?: string; bundleDiscount?: number; bundlePromotionId?: string }`. This is the minimal shape both callers can supply.
  - Adapters:
    - `fromSnapshotLine(l: ReceiptSnapshotLine): BundleLineSource`: `name`, `variantSize`, `amount` and the bundle fields. Used by `receiptFromQuote`.
    - `fromOrderItem(i: CartItem): BundleLineSource`: `name = productName`, `amount = subtotal`. Used by `reprintOrder` and `localReceiptOrder` items.
  - `collapseBundleLines<T extends BundleLineSource>(lines: T[], promotionName: (id: string) => string | undefined): Array<{ kind: 'single'; line: T } | { kind: 'bundle'; group: number; name: string; pieces: string[]; price: number; discount: number; discountLabel?: string; amount: number }>`:
    - `name = <large piece name> · Bundle <lineShort(bundleLine)> <bundleSize>`. A single space is left when the short name is `""`.
    - `pieces` = `<name> <variantLabel(variantSize)>` in role order large, atomizer, vial.
    - `amount = Σ amount`, `discount = Σ bundleDiscount`, `price = amount + discount`.
    - `discountLabel = promotionName(bundlePromotionId) ?? 'Diskon Bundle'` when `discount > 0`.
    - The bundle sits at its large piece's position.
- **Print format** (amount column = `amount + lineDiscount.amount` on the qty row):

  ```
  CHAMPION · Bundle EXT 120ml
    · CHAMPION 120ml EXTRAIT DE PARFUM
    · BLUE 10ml ATOMIZER
    · CHAMPION 2ml EXTRAIT DE PARFUM
    1 x 850.000            850.000
    - Promo Akhir Tahun    -85.000
  ```

  `ReceiptLine.amount` holds the net, so `receiptAddsUp` still holds.

- [ ] **Step 1: Write failing tests:**
  - `buildReceipt prints a bundle with its pieces and the line discount`
  - `receiptAddsUp is true for a cart with a bundle`
  - `buildReceiptQuote keeps one snapshot line per piece with bundle fields`
  - `receiptFromQuote prints one line per bundle`
  - `receiptFromQuote of a snapshot without bundle fields is unchanged`
  - `reprint collapses server items with bundleGroup`
  - `local receipt of an unsynced bundle sale reprints one collapsed line and refunds the bundle whole (lineGroups set:1)`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/printer test && corepack pnpm --filter @mandalika/pos test -- receipt bundleReceipt`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same commands plus `corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: print a bundle as one receipt line with its pieces"`

---

## Phase 4: "Diskon Bundle" promotion type

### Task 4.1: Type, config column, write validation, projections

Reviewer: Opus high (generated types, promotions write path).

**Files:**
- Create: `backend/internal/db/migrations/0091_promo_bundle_discount.sql`
- Modify:
  - `backend/api/openapi.yaml`: `Promotion` :1522 and `PromotionInput` :2777 get enum `bundle_discount` and `bundleDiscountConfig` (copy the `allOf` + `nullable` pattern of `bundleConfig` :1556); new schema `BundleDiscountConfig`.
  - the generated files
  - `backend/internal/write/promotion.go`: `Promotion` :137, `CreatePromotion` :165, `UpdatePromotion` :223; new `validateBundleDiscount`.
  - `backend/internal/read/promotions.go:24` (`'bundleDiscountConfig',bundle_discount_config`) and any linked-promotion projection found by `grep -rn "bundleConfig\|bundle_config" backend/internal`.
  - `backend/internal/promotionkeys/diagnostic.go:32`: a `bundle_discount` case with no product keys.
- Test: `backend/internal/write/promotion_test.go` (or the existing promotion write test file), `TestBundlesPostgres` subtest

**Interfaces:**
- **Migration 0091:**
  - drop and re-add `promotions_type_check` with `('percentage','fixed','bogo','buy_x_get_y','tiered','bundle','bundle_discount')`;
  - `ALTER TABLE promotions ADD COLUMN bundle_discount_config jsonb`.
- **`BundleDiscountConfig`:** `{ kind: enum [percentage, fixed] (required), lines: string[], sizes: string[] }`. An empty list means "all". The amount is `promotions.value`.
- **Go:**
  - `type BundleDiscountConfigInput struct { Kind string; Lines, Sizes []string }`
  - `func validateBundleDiscount(value float64, c *BundleDiscountConfigInput) error`:
    - `Pilih persen atau nominal` (kind missing);
    - `Diskon persen harus 1–99`;
    - `Diskon nominal harus bilangan bulat > 0`;
    - `Diskon Bundle tidak memakai minimal belanja` when `minPurchase` > 0. Both twins check `minPurchase` against the subtotal of lines already repriced by this very promotion (server: `promoSubtotal`, `order.go:283-286`). A Diskon Bundle could therefore push the cart under its own minimum and invalidate itself. The type forbids it. Task 4.4 hides the field.
    - `Ukuran harus seperti 120ml`.
  - On create, `bundle_discount` with `Combinable == nil` stores `combinable = true`.

- [ ] **Step 1: Write failing tests:**
  - `TestValidateBundleDiscount`, one per message plus valid `{percentage, 10, [EXTRAIT DE PARFUM], [110ml]}`.
  - Postgres subtest `promo_bundle_discount_roundtrip`: create without `combinable`; GET shows `combinable: true` and the config; `/sync/pull` promotions carry `bundleDiscountConfig`.
- [ ] **Step 2: Run** `cd backend && go test ./internal/write/ -run TestValidateBundleDiscount`. Expected: FAIL.
- [ ] **Step 3: Implement**, then regenerate.
- [ ] **Step 4: Run:**
  - `cd backend && go test ./internal/write/ ./internal/read/ ./internal/promotionkeys/ && make gen-check`
  - `corepack pnpm gen:check`
  - the `BN` gate

  Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: Diskon Bundle promotion type"`

### Task 4.2: Go engine: biggest Diskon Bundle per bundle

Reviewer: Opus high (pricing engine, combinability).

**Files:**
- Modify:
  - `backend/internal/service/pricing.go`: `DiscountBundleDiscount DiscountKind = "bundle_discount"`; `PromoSpec` :321 gains `ID string` and `BundleDiscount *BundleDiscountConfig`; `calcPromotionDiscount` returns 0 for the kind.
  - `backend/internal/service/promo_resolve.go`: `loadPromoSpec` :99 selects `bundle_discount_config`, parses it, and sets `spec.ID`.
  - `backend/internal/service/allocate.go:268`: `promoEligibleLines` returns nil for the kind.
  - `backend/internal/service/setbundle.go`: `priceSetBundle(g, prices, offline, discounts []PromoSpec)`.
  - `backend/internal/service/setbundle_resolve.go`: passes the `promos` returned by `resolvePromos` (`order.go:309`).
- Create: `backend/internal/service/testdata/set_bundle_discount_golden.json`
- Test: `backend/internal/service/setbundle_test.go`, `resolve_promos_test.go`

**Interfaces:**
- Produces:
  - `type BundleDiscountConfig struct { Kind DiscountKind \`json:"kind"\`; Lines []string \`json:"lines"\`; Sizes []string \`json:"sizes"\` }`
  - `func bestBundleDiscount(price int64, line, size string, basis [3]int64, specs []PromoSpec) (amount int64, promotionID string)`:
    - Matches when `(len(Lines)==0 || line ∈ Lines) && (len(Sizes)==0 || size ∈ Sizes)`. Line `""` matches only an empty Lines list.
    - Percentage: `round(price·v/100)`. Fixed: `v`.
    - Clamp: `min(d, price − MinNet(basis))`, floored at 0.
    - The largest amount wins. A tie goes to the lexicographically smaller `ID`.
  - Shares: `shares = Split(price − d, basis)`, `discShares = Split(d, basis)`. Each piece stores `bundle_discount = discShare` and `bundle_promotion_id = promotionID`.
- Golden format: `[{ name, price, line, size, basis, promos: [{id, kind, value, lines, sizes}], expected: { discount, promotionId, shares, discShares } }]`. It is shared with Task 4.3. Cases:
  - `pct10_ext_120`: 850000 → discount 85000, shares [607948,126655,30397], discShares [67551,14072,3377] (net 765000 split)
  - `two_promos_bigger_wins`: 10% vs Rp100000 → 100000
  - `tie_smaller_id`
  - `line_filter_misses_pi`
  - `size_filter_110_only`
  - `no_line_bundle_matches_only_unfiltered`
  - `fixed_clamped_by_min_net`: Rp849990 on 850000 → 849974

- [ ] **Step 1: Write failing tests:**
  - `TestSetBundleDiscountGolden`
  - `TestCalcPromotionDiscountBundleDiscountIsZero`
  - `TestResolvePromosBundleDiscountNotCombinable`: two combinable Diskon Bundles + a non-combinable code, online → `ViolationNotCombinable`; offline → kept + warn.
- [ ] **Step 2: Run** `cd backend && go test ./internal/service/ -run 'TestSetBundleDiscount|TestCalcPromotionDiscountBundleDiscount|TestResolvePromosBundleDiscount'`. Expected: FAIL.
- [ ] **Step 3: Implement.** Recompute the golden arithmetic by hand while writing the cases.
- [ ] **Step 4: Run** `cd backend && go test ./internal/service/...`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: apply the biggest Diskon Bundle per bundle (server)"`

### Task 4.3: POS engine: Diskon Bundle in repricing, auto-apply, panel, receipt

Reviewer: Opus high (pricing twin, auto-apply).

**Files:**
- Modify:
  - `apps/pos/src/cashier/setBundles.ts`: `repriceBundles` reads the effective Diskon Bundles (`effectivePromotionSelection` + linked codes via `linkedPromoShape`).
  - `apps/pos/src/cashier/pricing.ts`: `calcPromoDiscount` returns 0 for `bundle_discount`; `linkedPromoShape` :318 copies `bundleDiscountConfig`.
  - `apps/pos/src/cashier/promoValidate.ts:184-191` (linked-code mapping)
  - `apps/pos/src/cashier/autoPromos.ts`: `planInstall` :148 'simple' uses `bundleDiscountGain` for this type and installs via `repriceBundles`; `autoSaving` :206 adds Σ `bundleDiscount`; `settle` :189 drops installed Diskon Bundles that win no bundle.
  - `apps/pos/src/cashier/promotionEffects.ts:9`: `removePromotionEffect` ends with `repriceBundles`.
  - `apps/pos/src/cashier/promoEligibility.ts`: `UnmetPrecondition` gains `'bundle-discount'` (no matching bundle in cart).
  - `apps/pos/src/cashier/PromoPanel.tsx:57-74,138`
  - `apps/pos/src/cashier/promoCopy.ts`: label `Diskon Bundle`; unmet copy `Belum ada bundle yang cocok di keranjang`.
  - `apps/pos/src/cashier/bundleReceipt.ts` (discountLabel from the promotion name)
  - type switches found at `confirmGuard.ts:49`, `customerAttachImpact.ts:8` and `heldRestore.ts:36`: add the type as a "simple" promo.
- Test: `setBundles.test.ts`, `setBundleDiscount.golden.test.ts` (reads `set_bundle_discount_golden.json`), `autoPromos.test.ts`, `promoEligibility` tests

**Interfaces:**
- Produces:
  - `bestBundleDiscount(price: number, line: string, size: string, basis: [number,number,number], promos: Promotion[]): { amount: number; promotionId?: string }`, the twin of Go.
  - `bundleDiscountGain(promo: Promotion, state: CashierState): number`: Σ per bundle of `max(0, best(with promo) − current bundleDiscount)`.
- `repriceBundles` sets per piece `bundleDiscount` (discShare) and `bundlePromotionId`, and `price = subtotal = share`. Cart-wide promos then see the lower subtotal, as on the server.

- [ ] **Step 1: Write failing tests:**
  - `Diskon Bundle golden matches Go`
  - `repriceBundles applies 10% to an EXT 120ml bundle: Σ = 765000`
  - `two Diskon Bundles: only the bigger applies per bundle`
  - `reconcileAutoPromos installs an auto Diskon Bundle (saving > 0)`
  - `reconcileAutoPromos holds Diskon Bundle back behind an exclusive code`
  - `settle drops a Diskon Bundle that wins no bundle`
  - `removing the promotion restores bundle prices`
  - `unscoped 10% promo after Diskon Bundle uses the reduced subtotal`
  - `unmetCartPrecondition is bundle-discount when no bundle matches`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/pos test -- setBundle autoPromos promoEligibility`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/pos test && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(pos): Diskon Bundle pricing and auto-apply"`

### Task 4.4: Backoffice promotion editor: "Diskon Bundle"

Reviewer: Opus high (generated types; promo authoring rules).

**Files:**
- Modify:
  - `apps/backoffice/src/screens/promotions/PromoTypeFields.tsx`: `PROMO_TYPES` :18-25 gets `{ value: 'bundle_discount', label: 'Diskon Bundle', desc: 'Potongan persen atau nominal per bundle' }`. `selectType` :74-81 seeds `bundleDiscountConfig: { kind: 'percentage', lines: [], sizes: [] }` and `combinable: true`. Add a new block with the kind segment (`Persen` / `Nominal`), the value (`% per bundle` / `Rp per bundle`), line checkboxes from `getBundleSettings().lines` (label) and size checkboxes from the standard sizes; empty means all, shown as `Semua lini` / `Semua ukuran`.
  - `apps/backoffice/src/screens/promotions/promotionForm.ts`: `DEFAULT_BUNDLE_DISCOUNT`, `promotionToInput` :60, `promotionProblems` :159 (same copy as Task 4.1).
  - `apps/backoffice/src/screens/promotions/PromoFormSlideOver.tsx:69`: `showVariants` excludes `bundle_discount`, and the minimum-purchase field is hidden for this type (Task 4.1).
  - `apps/backoffice/src/screens/promotions/promoDisplay.ts`
  - `apps/backoffice/src/lib/labels/promotion.ts:11-18`
- Test: `promotionForm.test.ts`, `PromoTypeFields.test.tsx`

- [ ] **Step 1: Write failing tests:**
  - `selecting Diskon Bundle seeds combinable on and percentage kind`
  - `promotionProblems: "Diskon persen harus 1–99" at 100`
  - `promotionToInput sends bundleDiscountConfig with chosen lines and sizes`
  - `line checkboxes list the ERP lines from bundle settings`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- promotion`. Expected: FAIL.
- [ ] **Step 3: Implement.** Compare with `bundle-backoffice.html` section 2.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/backoffice test && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: Diskon Bundle in the Backoffice promotion editor"`

### Task 4.5: End-to-end pin for Diskon Bundle

Reviewer: Opus high.

- [ ] **Step 1: Add `TestBundlesPostgres` subtests:**
  - `diskon_bundle_sale`: an EXT 120ml bundle with a 10% Diskon Bundle applied gives `order_items` prices [607948,126655,30397], `bundle_discount` [67551,14072,3377] and `bundle_promotion_id` set. The order total is 765000.
  - `diskon_bundle_bigger_wins`: two combinable promos (10% and Rp100000) give a total of 750000.
  - `diskon_bundle_with_cart_pct`: Diskon Bundle 10% + unscoped 10% give a subtotal of 765000, promo discount 76500 and total 688500.
  - `diskon_bundle_points_on_paid`: setup is loyalty enabled, `pointsPerThousand = 1`, a customer attached, and the same 10% Diskon Bundle sale. It gives `orders.points_earned` = 765 (= floor(765000/1000)·1, what was paid, not the 850 of the list price), and the customer balance rises by 765.
- [ ] **Step 2: Run** the `BN` gate. Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "test: pin Diskon Bundle sale end to end"`

---

## Phase 5: Reports

### Task 5.1: Bundle sales report endpoint; item sales at their share

Reviewer: Opus high (report money).

**Files:**
- Create: `backend/internal/read/bundle_report.go`
- Modify:
  - `backend/api/openapi.yaml` (path `/api/v1/bundle-report`, operationId `getBundleReport`)
  - generated files and `packages/api/src/client.ts`
  - `backend/internal/handlers/handlers.go` (next to `DiscountCodeReport` :518; same `dayRange` + `scope(r)` pattern)
  - `backend/internal/server/server.go:411-419` (`view_reports` group)
- Test: `TestBundlesPostgres` subtests

**Interfaces:**
- `type BundleReportFilters struct { DateFrom, DateTo, OutletID string }`. These are the same semantics as `CodeReportFilters`: business day, outlet scope-clamped.
- `(r *read.Repo) BundleReport(ctx, f BundleReportFilters) (api.BundleReport, error)`
- **OpenAPI:**
  - `BundleReportRow {productId, productName, line, lineLabel, size, bundles: integer, revenue: number, discount: number}`
  - `BundleReport {data: BundleReportRow[], totals: {bundles, revenue, discount}}`
- **SQL rules:**
  - A bundle is one `order_items` row with `bundle_role='large'` in an order with status `completed` or `partially_refunded`.
  - The fragrance is the large row's `product_id`.
  - A bundle whose large row has `order_refund_items` is excluded (the whole bundle refunds together).
  - `revenue` = Σ `subtotal` of the 3 rows sharing `(order_id, bundle_group)`. `discount` = Σ `bundle_discount`.
  - Group by `(product_id, bundle_line, bundle_size)`, ordered by bundles desc.
- `ReportSummary.topProducts` (`read/reports.go:74-90`) already uses line `subtotal`, so pieces count at their share. That is pinned by a test with no code change.

- [ ] **Step 1: Write failing subtests:**
  - `bundle_report_counts`: 2 CHAMPION EXT 120ml + 1 PI 120ml + 1 refunded EXT 120ml give rows EXT 120ml {bundles 2, revenue 1700000} and PI 120ml {1, 795000}.
  - `top_products_at_share`: a lone bundle sale with the atomizer **swapped to product B**, basis [1200000,250000,60000], gives CHAMPION revenue 675498 + 33774 = 709272 (large + same-fragrance vial) and the swapped atomizer's product 140728.
  - `bundle_report_forbidden`: no `view_reports` gives 403.
- [ ] **Step 2: Run** the `BN` gate. Expected: FAIL.
- [ ] **Step 3: Implement**, then regenerate.
- [ ] **Step 4: Run** `cd backend && go test ./internal/read/ ./internal/handlers/ && make gen-check`, `corepack pnpm gen:check` and the `BN` gate. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: bundle sales report"`

### Task 5.2: Backoffice "Laporan › Bundle" tab

Reviewer: Opus high (consumes generated types; report figures).

**Files:**
- Create: `apps/backoffice/src/screens/reports/BundleReportTab.tsx`
- Modify:
  - `apps/backoffice/src/lib/router/routes.ts:84-92` (`REPORT_TABS` gains `tab('bundles','bundle','Bundle','view_reports')`)
  - `apps/backoffice/src/screens/Reports.tsx:30,175-197` (`ReportTab` union + render)
- Test: `apps/backoffice/src/screens/reports/BundleReportTab.test.tsx`

- [ ] **Step 1: Write failing tests:**
  - `renders one row per fragrance, line and size with bundles, revenue and discount`
  - `totals row sums the rows`
  - `date and outlet filters are sent as dateFrom/dateTo/outletId`
- [ ] **Step 2: Run** `corepack pnpm --filter @mandalika/backoffice test -- BundleReportTab`. Expected: FAIL.
- [ ] **Step 3: Implement**, mirroring `DiscountCodeReportTab`. Columns: `Aroma`, `Lini`, `Ukuran`, `Bundle`, `Pendapatan`, `Diskon`.
- [ ] **Step 4: Run** `corepack pnpm --filter @mandalika/backoffice test && corepack pnpm typecheck:ci`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: Backoffice bundle report tab"`

---

## Per-phase completion

Each PR ends with:
- `corepack pnpm quality:ci`
- `cd backend && go test ./... && make gen-check`
- `corepack pnpm browser:ci` (Phases 3 and 4)
- the `BN` Postgres gate

Then an Opus high review of the whole branch, and a HANDOFF.md Progress-board update. Push, deploy, OTA and APK steps wait for the owner's go-ahead (AGENTS.md).
