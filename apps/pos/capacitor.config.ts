// Native shell is built in Phase E (iOS/Android, secure token storage,
// no-refresh shell, BLE ESC/POS). Typed loosely here because @capacitor/cli
// is not a Phase B dependency yet.
const config = {
  appId: 'com.mandalika.pos',
  appName: 'Mandalika POS',
  webDir: 'dist',
  server: { androidScheme: 'https' },
}

export default config
