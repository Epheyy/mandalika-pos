# Per-Variant Scan Key + Scan-to-Cart — Design

Date: 2026-05-25 · Branch: `prod-hardening`

## Goal

Replace the parent-product `products.upc` (one code per product, added in
migration 0013) with a **per-variant scan key** (`product_variants.barcode`),
and use it to power **scan-to-cart** in the POS via two input methods:
keyboard-wedge (HID) scanners and the device camera. A scan resolves to exactly
one variant and adds 1 to the cart immediately, respecting stock.

Why: a single parent UPC is ambiguous — if a product has multiple variants
(sizes), one code can't say which variant to pull. The scan key must live on the
variant. (See memory `product-module-roadmap`; this project is a 3-brand
template, so the scan key is a per-variant identity primitive future modules
reuse.)

## Decisions (locked with the user)

| Question | Decision |
|---|---|
| Scan input method | **Both** keyboard-wedge (HID) and device camera |
| QR vs barcode | **Both** — see "QR support" below |
| Scan key per variant | **Dedicated `barcode` field, defaults to SKU** (editable) |
| Uniqueness scope | **Catalog-wide unique** (DB partial index + write validation) |
| On successful scan | **Add 1 immediately, respect stock** |
| Label/QR generation+printing | **Out of scope** this pass (YAGNI) |

### QR support

- **Keyboard-wedge**: symbology-agnostic. A QR-capable HID scanner types the
  encoded string + CR; the POS only ever sees a string, so QR == barcode to it.
- **Camera**: Google ML Kit (`@capacitor-mlkit/barcode-scanning`) decodes
  `QR_CODE` plus 1D (EAN-13, UPC-A, Code-128) and other 2D formats. We include
  `QR_CODE` in the accepted-formats list.
- Condition: the QR/barcode must encode the variant's `barcode` value.

## Current state (verified)

- Variants are keyed by `size` within a product; each has a stable `id`, `size`,
  `price`, `stock`, `sku` (required, **unique per product** via
  `idx_variant_product_sku`, migration 0012), `parLevel`.
- `products.upc` is a single parent-level field (migration 0013); the live POS
  reads it **nowhere** (`apps/pos/src` has no `upc` reference) → safe to remove
  from the API for APKs already in the field.
- POS search (`ProductGrid.tsx`) filters by product **name only**; tapping a
  product opens a variant-qty popup (or adds directly if single-variant) via
  `onProductTap(product, { [size]: qty })`. **No barcode scanning exists yet.**
- `ProductInput.variants` references the `ProductVariant` schema, so adding
  `barcode` to `ProductVariant` covers read **and** write in one place.
- POS is offline-first (sync engine); the scan lookup is against the locally
  synced catalog, so scanning works offline. `sellable=false` products are
  already excluded from sync, so they never enter the scan index.

## Architecture

### 1. Data model — migration `0014_variant_barcode.sql`

```sql
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode text NOT NULL DEFAULT '';

-- existing variants scan immediately: default the scan key to the SKU
UPDATE product_variants SET barcode = sku WHERE barcode = '';

-- prefer any real parent UPC: copy it onto the product's first variant
UPDATE product_variants v SET barcode = p.upc
  FROM products p
 WHERE v.product_id = p.id AND p.upc <> ''
   AND v.id = (SELECT id FROM product_variants v2 WHERE v2.product_id = p.id ORDER BY id LIMIT 1);

-- defensively dedupe before the unique index so the migration cannot fail-to-boot
-- (auto-generated SKUs are uuid-derived and effectively unique; this only fires
--  on genuine collisions)
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY barcode ORDER BY id) AS rn
    FROM product_variants WHERE barcode <> ''
)
UPDATE product_variants v
   SET barcode = v.barcode || '-' || left(replace(v.id::text, '-', ''), 4)
  FROM d WHERE d.id = v.id AND d.rn > 1;

-- catalog-wide unique on non-empty scan keys (empty never collides)
CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_barcode
  ON product_variants (barcode) WHERE barcode <> '';

-- the parent UPC is now fully replaced
ALTER TABLE products DROP COLUMN IF EXISTS upc;
```

Migration-runner note: runner tracks by full filename; next number is 0014
(0013 is the highest existing). Do not rename prior migrations.

### 2. API (`backend/api/openapi.yaml` → regen Go + TS)

- `ProductVariant`: **add** `barcode: { type: string }` (non-required;
  server defaults to `''`). Covers read and `ProductInput` write.
- `Product`: **remove** `upc`.
- `ProductInput`: **remove** `upc`.
- Regen: `make gen-go` (commit `api.gen.go`), then
  `corepack pnpm --filter @mandalika/api gen` (TS types).

### 3. Backend

- **read/repo.go `productObjScoped`** (both scoped + cross-all branches): drop
  `'upc',p.upc`; add `'barcode',v.barcode` to the variant JSON object. This
  flows into the POS sync bundle automatically.
