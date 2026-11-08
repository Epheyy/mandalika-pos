# Brand builds (Mandalika, Flamboyan, Performance Perfume)

The POS is one template for three brands. The brand is chosen **at build time** with `VITE_BRAND`
(decision D-29 in `docs/plans/2026-10-27-pos-ux-direction.md`). Unset or empty means `mandalika`; an
unknown value falls back to `mandalika` and logs one `[brand]` console warning.

## Build each brand

```bash
corepack pnpm --filter @mandalika/pos build                          # Mandalika (default)
VITE_BRAND=flamboyan corepack pnpm --filter @mandalika/pos build     # Flamboyan
VITE_BRAND=performance corepack pnpm --filter @mandalika/pos build   # Performance Perfume
```

(PowerShell: `$env:VITE_BRAND='flamboyan'; corepack pnpm --filter @mandalika/pos build`.)
For an APK, set `VITE_BRAND` in the environment of the `android-release.yml` build step before `vite build`.

What the variable selects (registry: `apps/pos/src/brand/brands.ts`):

| Brand | Primary | Pressed | Skin overrides |
|---|---|---|---|
| mandalika | `#b07d18` | `#8f6412` | none |
| flamboyan | `#9b59b6` | 15 % darker | `promo` `#1d4ed8` (blue), `info` `#475569` (slate); reward stays teal (D-27) |
| performance | `#a93226` | 15 % darker | solid danger surfaces use `ink-900` (D-28) |

`applyBrand()` runs in `main.tsx` before first render and sets `--color-brand`, `--color-brand-pressed`
and the overrides on `<html>`. The legacy `indigo-*` remap and its per-skin derivation were deleted in slice Z; screens use token classes. The brand also picks
the logo, the `displayName` (login panel, receipt preview, header alt text) and the fallback receipt
header (`receiptHeader`, used only when the pulled snapshot has no `appSettings`; the backend value wins
as a whole object, so a backend header of '' stays empty. `packages/printer` code is untouched, but it prints
this same settings object, so the fallback would reach paper in that rare no-settings case).

Logos: UI uses 240 px webp copies (`brands/*-logo-240.webp`, about 9 KB each); the 2000 px originals stay
in `assets/brands/` for print and marketing and are not imported. Vite emits every imported logo in every
build (about 46 KB total); that is accepted rather than adding per-brand dynamic imports.

## Colour rules (D-17, D-27, D-28)

- The brand colour is reserved for the next action (Bayar/Konfirmasi bars, selected chips, logo).
- Semantic colours (ok, warn, danger, info, promo, reward) never stand in for brand, and brand never
  stands in for a state. Cashiers moving between brands keep the same meaning of red, amber, green.
- Flamboyan purple would collide with promo plum, so in that skin only `promo` becomes blue and `info` slate.
- Performance red would collide with danger, so in that skin only the *solid* danger surfaces
  (`bg-danger-solid`: Button `danger`, Refund confirm, the shift-error and outbox-corrupt bars, outlet-mismatch/terminal/requisition confirm buttons) become `ink-900`; danger
  badges and text keep `#b42318` on the `danger-bg` tint. Badges stay colour + icon + word.
- New solid danger fills must use `bg-danger-solid`, never `bg-danger` or `bg-red-*`.

## Feature flags (scaffold, all true)

`hasFeature('loyalty' | 'requisitions' | 'giveaway' | 'customerProfile')` reads the registry. Wired today:

- `requisitions`: Permintaan Barang entry in `MenuDrawer`.
- `loyalty`: the Hadiah & Poin block in `CheckoutPanel`.
- `giveaway`, `customerProfile`: declared but **not wired** yet (the customer profile screen does not exist;
  the promo giveaway pickers are priced server-side, so hiding them needs a backend counterpart first).

Flags change only what the cashier sees. A hidden feature still exists server-side.

## Where business differences must live

Pricing, promo types, tax, rounding, loyalty rules and receipt layout differ per company and stay in
**backend app-settings per deployment**: each brand gets its own backend deployment (own DB, own settings)
of the same template, so no per-brand business logic is branched in POS code. If a difference cannot be a
setting, it is a new setting, not an `if (brand.id === ...)`.

## Per-brand OTA (not implemented)

Today `apps/pos/capacitor.config.ts` has a single `appId: 'com.mandalika.pos'`, one OTA bucket and one
`/ota/check`. `make ota-release VERSION=x.y.z` builds one bundle (the default `mandalika` brand, since
`VITE_BRAND` is unset) and targets one APK versionCode. Shipping the same bundle to a Flamboyan tablet would
paint it Mandalika, and a brand bundle would repaint a Mandalika tablet. Two ways to separate them:

1. **Separate app ids and deployments (recommended).** Each brand is its own app (`com.flamboyan.pos`,
   `com.performance.pos`) with its own APK, its own backend deployment (so its own `ota_releases` table and
   `/ota/check`), its own bucket, and `VITE_BRAND` fixed in its build. `make ota-release` would take
   `BRAND=flamboyan` and pass `VITE_BRAND`, the bucket and API URL through. Cleanest isolation and matches the
   one-deployment-per-brand rule; costs three APK pipelines and Play listings.
2. **One app id with a brand field in `/ota/check`.** The bundle metadata and the check request carry
   `brand`; the backend offers a release only when `release.brand == request.brand`; the APK reports its brand
   (needs a native build constant or a stored setting). Fewer pipelines, but one app serves several brands,
   the brand must still be baked into each bundle, and a wrong value ships the wrong skin to a till.

Do not run `make ota-release` for a non-default brand until one of these exists. APK builds use origin
(`android-release.yml`), so push first.

## Known gaps

- `VITE_BRAND` is not yet an input of `android-release.yml`, and an unknown value only warns at runtime (a typo such as `Flamboyan` ships the Mandalika skin). Consider failing the build in `vite.config.ts` on an unknown non-empty value, and `index.html` still says "Mandalika POS".
- With a flag off, `loyaltyPreview`, Cart and CustomerPicker still show points; fold `hasFeature('loyalty')` into `loyalty.enabled` at the source before relying on it.

## Owner decisions (2026-10-27)

- Mandalika login screen on brand tokens: accepted.
- 12 h lock Banner stays a tint (no solid surface): confirmed.
- Per-brand OTA: separate app ids and deployments (option 1) when a second brand ships.
- Failing the build on an unknown `VITE_BRAND` and the `android-release.yml` input are deferred until the Mandalika release is done. Goal stays one codebase for all brands.
