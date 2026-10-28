import type { OutboxItem } from './outbox'
import type { OutboxLoad, OutboxStore } from './outboxStore'
import type { JournalApplyRequest, JournalReadAllResult, JournalRow, OutboxJournalPlugin } from './journalPlugin'
import type { KV } from './storage'
import { RECEIPT_ARCHIVE_KEY } from './receiptArchive'
import { PARTIAL_REFUNDS_KEY } from './partialRefunds'

/** The meta key of the synced-refund memory (plan §2.3). */
export const JOURNAL_KV_KEY = 'mandalika.pos.syncedRefunds'
/** The only meta keys the facade serves: synced-refund memory, the local receipt archive (A41) and the
 *  per-line refund memory (C4b; 2.4.0 shipped without it, so every write of it was refused and the acked
 *  rows were never pruned). Everything else in `meta` (e.g. migration state) is the journal's own business. */
const FACADE_KEYS: ReadonlySet<string> = new Set([JOURNAL_KV_KEY, RECEIPT_ARCHIVE_KEY, PARTIAL_REFUNDS_KEY])

/** SQLite `PRAGMA synchronous`: 2 = FULL, 3 = EXTRA. Anything lower can lose a commit on power loss. */
const SYNCHRONOUS_FULL = 2

/** Rollback-journal modes that stay durable with synchronous=FULL. WAL is out (compat WAL drops to
 *  NORMAL), and so is DELETE on old SQLite builds (power-loss window). */
const SAFE_JOURNAL_MODES = new Set(['truncate', 'persist'])

export type JournalUnavailableCode = 'open_failed' | 'quick_check_failed' | 'not_full_sync' | 'journal_mode' | 'row_corrupt'

/** The journal cannot be adopted as the system of record. Typed so boot code can choose between
 *  "keep selling on the old storage" (before takeover) and a hard stop (after). */
export class JournalUnavailableError extends Error {
  constructor(readonly code: JournalUnavailableCode, message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'JournalUnavailableError'
  }
}

/** A commit was built from a view of a row that is no longer what the journal holds. */
export class JournalConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalConflictError'
  }
}

