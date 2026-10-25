import type { KV } from '@mandalika/sync'

// Idempotency keys for the PB writes. One key per (operation, PB id or "new", content signature),
// the backoffice rule: a retry after a lost response replays the same write; only an edit mints a new key.
//
// Create is the only write whose lost key would duplicate a document (a fresh key = a second
// draft PB), so the pending create {sig, key, form} is persisted in the app KV, scoped by user and
// outlet, and cleared on success. Update/submit/cancel keys stay in memory: after a restart they get
// a fresh key, which is harmless (an extra "updated" history row, or a 409 that means "refetch").

export interface KeyScope { userId: string; outletId: string }
export type KeyedOp = 'update' | 'submit' | 'cancel'

export interface PendingCreate<F = unknown> { sig: string; key: string; form: F }

export interface RequisitionKeys {
  /** Key for update / submit / cancel of an existing PB, stable for the same content signature. */
  keyFor(op: KeyedOp, docId: string, sig: string): string
  /** Drop the key (a 409 key-conflict or a success) so the next attempt mints a new one. */
  forget(op: KeyedOp, docId: string): void
  /** The persisted create key for this signature (minted + persisted on first use). */
  createKey<F>(sig: string, form: F): Promise<string>
  /** The half-typed create that survived an app restart, if any. */
  loadPendingCreate<F = unknown>(): PendingCreate<F> | null
  /** After a successful create, or when the cashier discards the form. */
  clearPendingCreate(): Promise<void>
  /** Mint a new create key for the same signature (after a 409 key-conflict). */
  renewCreateKey<F>(sig: string, form: F): Promise<string>
}

export function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export const pendingCreateStorageKey = (s: KeyScope): string => `pos.requisition.pendingCreate.${s.userId}.${s.outletId}`

export function createRequisitionKeys(kv: KV, scope: KeyScope): RequisitionKeys {
  const mem = new Map<string, { sig: string; key: string }>()
  const storageKey = pendingCreateStorageKey(scope)

  const read = (): PendingCreate | null => {
    const raw = kv.get(storageKey)
    if (!raw) return null
    try {
      const v = JSON.parse(raw) as Partial<PendingCreate>
      return typeof v.sig === 'string' && typeof v.key === 'string' ? { sig: v.sig, key: v.key, form: v.form } : null
    } catch {
      return null
    }
  }
  const persist = async (p: PendingCreate): Promise<void> => {
    // Best effort: a failed write must not block the request; the in-flight key is still reused in memory.
    try { await kv.setDurable(storageKey, JSON.stringify(p)) } catch { /* ignore */ }
  }
  let lastCreate: { sig: string; key: string } | null = null

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
    async createKey(sig, form) {
      if (lastCreate?.sig === sig) return lastCreate.key
      const saved = read()
      if (saved && saved.sig === sig) {
        lastCreate = { sig, key: saved.key }
        return saved.key
      }
      const key = newKey()
      lastCreate = { sig, key }
      await persist({ sig, key, form })
      return key
    },
    loadPendingCreate<F>() { return read() as PendingCreate<F> | null },
    async clearPendingCreate() {
      lastCreate = null
      try { await kv.removeDurable(storageKey) } catch { /* ignore */ }
    },
    async renewCreateKey(sig, form) {
      const key = newKey()
      lastCreate = { sig, key }
      await persist({ sig, key, form })
      return key
    },
  }
}
