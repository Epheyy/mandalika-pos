import type { StockRequisitionInput } from '@mandalika/api'
import type { KV } from '@mandalika/sync'

// Idempotency keys for the PB writes. One key per (operation, PB id, content signature): a retry after a
// lost response replays the same write; only an edit mints a new key.
//
// Create is the only write whose lost key would duplicate a document (a fresh key = a second draft PB), so
// the pending create is persisted in the app KV, scoped by user and outlet: {sig, key, input, form, sent}.
// `sent` is set BEFORE the request leaves (a crash mid-flight must still count) and cleared only when it is
// known that nothing reached the server (offline refusal). While `sent` is true the record is UNCONFIRMED:
// the next save re-sends the OLD input with the OLD key first (see requisitionSave), whatever the form now
// says, so a PB the server may have created is never orphaned by an edit. Update/submit/cancel keys stay
// in memory: after a restart they get a fresh key, which is harmless (an extra "updated" row, or a 409
// that means "refetch").

export interface KeyScope { userId: string; outletId: string }
export type KeyedOp = 'update' | 'submit' | 'cancel'

export interface PendingCreate<F = unknown> {
  sig: string
  key: string
  /** Exactly what was (or will be) sent with `key`; a replay must carry the same body. */
  input: StockRequisitionInput
  form: F
  /** A request with `key` may have reached the server: the outcome is unconfirmed. */
  sent: boolean
}

export interface RequisitionKeys {
  /** Key for update / submit / cancel of an existing PB, stable for the same content signature. */
  keyFor(op: KeyedOp, docId: string, sig: string): string
  /** Drop the key (a 409 key-conflict or a success) so the next attempt mints a new one. */
  forget(op: KeyedOp, docId: string): void
  /** The pending create: in memory, else the one that survived an app restart. */
  loadPendingCreate<F = unknown>(): PendingCreate<F> | null
  /** Persist a create as sent (reusing the key of a record with the same signature) and return its key. */
  beginCreate<F>(sig: string, input: StockRequisitionInput, form: F): Promise<string>
  /** Nothing reached the server (offline refusal): keep the form, drop the "may exist" flag. */
  markCreateUnsent(): Promise<void>
  /** The create is resolved (success, a definitive refusal, or discarded). */
  clearPendingCreate(): Promise<void>
  /** The last local write or removal of the pending record failed: it may not survive an app restart. */
  storageFailed(): boolean
}

export function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/**
 * MUST start with `mandalika.`: on Android CapacitorPreferencesKV.hydrate only loads keys with that prefix (the rest
 * of the POS uses `mandalika.pos.`), so any other key silently vanishes at the next app start. Pinned by a test
 * that round-trips this key through a hydrated CapacitorPreferencesKV.
 */
export const pendingCreateStorageKey = (s: KeyScope): string => `mandalika.pos.requisition.pendingCreate.${s.userId}.${s.outletId}`

/** A resolved record whose removal failed is overwritten with this, so it is never resurrected after a restart. */
const RESOLVED_MARKER = JSON.stringify({ resolved: true })

export function createRequisitionKeys(kv: KV, scope: KeyScope, onWarn?: (what: string, err: unknown) => void): RequisitionKeys {
  const mem = new Map<string, { sig: string; key: string }>()
  const storageKey = pendingCreateStorageKey(scope)
  // `current` is the truth once this store has touched the record; the KV only seeds it after a restart.
  let current: PendingCreate | null = null
  let touched = false
  let failed = false
  const warn = (what: string, err: unknown): void => { failed = true; try { onWarn?.(what, err) } catch { /* reporting must not break a save */ } }

  const read = (): PendingCreate | null => {
    const raw = kv.get(storageKey)
    if (!raw) return null
    try {
      const v = JSON.parse(raw) as Partial<PendingCreate> & { resolved?: boolean }
      if (v.resolved === true) {
        // A tombstone from a failed removal: retry the removal now and treat the record as gone.
        void kv.removeDurable(storageKey).catch(() => undefined)
        return null
      }
      if (typeof v.sig !== 'string' || typeof v.key !== 'string' || !v.input) return null
      return { sig: v.sig, key: v.key, input: v.input, form: v.form, sent: v.sent === true }
    } catch {
      return null
    }
  }
  const load = (): PendingCreate | null => {
    if (!touched) { current = read(); touched = true }
    return current
  }
  const persist = async (p: PendingCreate): Promise<void> => {
    current = p
    touched = true
    // A failed write must not block the request (the record is still held in memory) but it is reported:
    // the panel tells the cashier not to close the app until the request is confirmed.
    try { await kv.setDurable(storageKey, JSON.stringify(p)); failed = false } catch (e) { warn('pendingCreate write failed', e) }
  }

  return {
    keyFor(op, docId, sig) {
      const id = `${op}:${docId}`
      const cur = mem.get(id)
      if (cur && cur.sig === sig) return cur.key
      const next = { sig, key: newKey() }
      mem.set(id, next)
      return next.key
    },
    forget(op, docId) { mem.delete(`${op}:${docId}`) },
    loadPendingCreate<F>() { return load() as PendingCreate<F> | null },
    async beginCreate<F>(sig: string, input: StockRequisitionInput, form: F) {
      const prev = load()
      const key = prev && prev.sig === sig ? prev.key : newKey()
      await persist({ sig, key, input, form, sent: true })
      return key
    },
    async markCreateUnsent() {
      const prev = load()
      if (prev) await persist({ ...prev, sent: false })
    },
    async clearPendingCreate() {
      current = null
      touched = true
      try {
        await kv.removeDurable(storageKey)
        failed = false
      } catch (e) {
        // Could not delete the resolved record: overwrite it with a marker so a restart cannot resurrect it.
        try { await kv.setDurable(storageKey, RESOLVED_MARKER) } catch (e2) { warn('pendingCreate removal failed', e2) }
        void e
      }
    },
    storageFailed: () => failed,
  }
}