/** Why a stored row is not a well-formed outbox item, or null when it is. */
export function rowProblem(row: JournalRow): string | null {
  let item: unknown
  try {
    item = JSON.parse(row.json)
  } catch {
    return 'is not valid JSON'
  }
  const o = item as Partial<OutboxItem> | null
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.idempotencyKey !== row.key || o.seq !== row.seq) {
    return 'does not match its item'
  }
  return null
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
  /** Visible meta values (may briefly lead the disk for fire-and-forget `set`). */
  private readonly meta = new Map<string, string>()
  /** Meta values known to be on disk. */
  private readonly metaDisk = new Map<string, string>()
  private readonly metaGen = new Map<string, number>()
  /** seq -> number of applies in flight that will insert it. */
  private readonly inflight = new Map<number, number>()
  /** Highest seq whose outcome could not be confirmed (apply rejected AND readAll failed). */
  private seqFloor = 0
  private tail: Promise<void> = Promise.resolve()
  readonly kv: KV

  private constructor(
    private readonly plugin: OutboxJournalPlugin,
    /** Where the corruption marker/quarantine live (Preferences), never the journal meta. */
    readonly noticeKV?: KV,
  ) {
    this.kv = this.makeKV()
  }

  /** Adopt the journal: refuses (typed error) unless open() reports quick_check ok and synchronous
   *  FULL, and every row is a well-formed item. Concurrent/repeat calls share one instance; a
   *  refusal is not cached, so a later launch (or retry) can try again. */
  static open(plugin: OutboxJournalPlugin, noticeKV?: KV): Promise<JournalOutboxStore> {
    const existing = adopted.get(plugin)
    if (existing) return existing
    const attempt = (async () => {
      const store = new JournalOutboxStore(plugin, noticeKV)
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
    if (!SAFE_JOURNAL_MODES.has(String(info.journalMode).toLowerCase())) {
      throw new JournalUnavailableError('journal_mode', `journal mode ${info.journalMode} is not truncate or persist`)
    }
    const { rows, meta } = await this.plugin.readAll()
    for (const row of rows) {
      this.validateRow(row)
      this.rows.set(row.key, { seq: row.seq, json: row.json })
    }
    for (const [k, v] of Object.entries(meta)) {
      this.meta.set(k, v)
      this.metaDisk.set(k, v)
    }
  }

  private validateRow(row: JournalRow): void {
    const problem = rowProblem(row)
    if (problem) throw new JournalUnavailableError('row_corrupt', `journal row ${row.key} ${problem}`)
  }

  /** The journal as it is on disk right now (waits for queued applies). Boot/migration only. */
  async readDisk(): Promise<JournalReadAllResult> {
    await this.tail
    return this.plugin.readAll()
  }

  /** One boot/migration transaction through the same serialized chain as every other write, so the
   *  mirror follows it (replaceAll, deletes, upserts, meta). Rejects if the change is not on disk. */
  applyBoot(request: JournalApplyRequest): Promise<void> {
    return this.enqueue({
      request,
      patch: () => {
        if (request.replaceAll) this.rows.clear()
        for (const k of request.deletes) this.rows.delete(k)
        for (const u of request.upserts) this.rows.set(u.key, { seq: u.seq, json: u.json })
        for (const [k, v] of Object.entries(request.meta ?? {})) {
          this.meta.set(k, v)
          this.metaDisk.set(k, v)
        }
      },
    })
  }

  /** Always `ok`: a journal that does not parse is refused at {@link open}, never silently emptied. */
  load(): OutboxLoad {
    const items = [...this.rows.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((r) => JSON.parse(r.json) as OutboxItem)
    return { kind: 'ok', items }
  }

  /** Highest seq the journal holds or is about to hold (mirror plus applies still in flight), so a
   *  new Outbox instance never hands out a seq another instance owns. */
  maxSeq(): number {
    let max = this.seqFloor
    for (const r of this.rows.values()) if (r.seq > max) max = r.seq
    for (const s of this.inflight.keys()) if (s > max) max = s
    return max
  }

  reload(): OutboxItem[] {
    return (this.load() as { items: OutboxItem[] }).items
  }

  idle(): Promise<void> {
    return this.tail
  }

  /** Deletes are not compare-and-swap checked: removing an already-absent row is idempotent and a
   *  stale instance can only delete keys it saw in its own prev. */
  commit(prev: readonly OutboxItem[], next: readonly OutboxItem[]): Promise<void> {
    // Diff against the CALLER's prev, not the mirror: an instance that never saw a row cannot
    // delete it, and an item it merely carried along unchanged is never written back over a
    // newer row. Each upsert also remembers what it expects to find on disk (compare-and-swap).
    const prevByKey = new Map(prev.map((i) => [i.idempotencyKey, i]))
    const nextKeys = new Set(next.map((i) => i.idempotencyKey))
    const upserts: JournalRow[] = []
    const expected: [string, string | undefined][] = []
    for (const item of next) {
      const before = prevByKey.get(item.idempotencyKey)
      if (before === item) continue // same reference: Outbox only copies items it changed
      const json = JSON.stringify(item)
      const beforeJson = before ? JSON.stringify(before) : undefined
      if (beforeJson === json) continue
      upserts.push({ key: item.idempotencyKey, seq: item.seq, json })
      expected.push([item.idempotencyKey, beforeJson])
    }
    const deletes = prev.filter((i) => !nextKeys.has(i.idempotencyKey)).map((i) => i.idempotencyKey)
    if (!upserts.length && !deletes.length) return Promise.resolve()
    for (const u of upserts) this.inflight.set(u.seq, (this.inflight.get(u.seq) ?? 0) + 1)
    const release = () => {
      for (const u of upserts) {
        const n = (this.inflight.get(u.seq) ?? 1) - 1
        if (n <= 0) this.inflight.delete(u.seq)
        else this.inflight.set(u.seq, n)
      }
    }
    return this.enqueue({
      request: { upserts, deletes },
      check: () => {
        for (const [key, beforeJson] of expected) {
          if (this.rows.get(key)?.json !== beforeJson) {
            throw new JournalConflictError(`journal conflict on ${key}: the row changed since this instance last saw it`)
          }
        }
      },
      patch: () => {
        for (const u of upserts) this.rows.set(u.key, { seq: u.seq, json: u.json })
        for (const k of deletes) this.rows.delete(k)
      },
    }).finally(release)
  }

  /** Serialized across every Outbox sharing this store, so applies and their mirror patches
   *  happen in one order; a failed apply does not poison the chain.
   *  A rejected apply is NOT assumed to have rolled back (the commit may have landed before the
   *  failure surfaced): the file is re-read, and if it already holds exactly what was asked the
   *  change counts as committed. Otherwise the mirror is resynced from disk and the error stands. */
  private enqueue(op: {
    request: JournalApplyRequest
    check?: () => void
    patch: () => void
    onFail?: () => void
  }): Promise<void> {
    const result = this.tail.then(async () => {
      op.check?.()
      try {
        await this.plugin.apply(op.request)
      } catch (err) {
        const disk = await this.plugin.readAll().catch(() => null)
        if (disk && this.matches(op.request, disk)) {
          this.rebuildRows(disk) // trust the file just read, then apply the (idempotent) patch
          op.patch()
          return
        }
        if (disk) this.resync(disk)
        else for (const u of op.request.upserts) this.seqFloor = Math.max(this.seqFloor, u.seq)
        op.onFail?.()
        throw err
      }
      op.patch()
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private matches(req: JournalApplyRequest, disk: JournalReadAllResult): boolean {
    const byKey = new Map(disk.rows.map((r) => [r.key, r]))
    if (req.replaceAll && byKey.size !== req.upserts.length) return false
    for (const u of req.upserts) {
      const r = byKey.get(u.key)
      if (!r || r.json !== u.json || r.seq !== u.seq) return false
    }
    for (const k of req.deletes) if (byKey.has(k)) return false
    for (const [k, v] of Object.entries(req.meta ?? {})) if (disk.meta[k] !== v) return false
    return true
  }

  private rebuildRows(disk: JournalReadAllResult): void {
    this.rows.clear()
    for (const r of disk.rows) this.rows.set(r.key, { seq: r.seq, json: r.json })
  }

  /** Rows and the on-disk meta view only. VISIBLE meta is owned by the generation-guarded
   *  patch/onFail of the writes in flight; touching it here would drop newer synced-refund entries. */
  private resync(disk: JournalReadAllResult): void {
    this.rebuildRows(disk)
    this.metaDisk.clear()
    for (const [k, v] of Object.entries(disk.meta)) this.metaDisk.set(k, v)
  }

  private makeKV(): KV {
    const refuse = (op: string, key: string): never => {
      throw new Error(`journal kv: ${op} of ${key} is not supported (only ${[...FACADE_KEYS].join(', ')})`)
    }
    const nextGen = (key: string): number => {
      const gen = (this.metaGen.get(key) ?? 0) + 1
      this.metaGen.set(key, gen)
      return gen
    }
    // A write patches the visible value only while it is still the newest write for its key, so a
    // slow older apply can never put an older value back over a newer one.
    const write = (key: string, value: string, gen: number, failure: () => void): Promise<void> =>
      this.enqueue({
        request: { upserts: [], deletes: [], meta: { [key]: value } },
        patch: () => {
          this.metaDisk.set(key, value)
          if (this.metaGen.get(key) === gen) this.meta.set(key, value)
        },
        onFail: failure,
      })
    return {
      get: (key) => (FACADE_KEYS.has(key) ? this.meta.get(key) ?? null : null),
      set: (key, value) => {
        if (!FACADE_KEYS.has(key)) return refuse('set', key)
        // Fire-and-forget like Preferences.set: visible immediately, persisted in the background.
        // If the write fails it is logged and the value falls back to what is on disk.
        const gen = nextGen(key)
        this.meta.set(key, value)
        write(key, value, gen, () => {
          if (this.metaGen.get(key) !== gen) return
          const onDisk = this.metaDisk.get(key)
          if (onDisk === undefined) this.meta.delete(key)
          else this.meta.set(key, onDisk)
        }).catch((err) => console.error('[journal] meta write failed; reverted to the stored value', err))
      },
      remove: (key) => refuse('remove', key),
      setDurable: (key, value) =>
        FACADE_KEYS.has(key)
          ? write(key, value, nextGen(key), () => {})
          : Promise.reject(new Error(`journal kv: setDurable of ${key} is not supported`)),
      removeDurable: (key) => Promise.reject(new Error(`journal kv: removeDurable of ${key} is not supported`)),
    }
  }
}