- **write/repo.go**:
  - `Product` struct: remove `UPC`.
  - Variant write: persist `barcode` per variant.
  - On the Postgres `unique_violation` (code `23505`) for `idx_variant_barcode`,
    translate to a friendly, non-leaky error naming the colliding barcode. It
    surfaces as the codebase's standard `400` validation response (the shared
    `created`/`mutated` handlers map all write-validation errors to 400 — we
    follow that convention rather than adding a bespoke 409 path), and the
    backoffice shows the message inline.
- Sync / order service: unchanged — `barcode` rides along on the variant; the
  cart and order lines still key by `size`.

### 4. Backoffice (`apps/backoffice/src/screens/Products.tsx`)

- Remove the parent-level "UPC / Barcode" `<Input>` and `form.upc`.
- Per-variant **Barcode** field beside SKU in each variant editor row. It
  **mirrors the SKU as the user types until they override it** (the
  "defaults to SKU" behavior): track a per-row `barcodeTouched` flag; while
  untouched, keep `barcode === sku`; once edited, it stays independent.
- Surface the backend 409 collision error inline (which barcode clashed).
- **CSV** (already per-variant rows): replace the parent `UPC` export column
  with a per-variant `Barcode` column (`v.barcode`). Import reads `Barcode`,
  falling back to the existing variant barcode, then the SKU.

### 5. POS scan-to-cart (`apps/pos`)

Shared:
- Build a `Map<barcode, { product, variant }>` from the synced catalog (memoized
  over the products list). Lookup is exact-match on the trimmed scanned string.
- **Resolve-and-add** helper: given a matched variant, add 1 via the existing
  `onProductTap(product, { [variant.size]: 1 })` path (increment if already in
  cart). Respect stock: if `inCartQty + 1 > variant.stock`, block. Emit brief
  feedback (toast): `Ditambah: <name> <size>` / `Stok habis` /
  `Kode tidak dikenal`.

Keyboard-wedge path (no new dependency):
- On **Enter** in the existing search input, if the trimmed query exactly
  matches a barcode in the map → resolve-and-add, then clear the box. If no
  match → leave it as the normal name filter. (Match on Enter because wedge
  scanners append a CR; this avoids firing mid-typing.)

Camera path:
- Add `@capacitor-mlkit/barcode-scanning`.
- A **Scan** button next to the search box opens the camera scanner configured
  for `QR_CODE`, `EAN_13`, `UPC_A`, `CODE_128` (and other common formats). On a
  decoded value → resolve-and-add.
- Requires: plugin install, Android camera permission in the manifest, and an
  APK rebuild via CI (local APK build is blocked on Windows — see
  SESSION_HANDOFF.md).

## Components / boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| migration 0014 | add+backfill+dedupe+unique `barcode`, drop `products.upc` | existing schema |
| openapi + codegen | expose `barcode` on variant, drop `upc` | — |
| read/repo.go | include `barcode` in product/variant reads | schema |
| write/repo.go | persist `barcode`, map 23505 → 409 | schema |
| Products.tsx | per-variant barcode field (SKU-mirroring) + CSV column | API types |
| POS scan index | `Map<barcode, {product,variant}>` from synced catalog | sync bundle |
| POS resolve-and-add | add 1, respect stock, feedback | cart dispatch |
| POS wedge handler | Enter in search → resolve-and-add | scan index |
| POS camera scan | ML Kit plugin + Scan button → resolve-and-add | scan index, native |

## Error handling

- Duplicate barcode on save/import → backend 409 naming the clash; backoffice
  shows it inline (no silent overwrite).
- Empty barcode is allowed (never collides; that variant simply isn't scannable).
- Unknown scanned code → toast `Kode tidak dikenal`, no cart change.
- Scanned variant out of stock (or would exceed stock) → toast `Stok habis`,
  no cart change.
- Camera permission denied → fall back gracefully (keyboard-wedge still works);
  show a one-line hint.

## Testing

- **Backend**: migration applies on the live DB without boot failure; barcode
  round-trips on product read/write; duplicate barcode rejected with 409;
  per-variant `barcode` present in a POS sync pull.
- **Backoffice**: barcode mirrors SKU until edited; CSV export has `Barcode`
  column; CSV import sets per-variant barcode; collision error surfaces.
- **POS (browser)**: wedge path — typing a known barcode + Enter adds the right
  variant and clears the box; unknown code and out-of-stock show the right
  toast; offline lookup works.
- **POS (device)**: camera scan of a QR and a 1D barcode each add the correct
  variant; permission-denied degrades gracefully.

## Out of scope (YAGNI)

- Printable QR/label generation.
- Per-outlet barcode overrides (barcode is catalog-global, like SKU).
- Bulk re-barcoding tools beyond CSV.

## Build / verify order

1. Migration 0014 + backend (openapi, read, write) → deploy → `/readyz` →
   verify round-trip + dup rejection + sync pull carries barcode.
2. Backoffice (per-variant barcode field + CSV) → build → verify.
3. POS keyboard-wedge path (no native dep) → testable in browser.
4. POS camera plugin + manifest permission → APK rebuild via CI → on-device
   scan test (QR + 1D).
