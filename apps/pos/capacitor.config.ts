import type { CapacitorConfig } from '@capacitor/cli'

// Native shell for the Cashier POS (plan §6). React unchanged, wrapped via
// Capacitor → installable iOS/Android app: no browser chrome, no accidental
// pull-to-refresh, secure token storage (Capacitor Preferences, plan §7),
// native BLE ESC/POS printing (plan §6). Backoffice stays a web SPA.
const config: CapacitorConfig = {
  appId: 'com.mandalika.pos',
  appName: 'Mandalika POS',
  webDir: 'dist',
  // No `server.url` → the bundled `dist/` is served from the app, so the
  // shell never points at a dev server and cannot accidentally refresh to a
  // browser tab. Override VITE_API_URL at build time for the device target.
  android: {
    // PROD: false — the prod API is HTTPS, so the https://localhost WebView
    // makes only secure-context requests. For LAN dev against a plain-http
    // backend, temporarily flip to true locally (never commit true).
    allowMixedContent: false,
    // TEMP (diagnosis): surface the WebView console in logcat / chrome://inspect
    // on the release build. Revert before final.
    webContentsDebuggingEnabled: true,
  },
  loggingBehavior: 'debug',
  ios: {
    contentInset: 'always',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: false, // hidden in code once SyncProvider is ready
      backgroundColor: '#4f46e5',
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
  },
}

export default config
