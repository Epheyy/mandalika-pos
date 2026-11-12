# Bundles: POS flow, Backoffice settings and bundle promotions — design

Date: 2026-11-12. Status: draft, waiting for the owner's approval. Next step after
approval: an implementation plan (superpowers:writing-plans).

Mockups the owner reviewed are in `docs/plans/2026-11-12-bundles-mockups/`. They show
layout only; the final look follows the POS "Kertas & Emas" direction and the
Backoffice's current style. The text below overrides the mockups where they differ:

- Lines come from the ERP. There is no "+ Tambah lini" button.
- There is no "Lini bundle" dropdown on the product (mockup option Q is superseded).
- Bundle buttons are per line and size, not only per size.

## Why

Most fragrances are sold as a three-piece set of the same fragrance: one large bottle,
one 10ml atomizer and one 2ml vial. Cashiers and salesmen must offer the bundle first.
The customer may still pick a different fragrance's atomizer or vial, for example when
the outlet is out of the matching one.

In MOKA today:

- a bundle can't sit on the main screen for a quick pick;
- promotions and discounts can't target bundles;
- adding a bundle is tedious.

This design fixes all three. It also serves two of the owner's wider goals: cashiers
coming from MOKA should not feel lost, and sales should reach the ERP correctly.

## What success looks like

- A cashier sells a bundle with one tap from the main screen, without hunting for it.
- The owner sets bundle prices once: a standard price per large size, plus a price per
  ERP line where a line differs. There is no per-bundle data entry, and a new fragrance
  gets its bundles automatically once the ERP catalog has its pieces.
- A bundle promotion takes a few minutes to set up in the Backoffice.
- In the ERP, the three items of a bundle add up exactly to the bundle's price after any
  Diskon Bundle. Promo codes and points stay at order level, in the payment lines, as
  they do for every item today.

## Non-goals

- Configurable POS layouts (parked by the owner on 2026-11-12).
- A Void button for transactions. It is a separate project and comes next.
- Other bundle recipes, such as two large bottles, gift sets or hampers. Only the
  three-piece recipe is in scope.
- Changing the existing "Paket Bundel" promotion type (`promotions.bundle_config`,
  migration 0041).
- Changing the ERP contract.

## Anti-goals: these would make it a failure even if it works

- A swap changes the bundle price.
- The cashier has to dig for the bundle, so it is no longer the first option.
- Bundle sales reach the ERP as Rp0 lines, or as lines that don't add up to the bundle's
  price after any Diskon Bundle.
- A bundle can be partly refunded, leaving a price that means nothing.
- Any stock, sync or refund guard is weakened to make bundles work.

## The catalog this builds on (from the ERP data, checked 2026-11-12)

The ERP catalog import groups the sizes of one fragrance into one POS product. Each
variant stores its ERP category (`product_variants.erp_category`, migration 0068).
`erpmap.Line` (`backend/internal/integration/erp/erpmap/erpmap.go`) maps the category to
a line label. In the production sample (`erpmap/testdata/fg_sample_2026-10-26.json`):

- **Large bottles:** 100ml, 110ml or 120ml, each in category `EXT` (Extrait de Parfum)
  and/or `PERFUME INTENSE` (Parfum Intense). One fragrance can have several. 24HOURS has
  Extrait 100ml, Parfum Intense 100ml, Extrait 120ml and Parfum Intense 120ml.
- **10ml atomizer:** category `ATOMIZER`, one per fragrance. It has no Extrait or Parfum
  Intense version.
- **2ml vial:** category `EXT` and/or `PERFUME INTENSE`.
- **Never part of a bundle:** testers (`DISPLAY EXT`, `DISPLAY PARFUM`), hampers
  (`HAMPERS …`, `HAMPER …`), and other lines (`GLITTER`, `LEATHER`, `GLASS …`, 15ml).

## Decided by the owner

### Recipe and which fragrances get a bundle

- A bundle is one large bottle, the fragrance's 10ml atomizer, and a 2ml vial **of the
  same line** as the large bottle. Example: Extrait 120ml + atomizer 10ml + Extrait 2ml.
- 100ml, 110ml and 120ml all count as large bottles.
- It is automatic. A fragrance gets one bundle for every line and large size it has,
  provided it also has an atomizer and a 2ml of that line.
  - CHAMPION gets "Extrait 120ml" and "Parfum Intense 120ml".
  - A fragrance being upgraded from 110ml to 120ml has both while the old size is
    still in the catalog.
  - A size removed from the catalog drops out on its own.

### Price

