// Server-assigned device code for receipt numbers (see orderRef.ts).
//
// Each install asks the server once, online, for a short letter code at its bound outlet
// (AA, AB ... ZZ, AAA ...). Codes are never reused at an outlet, so numbers built from
// {OUTLET}-{CODE}{SEQ} cannot repeat across tablets or reinstalls. This never blocks a
// sale: until a code is stored for the bound outlet, numbering stays on the legacy format.

import type { KV } from '@mandalika/sync'

/** Durable JSON {outletId, code}. Cleared with the other outlet data (terminalBinding.ts). */
export const DEVICE_CODE_KEY = 'mandalika.pos.deviceCode'

const CODE_RE = /^[A-Z]{2,}$/

/** The stored code, only when it was registered for `outletId`; a malformed value counts as absent. */
export function readDeviceCode(kv: KV, outletId: string | null | undefined): string | null {
  if (!outletId) return null
  const raw = kv.get(DEVICE_CODE_KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { outletId?: unknown; code?: unknown } | null
    if (v && v.outletId === outletId && typeof v.code === 'string' && CODE_RE.test(v.code)) return v.code
  } catch {
    /* unreadable: treated as absent, registration runs again */
  }
  return null
}

interface DeviceRegistrar {
  registerDevice: (deviceId: string) => Promise<{ code: string }>
}

const inFlight = new Map<string, Promise<string | null>>()
// After a client error that retrying will not fix (4xx), wait before asking again: long enough
// not to hammer the server, short enough that a tablet that registered before the backend was
// deployed picks a code up without a restart. Also reset on mount / sign-in.
export const REGISTRATION_BACKOFF_MS = 15 * 60_000
const backoffUntil = new Map<string, number>()

/** A client error that retrying right away cannot fix. 401 (session renewal), 408, 409 (busy)
 *  and 429 stay retryable on the next tick. */
function isPermanent(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && ![401, 408, 409, 429].includes(status)
}

/** true while a refused registration is waiting out its back-off. */
export function registrationGaveUp(outletId: string, deviceId: string): boolean {
  return Date.now() < (backoffUntil.get(`${outletId}:${deviceId}`) ?? 0)
}

export function resetRegistrationBackoff(): void {
  backoffUntil.clear()
}

/**
 * Make sure a code is stored for `outletId`, registering with the server when it is not.
 * Resolves with the code, or null when it could not be obtained (offline, server error,
 * unusable answer). Never rejects, so callers can fire it and carry on selling.
 */
export function ensureDeviceCode(
  kv: KV,
  api: DeviceRegistrar,
  outletId: string,
  deviceId: string,
): Promise<string | null> {
  const known = readDeviceCode(kv, outletId)
  if (known) return Promise.resolve(known)
  const key = `${outletId}:${deviceId}`
  if (registrationGaveUp(outletId, deviceId)) return Promise.resolve(null)
  const running = inFlight.get(key)
  if (running) return running
  const p = (async (): Promise<string | null> => {
    try {
      const { code } = await api.registerDevice(deviceId)
      if (typeof code !== 'string' || !CODE_RE.test(code)) return null
      await kv.setDurable(DEVICE_CODE_KEY, JSON.stringify({ outletId, code }))
      return code
    } catch (err) {
      if (isPermanent(err)) backoffUntil.set(key, Date.now() + REGISTRATION_BACKOFF_MS)
      return null // network / 5xx / 409: retried on the next tick
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}
