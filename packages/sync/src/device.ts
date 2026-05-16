import type { KV } from './storage'

const DEVICE_KEY = 'mandalika.pos.deviceId'

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  // RFC4122-ish fallback for older WebViews.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** Stable per-install device id; the prefix of every idempotency key. */
export function getDeviceId(kv: KV): string {
  let id = kv.get(DEVICE_KEY)
  if (!id) {
    id = uuid()
    kv.set(DEVICE_KEY, id)
  }
  return id
}

export { uuid }
