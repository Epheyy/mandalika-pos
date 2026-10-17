/**
 * Ships client errors (sync dead-letters, runtime exceptions, print failures) to
 * the server so they appear in the Backoffice error log — instead of only living
 * in a clipboard dump. Best-effort: failures (offline / not logged in) are
 * swallowed; the local sync log still keeps a copy of sync failures.
 *
 * Outlet id and user are resolved server-side from the JWT; we send the device
 * id, a denormalized outlet name (for display), the failing payload, and the
 * activity breadcrumb trail.
 */

import { getDeviceId, getKV, redactForLogs, redactString } from '@mandalika/sync'
import { api } from '../api'
import { getBreadcrumbs } from './activityLog'

export interface ErrorReport {
  source: 'sync' | 'runtime' | 'print'
  kind?: string
  action?: string
  message: string
  payload?: unknown
  outletName?: string | null
}

const BATCH_SIZE = 10

let cachedDeviceId = ''
function deviceId(): string {
  if (!cachedDeviceId) {
    try {
      cachedDeviceId = getDeviceId(getKV())
    } catch {
      cachedDeviceId = ''
    }
  }
  return cachedDeviceId
}

export async function reportErrors(reports: ErrorReport[]): Promise<void> {
  if (!reports.length) return
  const breadcrumbs = getBreadcrumbs()
  const now = new Date().toISOString()
  const appVersion = import.meta.env.DEV ? 'pos-dev' : 'pos'
  const items = reports.map((r) => ({
    deviceId: deviceId() || null,
    outletName: r.outletName ?? null,
    source: r.source,
    kind: r.kind ?? null,
    action: r.action == null ? null : redactString(r.action),
    // Redact on the device (secrets + customer PII); the server redacts again
    // as a backstop for older bundles. Copies only: never touches the source.
    message: redactString((r.message || 'unknown error').slice(0, 1000)),
    payload: r.payload == null ? null : redactForLogs(r.payload),
    breadcrumbs: redactForLogs(breadcrumbs),
    appVersion,
    clientCreatedAt: now,
  }))
  // The server refuses batches over 50 items / 256 KB whole, so send small chunks.
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    try {
      await api.request('POST', '/api/v1/error-logs', { items: items.slice(i, i + BATCH_SIZE) })
    } catch {
      // best-effort — offline or unauthenticated; nothing else to do here
    }
  }
}

let installed = false
const recent = new Map<string, number>()
/** Skip the same error message within a 10s window to avoid flooding. */
function throttled(key: string): boolean {
  const now = Date.now()
  if (now - (recent.get(key) ?? 0) < 10_000) return true
  recent.set(key, now)
  return false
}

/** Capture uncaught errors + unhandled promise rejections as runtime errors. */
export function installGlobalErrorHandler(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => {
    const msg = e.message || String((e.error as Error)?.message ?? 'uncaught error')
    if (throttled('e:' + msg)) return
    void reportErrors([{
      source: 'runtime', kind: 'uncaught',
      action: e.filename ? `${e.filename}:${e.lineno}` : undefined,
      message: msg, payload: { stack: (e.error as Error)?.stack ?? null },
    }])
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    if (throttled('r:' + msg)) return
    void reportErrors([{
      source: 'runtime', kind: 'unhandledrejection',
      message: msg, payload: { stack: reason instanceof Error ? reason.stack : null },
    }])
  })
}
