# Mandalika POS — Native Shell (Phase E)

Cashier POS wrapped with Capacitor 8 → installable Android/iOS app: no browser
chrome, no accidental pull-to-refresh, secure token storage, native BLE ESC/POS
receipt printing. Backoffice stays a web SPA.

## Layout

- `capacitor.config.ts` — appId `com.mandalika.pos`, `webDir: dist`, SplashScreen
  + BLE display strings. No `server.url` → the bundled `dist/` is served from
  the app (cannot refresh out to a browser).
- `src/native.ts` — status bar, Android back-button guard (minimize, never exit
  mid-sale), splash hide once first sync settles.
- `src/printer.tsx` — printer context: pair/reprint/test, paired id in secure KV.
- `@mandalika/printer` — `buildReceipt` (ESC/POS, 58 mm / 32 col) →
  `PrinterTransport` (`CapacitorBleTransport` | `NoopTransport`).
- Secure storage — `@mandalika/sync` `initSecureKV()` swaps the KV seam to
  Capacitor Preferences on native (refresh token, outbox, device id, snapshot);
  localStorage stays on web. Booted in `main.tsx` before React reads state.

## Printer

Target hardware confirmed with operator: **I-Ware C5813** (58 mm Bluetooth
ESC/POS, generic serial profile). No published GATT UUIDs → the transport
auto-discovers the first writable characteristic and prefers known vendor
service UUIDs. `app_settings.receipt.autoPrint`/`copies` (Backoffice-owned)
drive post-order printing; works on offline-queued orders too (printing is
local BLE, independent of sync). HTML `ReceiptPreview` remains the on-screen
fallback + manual reprint.

Pair via **Pengaturan → Printer Bluetooth → Pasangkan Printer**, then **Tes
Cetak**.

## Build & run (Android)

Prereqs: Android Studio (SDK + JDK). `android/local.properties` `sdk.dir` is
machine-specific and git-ignored.

```bash
pnpm --filter @mandalika/pos build           # tsc -b + vite → dist/
pnpm --filter @mandalika/pos exec cap sync android
pnpm --filter @mandalika/pos exec cap open android   # → run on device/emulator
# or headless:
cd apps/pos/android && ./gradlew assembleDebug
```

Point the app at the API at build time:

```bash
VITE_API_URL=https://api.example.com pnpm --filter @mandalika/pos build
```

Regenerate launcher/splash after artwork changes:

```bash
node apps/pos/assets/gen-source.cjs           # placeholder source art
pnpm --filter @mandalika/pos exec capacitor-assets generate --android --assetPath assets
```

## iOS

iOS requires macOS + Xcode (not buildable on this Windows host). On a Mac:

```bash
pnpm --filter @mandalika/pos exec cap add ios
pnpm --filter @mandalika/pos exec cap sync ios
pnpm --filter @mandalika/pos exec cap open ios
```

Add to `ios/App/App/Info.plist`: `NSBluetoothAlwaysUsageDescription` =
"Mandalika POS uses Bluetooth to print receipts."

## Permissions

`AndroidManifest.xml` declares Android 12+ `BLUETOOTH_SCAN`
(`neverForLocation`) + `BLUETOOTH_CONNECT`, legacy `BLUETOOTH`/
`BLUETOOTH_ADMIN`/`ACCESS_FINE_LOCATION` (`maxSdkVersion=30`), and requires the
`bluetooth_le` feature. The plugin requests runtime permission on first scan.
