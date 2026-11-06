import type { CapacitorConfig } from '@capacitor/cli'

// Native shell for the Cashier POS (plan §6). React unchanged, wrapped via
// Capacitor → installable iOS/Android app: no browser chrome, no accidental
// pull-to-refresh, secure token storage (Capacitor Preferences, plan §7),
// native BLE ESC/POS printing (plan §6). Backoffice stays a web SPA.
const config: CapacitorConfig = {
  appId: 'com.mandalika.pos.probe',
  appName: 'POS Probe A9',
  webDir: 'dist',
  // No `server.url` → the bundled `dist/` is served from the app, so the
  // shell never points at a dev server and cannot accidentally refresh to a
  // browser tab. Override VITE_API_URL at build time for the device target.
  android: {
    // PROD: false — the prod API is HTTPS, so the https://localhost WebView
    // makes only secure-context requests. For LAN dev against a plain-http
    // backend, temporarily flip to true locally (never commit true).
    allowMixedContent: false,
    // TEMP (polish phase): surface the WebView console in logcat /
    // chrome://inspect on the CI release APK. Revert before true-final.
    webContentsDebuggingEnabled: true,
  },
  // 'debug' = native/console logs only in debug builds; signed release APKs stay silent ('production' would always log).
  loggingBehavior: 'debug',
  ios: {
    contentInset: 'always',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: false, // hidden in code once SyncProvider is ready
      backgroundColor: '#1a1008', // brand-dark, matches @drawable/splash
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    CapacitorBluetoothLe: {
      displayStrings: {
        scanning: 'Mencari printer…',
        cancel: 'Batal',
        availableDevices: 'Printer tersedia',
        noDeviceFound: 'Printer tidak ditemukan',
      },
    },
    CapacitorUpdater: {
      // The config runs in Node at `cap sync`, so it reads the same build-time
      // VITE_API_URL the APK workflow injects (falls back to the prod URL).
      updateUrl: `${process.env.VITE_API_URL ?? 'https://mandalika-pos-538849926142.asia-southeast2.run.app'}/api/v1/ota/check`,
      autoUpdate: false,
    },
  },
}

export default config
