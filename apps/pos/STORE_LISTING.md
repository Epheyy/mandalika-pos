# Store Listing Prep — Mandalika POS (Cashier)

Internal cashier app. Distribution is expected to be **private** (Google Play
internal/closed track or direct APK to outlet devices), not public search.

## Identity

- App name: **Mandalika POS**
- Package / bundle id: `com.mandalika.pos`
- Category: Business
- Default language: Indonesian (id-ID)
- Audience: store staff (cashiers) — not consumer-facing

## Short description

> Aplikasi kasir Mandalika: transaksi cepat, mode offline, cetak struk
> Bluetooth.

## Full description

> Mandalika POS adalah aplikasi kasir untuk outlet. Bekerja penuh tanpa
> internet (offline-first) dan menyinkronkan transaksi dengan aman saat
> kembali daring. Mendukung cetak struk via printer Bluetooth ESC/POS 58 mm,
> manajemen shift, diskon & promo, serta pelanggan & loyalti. Data referensi
> dikelola dari Backoffice; kasir hanya menambah transaksi (tidak ada konflik
> data).

## Assets to finalize before submission

Placeholder brand art lives in `assets/` (indigo "M"). Replace with final
artwork, then `node assets/gen-source.cjs`-equivalent + `pnpm cap:assets`.

- [ ] App icon 512×512 (Play) / 1024×1024 (App Store) — replace `assets/icon-only.png`
- [ ] Adaptive icon foreground/background — `assets/icon-foreground.png` / `icon-background.png`
- [ ] Feature graphic 1024×500 (Play)
- [ ] Phone + 7"/10" tablet screenshots (cashier flow, receipt, offline banner)
- [ ] Splash — `assets/splash.png` / `splash-dark.png`

## Data safety / privacy

- Collects: staff login (email), transaction data. No advertising id, no
  location (BLE declared `neverForLocation`).
- Data encrypted in transit (HTTPS, Bearer JWT). Tokens stored in OS-backed
  secure storage (Capacitor Preferences → Keystore/Keychain).
- Provide a privacy policy URL (internal) in the Play Console Data Safety form.

## Permissions rationale (for review)

- Bluetooth (scan/connect): pairing and printing to the receipt printer only.
- Internet: sync transactions with the Mandalika backend.

## Release checklist

- [ ] `VITE_API_URL` points at production API for the release build
- [ ] Versioned `android/app/build.gradle` `versionCode`/`versionName`
- [ ] Signed release (upload keystore in CI secret store, never committed)
- [ ] Internal testing track smoke: login → sale → offline → resync → print
- [ ] iOS build done on macOS with `NSBluetoothAlwaysUsageDescription` set