- There is a fixed bundle price per large size, the **standard price**: one each for
  100ml, 110ml and 120ml.
- An ERP line (Extrait, Parfum Intense) can have its own bundle price per large size.
  The line comes from the ERP, so nobody assigns fragrances to lines by hand.
- Swapping the 10ml or the 2ml never changes the price.

### POS: where the bundle sits (mockup option A)

- Every fragrance card on the main screen gets a gold **Bundle** button. It shows the
  bundle price and its pieces. One tap adds the bundle to the cart.
- When a fragrance has two large sizes, the button splits in two, each with its price.
  The owner decided this for 110ml/120ml. How this extends to lines is a call of mine,
  under "My calls" below (mockup `bundle-cards.html`).
- Single sizes sit behind a small "Satuan (pilih ukuran)" link that opens the existing
  size picker.

### POS: the bundle in the cart (mockup option Y)

- A bundle is one cart line at the fixed price, with its three pieces listed under it.
- The 10ml and the 2ml each always have a **Ganti** button. The customer can pick another
  fragrance's atomizer or vial even when the matching one is in stock.
- When a piece is out of stock as the bundle is added, its swap list opens on its own.
- The swap list (owner, 2026-11-12):
  - The 10ml can be swapped for any fragrance's atomizer that is in stock. Atomizers have
    no line.
  - The 2ml can be swapped only for a 2ml **of the same line** as the bundle. An Extrait
    bundle offers only Extrait 2ml vials.

### Bundle promotion: a new promotion type, "Diskon Bundle"

- It takes a percentage or a rupiah amount off **each bundle**.
- It targets all bundles, or the lines and/or large sizes the owner picks. For example,
  Extrait 110ml only.
- It uses the existing promotion settings: period, outlets, days, hours and the
  per-promo auto-apply switch.
- It stacks with promo codes and with points redemption in the same sale.
  - *My call:* a new Diskon Bundle is created with its "can be combined" switch on.
  - The existing per-promotion switch still rules: a code marked "can't be combined"
    still blocks it, as it blocks every automatic promotion today
    (`backend/internal/service/promo_resolve.go`, `apps/pos/src/cashier/autoPromos.ts`).
- When two Diskon Bundle promotions match the same bundle, only the bigger one applies to
  that bundle.
  - This is **new engine logic**, in both the Go pricing and the POS pricing twin. Today,
    combinable promotions add up, and "bigger wins" compares the whole cart, not each
    bundle.

### ERP

- The ERP receives the three items actually handed over. A swapped piece goes out as the
  fragrance that was actually given.
- Each item carries its share of the bundle price. The split follows each piece's normal
  single price, and any rupiah left over from rounding goes on the large bottle.
- A Diskon Bundle discount is split the same way.
- The ERP contract does not change: each sale line already carries its own `unit_price`
  from the order line price (`backend/internal/integration/erp/payload.go`, `buildLine`).
- *My call:* the bundle price and any Diskon Bundle are stored in the pieces' line prices.
  This is line repricing, the path Paket Bundel and BXGY reward lines already use, so
  `payload.go` needs no change.
  - Order-level discounts reach the ERP only through the payment lines, as today: promo
    codes, points, the cashier's cart discount, and cart-wide promotions.
  - `order_items.net_amount` is not sent today, and this design does not start sending it.

### Stock, receipt, refunds, reports

- **Stock:** the three items actually sold leave stock. A bundle's button shows "Habis"
  when its large bottle is out of stock.
- **Receipt:** one bundle line at the bundle price, with the three pieces under it, swaps
  included. A promo discount prints under the line.
- **Refund:** only the whole bundle can be refunded, the same rule the Paket Bundel
  promotion uses today. All three items return to stock, and the customer gets back what
  they paid for the bundle.
- **Reports:** a count of bundles sold per fragrance, line and size. The usual per-item
  sales still appear, with each item counted at its share of the bundle price, not its
  full single price.

### Backoffice

