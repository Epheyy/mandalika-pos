import type { OutboxItem } from './outbox'
import type { OutboxLoad, OutboxStore } from './outboxStore'
import type { JournalApplyRequest, JournalRow, OutboxJournalPlugin } from './journalPlugin'
import type { KV } from './storage'

/** The only meta key the facade serves (synced-refund memory, plan §2.3). Everything else in
 *  `meta` (e.g. migration state) is the journal's own business. */
export const JOURNAL_KV_KEY = 'mandalika.pos.syncedRefunds'

/** SQLite `PRAGMA synchronous`: 2 = FULL, 3 = EXTRA. Anything lower can lose a commit on power loss. */
const SYNCHRONOUS_FULL = 2

export type JournalUnavailableCode = 'open_failed' | 'quick_check_failed' | 'not_full_sync' | 'row_corrupt'

/** The journal cannot be adopted as the system of record. Typed so boot code can choose between
 *  "keep selling on the old storage" (before takeover) and a hard stop (after). */
export class JournalUnavailableError extends Error {
  constructor(readonly code: JournalUnavailableCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'JournalUnavailableError'
  }
}

interface MirrorRow {
  seq: number
  /** The exact text stored in item_json. Never re-serialized: the server fingerprints number text. */
  json: string
}

// One live store per plugin instance (= per process on device): every Outbox, including a stale
// one from a replaced engine, shares one mirror, so a commit can never be diffed against a
// private, diverged copy of the table.
const adopted = new WeakMap<OutboxJournalPlugin, Promise<JournalOutboxStore>>()

/** OutboxStore over the native SQLite journal. Reads are synchronous from an in-memory mirror
 *  hydrated at adoption; every commit is ONE atomic `apply`, and the mirror is patched only after
 *  that apply resolved (memory is never ahead of disk). */
export class JournalOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, MirrorRow>()
  private readonly meta = new Map<string, string>()
  private tail: Promise<void> = Promise.resolve()
  readonly kv: KV

  private constructor(private readonly plugin: OutboxJournalPlugin) {
    this.kv = this.makeKV()
  }

  /** Adopt the journal: refuses (typed error) unless open() reports quick_check ok and synchronous
   *  FULL, and every row is a well-formed item. Concurrent/repeat calls share one instance; a
   *  refusal is not cached, so a later launch (or retry) can try again. */
  static open(plugin: OutboxJournalPlugin): Promise<JournalOutboxStore> {
    const existing = adopted.get(plugin)
    if (existing) return existing
    const attempt = (async () => {
      const store = new JournalOutboxStore(plugin)
      await store.hydrate()
      return store
    })()
    adopted.set(plugin, attempt)
    attempt.catch(() => {
      if (adopted.get(plugin) === attempt) adopted.delete(plugin)
    })
    return attempt
  }

  private async hydrate(): Promise<void> {
    let info
    try {
      info = await this.plugin.open()
    } catch (cause) {
      throw new JournalUnavailableError('open_failed', 'journal could not be opened', cause)
    }
    if (info.quickCheck !== 'ok') {
      throw new JournalUnavailableError('quick_check_failed', `journal integrity check failed: ${info.quickCheck}`)
    }
    if (!(info.synchronous >= SYNCHRONOUS_FULL)) {
      throw new JournalUnavailableError('not_full_sync', `journal synchronous level ${info.synchronous} is below FULL`)
    }
    const { rows, meta } = await this.plugin.readAll()
    for (const row of rows) {
      this.validateRow(row)
      this.rows.set(row.key, { seq: row.seq, json: row.json })
    }
    for (const [k, v] of Object.entries(meta)) this.meta.set(k, v)
  }

  private validateRow(row: JournalRow): void {
    let item: unknown
    try {
      item = JSON.parse(row.json)
    } catch (cause) {
      throw new JournalUnavailableError('row_corrupt', `journal row ${row.key} is not valid JSON`, cause)
    }
    const o = item as Partial<OutboxItem> | null
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.idempotencyKey !== row.key || o.seq !== row.seq) {
      throw new JournalUnavailableError('row_corrupt', `journal row ${row.key} does not match its item`)
    }
  }

  /** Always `ok`: a journal that does not parse is refused at {@link open}, never silently emptied. */
  load(): OutboxLoad {
    const items = [...this.rows.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((r) => JSON.parse(r.json) as OutboxItem)
    return { kind: 'ok', items }
  }

  commit(prev: readonly OutboxItem[], next: readonly OutboxItem[]): Promise<void> {
    // Diff against the CALLER's prev, not the mirror: an instance that never saw a row cannot
    // delete it, and an item it merely carried along unchanged is never written back over a
    // newer row.
    const prevByKey = new Map(prev.map((i) => [i.idempotencyKey, i]))
    const nextKeys = new Set(next.map((i) => i.idempotencyKey))
    const upserts: JournalRow[] = []
    for (const item of next) {
      const before = prevByKey.get(item.idempotencyKey)
      if (before === item) continue // same reference: Outbox only copies items it changed
      const json = JSON.stringify(item)
      if (before && JSON.stringify(before) === json) continue
      upserts.push({ key: item.idempotencyKey, seq: item.seq, json })
    }
    const deletes = prev.filter((i) => !nextKeys.has(i.idempotencyKey)).map((i) => i.idempotencyKey)
    if (!upserts.length && !deletes.length) return Promise.resolve()
    return this.enqueue({ upserts, deletes }, () => {
      for (const u of upserts) this.rows.set(u.key, { seq: u.seq, json: u.json })
      for (const k of deletes) this.rows.delete(k)
    })
  }

  /** Serialized across every Outbox sharing this store, so applies and their mirror patches
   *  happen in one order. A failed apply leaves the mirror untouched and does not poison the chain. */
  private enqueue(request: JournalApplyRequest, patch: () => void): Promise<void> {
    const result = this.tail.then(async () => {
      await this.plugin.apply(request)
      patch()
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private makeKV(): KV {
    const refuse = (op: string, key: string): never => {
      throw new Error(`journal kv: ${op} of ${key} is not supported (only ${JOURNAL_KV_KEY})`)
    }
    const putMeta = (key: string, value: string): Promise<void> =>
      this.enqueue({ upserts: [], deletes: [], meta: { [key]: value } }, () => { this.meta.set(key, value) })
    return {
      get: (key) => (key === JOURNAL_KV_KEY ? this.meta.get(key) ?? null : null),
      set: (key, value) => {
        if (key !== JOURNAL_KV_KEY) return refuse('set', key)
        // Fire-and-forget like Preferences.set: visible immediately, persisted in the background.
        this.meta.set(key, value)
        putMeta(key, value).catch((err) => console.error('[journal] meta write failed', err))
      },
      remove: (key) => refuse('remove', key),
      setDurable: (key, value) =>
        key === JOURNAL_KV_KEY ? putMeta(key, value) : Promise.reject(new Error(`journal kv: setDurable of ${key} is not supported`)),
      removeDurable: (key) => Promise.reject(new Error(`journal kv: removeDurable of ${key} is not supported`)),
    }
  }
}
