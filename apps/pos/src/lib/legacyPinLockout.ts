import { getKV } from '@mandalika/sync'

/** Where the retired on-device receive-PIN lockout lived (A08 moved lockout to the server). */
export const LEGACY_PIN_LOCKOUT_KEY = 'mandalika.pos.pinLockout'

/** Boot cleanup: forget the old local lockout state. Best effort; it is only dead data. */
export function dropLegacyPinLockout(): void {
  try {
    getKV().remove(LEGACY_PIN_LOCKOUT_KEY)
  } catch {
    /* storage unavailable: nothing to clean */
  }
}