- **Produk › Bundle** tab (replaces today's read-only list):
  - **Standard bundle prices:** one field per large size (100ml, 110ml, 120ml).
  - **Line prices:** a table of the ERP lines found in the catalog (Extrait, Parfum
    Intense), each with an optional bundle price per large size. An empty price means
    the line uses the standard price. Lines are not created or renamed here.
  - **"Aroma yang punya bundle":** an automatic list of every fragrance with its bundles
    (line, size, price). A fragrance or line without a bundle shows why, for example
    "2ml Extrait belum ada" or "atomizer belum ada".
- **Promosi:** the new "Diskon Bundle" type in the existing promotion editor (mockup 3).
  Its line picker offers the ERP lines.
- Whoever can edit products can edit the bundle settings. Diskon Bundle follows the
  normal promotion permissions.
- Changes reach the tablets on their next catalog sync, like a product price change.

## My calls, which the owner may override

- **Three or more bundles on one card.** 24HOURS can have four: two lines by two sizes.
  - Up to two bundles show as buttons on the card.
  - With three or more, the card shows one gold "Bundle" button that opens a short list
    of its bundles (line, size, price), still above the single sizes.
- **Short line names on buttons.** "EXT" and "PI" on buttons, full names elsewhere.
- **What counts as a large size.** A large size is any size with a standard bundle price
  set: 100ml, 110ml and 120ml. Adding another large size later means adding a standard
  price, not new code.
- **Partial line prices.** A line can set its own price for one size only and use the
  standard price for the others.
- **Matching.**
  - Pieces are matched on the variant's ERP fields: size, and the category through
    `erpmap.Line`. They are not matched on the label text: `variantLabel` in
    `packages/types` only trims, and labels read "<size>ml <LINE>".
  - Variants with no ERP data (the test catalog, labels like "110ml") are matched on
    the size in the label and treated as having no line. Such a bundle uses the
    standard price.
- **Which promotions apply.** The bundle is the unit, so no promotion keyed to products
  ever counts a bundle piece, either to qualify or as a reward. That covers
  product-scoped percent or amount promotions, BXGY, BOGO and Paket Bundel.
  - This prevents a 120ml inside a bundle from also unlocking a BXGY reward.
  - Cart-wide discounts do apply to the whole sale, bundles included, at the bundle price:
    unscoped percent or amount promotions, tiered promotions on the subtotal, the
    cashier's cart discount, promo codes and points.
  - They apply in the order the engine already uses.
- **Points earned.** Points are earned on what was paid for the bundle, as for any item.
- **No swap available.** If no atomizer (or no 2ml of the line) of any fragrance is in
  stock, the bundle can't be completed and the cashier sells singles. Whether a piece may
  be sold below zero stock follows exactly the rule for single items today.
- **Split basis.** The price split uses the pieces' single prices at the moment of sale.
  A swapped piece uses its own single price.
- **Old bundle records.** The old `bundles` and `bundle_items` tables come only from the
  one-time Firestore import (`backend/internal/fsmigrate/tables.go`).
  - The new Bundle tab replaces their read-only list in
    `apps/backoffice/src/screens/Products.tsx`.
  - `GET /api/v1/bundles`, its generated types and the tables stay, unused by the UI.
  - There is no destructive migration.
- **"Paket Bundel" promotion.** It stays unchanged and separate. It frees the cheapest
  units, which would send Rp0 lines to the ERP: the opposite of the split rule here. It
  is not a base for this feature.

## Constraints

- **Offline-first.** Tablets price bundles from the cached catalog and settings, and the
  server re-checks every sale. Server pricing is authoritative
  (`backend/internal/service/pricing.go`); the Paket Bundel promotion already gets
  "Bundel tidak valid" (422) online. A bundle price that changes while a tablet is
  offline follows the same rule as a product price change today.
- **Guards.** Stock, sync, outbox and refund guards are never weakened. Anything that
  touches them is reviewed at Opus high (`AGENTS.md`, model routing).
- **API and generated types.**
  - API changes go through OpenAPI and the generated types (`corepack pnpm gen:check`).
  - A new top-level test in `backend/internal/api` or `internal/codegen` must be listed
    in `scripts/ci/codegen_gate.py`.
  - A `package.json` change ships with `pnpm-lock.yaml`.
- **Migrations** continue after the live 0088. Plan from `origin/prod-hardening`; the
  local checkout may be behind.
- **POS look.**
  - The POS follows "Kertas & Emas" (`docs/plans/2026-10-27-pos-ux-direction.md`): no
    dark theme and no discount gate.
  - The POS already groups sizes by line in places (`apps/pos/src/cashier/lineSizes.ts`);
    reuse that.
  - Visual slices are compared side by side with the mockups before they ship.
- **Shipping to tablets.** A POS change that touches only the web layer ships by OTA. A
  native change needs a new APK.

## Left to the builder

- The data model: tables and columns for standard prices and line prices.
- How an order item carries its bundle group, line, size and price share.
- The API shape.
- How the POS cart represents a bundle line, and how the swap list is built.
- Where the bundle report lives in the Backoffice.
- How the work is split into PRs and releases.
