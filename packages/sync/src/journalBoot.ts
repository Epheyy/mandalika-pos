// Boot-time adoption of the SQLite outbox journal (A01b, plan §3). `initJournal()` runs once at app
// start, right after `initSecureKV()`, and decides which store the outbox lives in:
//   - no native plugin            -> the whole-array KV store, silently (web, dev, iOS, old shells);
//   - plugin, first launch        -> copy -> verify -> mark verified -> backup -> seal -> adopt;
//   - plugin, already sealed      -> adopt (a sentinel sits in Preferences, the journal owns the queue).
// Before the seal any problem keeps the old storage (owner Q1: keep selling, warn, report, retry next
// launch). After the seal nothing may ever start from an empty queue: every problem is a boot error.
import { Capacitor } from '@capacitor/core'
import { sha256 } from 'hash-wasm'
import { OUTBOX_CORRUPTION_MARKER_KEY, OUTBOX_KEY, OUTBOX_QUARANTINE_PREFIX, type OutboxItem } from './outbox'
import { JournalOutboxStore, JournalUnavailableError, rowProblem, type JournalUnavailableCode } from './journalOutboxStore'
import { OutboxJournal, type JournalReadAllResult, type JournalRow, type OutboxJournalPlugin } from './journalPlugin'
import { makeSentinel, parseSentinel, SENTINEL_VERSION, type JournalSentinel } from './journalSentinel'
import { SYNCED_REFUNDS_KEY } from './syncedRefunds'
import { RECEIPT_ARCHIVE_KEY } from './receiptArchive'
import { adoptOutboxStore, getKV, type KV } from './storage'

/** Verbatim copy of the pre-migration queue (never deleted by the app; owner Q7). */
export const LEGACY_BACKUP_PREFIX = 'mandalika.outbox.legacy.'
const MIGRATION_KEY = 'migration'
const SOURCE_SHA_KEY = 'source_sha256'
const SOURCE_COUNT_KEY = 'source_count'
const MERGED_SHA_KEY = 'merged_from_sha256'
/** Durable Preferences record (ISO time) written at every seal, so takeover evidence survives a lost
 *  sentinel even when there was no legacy backup (empty queue, the expected fleet case). */
export const TAKEOVER_KEY = 'mandalika.pos.journalTakenOverAt'
const QUARANTINE_META_PREFIX = 'quarantine.'

export const MSG_VERSION_MISMATCH =
  'Antrean tersimpan di journal; versi aplikasi tidak cocok. Pasang versi aplikasi terbaru atau hubungi admin. Jangan lakukan transaksi.'
export const MSG_JOURNAL_LOST =
  'Journal antrean hilang atau tidak lengkap (journal hilang). Jangan lakukan transaksi dan hubungi admin.'
const msgOpenFailed = (detail: string) =>
  `Journal antrean tidak dapat dibuka (${detail}). Jangan lakukan transaksi dan hubungi admin.`
const msgRowCorrupt = (detail: string) =>
  `Ada baris journal antrean yang rusak (${detail}). Jangan lakukan transaksi; hubungi admin atau dukungan untuk perbaikan.`
const msgSealFailed = (detail: string) =>
  `Antrean belum berhasil dipindahkan ke journal (${detail}). Coba lagi; jika masih gagal, hubungi admin.`

/** The queue cannot be started safely: surfaced by `main.tsx` as the retryable boot error. */
export class JournalBootError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'JournalBootError'
  }
}

export type JournalNoticeCode = JournalUnavailableCode | 'malformed_queue' | 'verify_failed' | 'migration_failed'

/** Why the journal was NOT adopted although the plugin exists (owner Q1). The app shows a warning
 *  banner and reports it; the next launch tries again. */
export interface JournalBootNotice {
  code: JournalNoticeCode
  detail: string
}

export type JournalBootResult =
  | { kind: 'kv' }
  | { kind: 'fallback'; code: JournalNoticeCode; detail: string }
  | { kind: 'journal'; store: JournalOutboxStore }

export interface InitJournalDeps {
  /** The Preferences-backed KV. Default {@link getKV}. */
  kv?: KV
  plugin?: OutboxJournalPlugin
  /** Default `Capacitor.isPluginAvailable('OutboxJournal')`. */
  isPluginAvailable?: () => boolean
  now?: () => Date
}

let notice: JournalBootNotice | null = null

/** The Q1 warning from the last `initJournal` (null when the journal is adopted or absent). */
export function getJournalBootNotice(): JournalBootNotice | null {
  return notice
}

/** @internal tests */
export function resetJournalBootForTests(): void {
  notice = null
}

class Fallback extends Error {
  constructor(readonly code: JournalNoticeCode, message: string, readonly cause?: unknown) {
    super(message)
  }
}

type Source =
  | { kind: 'empty'; raw: null }
  | { kind: 'array'; raw: string; items: OutboxItem[] }
  | { kind: 'malformed'; raw: string }
  | { kind: 'sentinel'; raw: string; sentinel: JournalSentinel }
  | { kind: 'other'; raw: string }

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function wellFormed(items: unknown[]): items is OutboxItem[] {
  const keys = new Set<string>()
  const seqs = new Set<number>()
  for (const i of items) {
    const o = i as Partial<OutboxItem> | null
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false
    if (typeof o.idempotencyKey !== 'string' || !o.idempotencyKey) return false
    if (typeof o.seq !== 'number' || !Number.isInteger(o.seq)) return false
    if (keys.has(o.idempotencyKey) || seqs.has(o.seq)) return false
    keys.add(o.idempotencyKey)
    seqs.add(o.seq)
  }
  return true
}

function classify(raw: string | null): Source {
  if (raw === null || raw === '') return { kind: 'empty', raw: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'other', raw }
  }
  if (Array.isArray(parsed)) return wellFormed(parsed) ? { kind: 'array', raw, items: parsed } : { kind: 'malformed', raw }
  const sentinel = parseSentinel(raw)
  return sentinel ? { kind: 'sentinel', raw, sentinel } : { kind: 'other', raw }
}

const bySeq = <T extends { seq: number }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.seq - b.seq)
const digestJson = (jsons: readonly string[]): Promise<string> => sha256(jsons.join('\n'))
const digestItems = (items: readonly OutboxItem[]): Promise<string> => digestJson(bySeq(items).map((i) => JSON.stringify(i)))
const digestRows = (rows: readonly JournalRow[]): Promise<string> => digestJson(bySeq(rows).map((r) => r.json))

export async function initJournal(deps: InitJournalDeps = {}): Promise<JournalBootResult> {
  notice = null
  const kv = deps.kv ?? getKV()
  const available = (deps.isPluginAvailable ?? (() => Capacitor.isPluginAvailable('OutboxJournal')))()
  const src = classify(kv.get(OUTBOX_KEY))

  if (!available) {
    // No native journal in this shell: that is normal (web/dev/iOS/old APK), not a warning. But a queue
    // that already moved into a journal this shell cannot reach must never be shown as empty.
    if (src.kind === 'sentinel') throw new JournalBootError(MSG_VERSION_MISMATCH)
    adoptOutboxStore(null)
    return { kind: 'kv' }
  }

  const plugin = deps.plugin ?? OutboxJournal
  const now = deps.now ?? (() => new Date())
  // Preferences-side proof that this tablet already moved to the journal, readable even when the
  // journal itself will not open: the sentinel, a legacy backup, or a marker an old bundle left.
  const tookOverBefore = src.kind === 'sentinel' || hasTakeoverEvidence(kv)

  let store: JournalOutboxStore
  let disk: JournalReadAllResult
  try {
    store = await JournalOutboxStore.open(plugin, kv)
    disk = await store.readDisk()
  } catch (err) {
    if (tookOverBefore) throw openFailure(err)
    return fallback(err instanceof JournalUnavailableError ? err.code : 'open_failed', err)
  }

  if (src.kind === 'sentinel') {
    resumeSealed(src.sentinel, disk)
  } else if (isTakenOver(disk)) {
    // The journal is the system of record: from here on every failure stops the app, never a fallback.
    try {
      await finishTakeover(store, src, kv, now)
    } catch (err) {
      throw err instanceof JournalBootError ? err : new JournalBootError(msgSealFailed(errMsg(err)), err)
    }
  } else if (tookOverBefore) {
    // Preferences says this tablet moved to the journal but the journal does not say so: never start a
    // fresh copy from Preferences over it.
    throw new JournalBootError(MSG_JOURNAL_LOST)
  } else {
    if (src.kind === 'malformed') return fallback('malformed_queue', new Error('stored queue is not a well-formed item list'))
    try {
      await migrate(store, src, kv, now)
    } catch (err) {
      if (err instanceof JournalBootError) throw err
      if (err instanceof Fallback) return fallback(err.code, err.cause ?? err)
      return fallback('migration_failed', err)
    }
  }
  adoptOutboxStore(store)
  return { kind: 'journal', store }
}

const isTakenOver = (disk: JournalReadAllResult): boolean =>
  disk.meta[MIGRATION_KEY] === 'verified' || disk.meta[MIGRATION_KEY] === 'sealed'

function hasTakeoverEvidence(kv: KV): boolean {
  if (kv.get(TAKEOVER_KEY) !== null) return true
  if (kv.keys?.().some((k) => k.startsWith(LEGACY_BACKUP_PREFIX))) return true
  const marker = kv.get(OUTBOX_CORRUPTION_MARKER_KEY)
  if (!marker) return false
  try {
    const m = JSON.parse(marker) as { quarantineKey?: unknown }
    return typeof m.quarantineKey === 'string' && parseSentinel(kv.get(m.quarantineKey)) !== null
  } catch {
    return false
  }
}

function openFailure(err: unknown): JournalBootError {
  if (err instanceof JournalUnavailableError && err.code === 'row_corrupt') {
    return new JournalBootError(msgRowCorrupt(errMsg(err)), err)
  }
  return new JournalBootError(msgOpenFailed(errMsg(err)), err)
}

function fallback(code: JournalNoticeCode, err: unknown): JournalBootResult {
  const detail = errMsg(err)
  notice = { code, detail }
  adoptOutboxStore(null)
  console.error('[journal] not adopted; keeping the previous queue storage for this launch', code, detail)
  return { kind: 'fallback', code, detail }
}

/** Preferences holds our sentinel: the journal must be the verified copy, or the app stops. */
function resumeSealed(sentinel: JournalSentinel, disk: JournalReadAllResult): void {
  if (sentinel.v !== SENTINEL_VERSION) throw new JournalBootError(MSG_VERSION_MISMATCH)
  if (!isTakenOver(disk)) throw new JournalBootError(MSG_JOURNAL_LOST)
}

// ── migration ───────────────────────────────────────────────────────────────

/** First migration only (journal not yet verified): copy, verify, mark verified, seal. */
async function migrate(
  store: JournalOutboxStore,
  src: Exclude<Source, { kind: 'sentinel' | 'malformed' }>,
  kv: KV,
  now: () => Date,
): Promise<void> {
  const at = now().toISOString()
  const items = src.kind === 'array' ? src.items : []
  if (src.kind === 'other') await quarantineQueue(kv, src.raw, at)
  const sourceSha = await digestItems(items)
  await copyAll(store, items, kv, sourceSha)
  const problem = await verifyCopy(items, await store.readDisk(), kv, sourceSha)
  if (problem) throw new Fallback('verify_failed', `journal copy did not verify: ${problem}`)
  await store.applyBoot({ upserts: [], deletes: [], meta: { [MIGRATION_KEY]: 'verified' } })
  await sealQueue(store, kv, src.raw, at, { count: items.length, sha256: sourceSha })
}

/** The journal was already verified (a crash before the seal, a lost row, or an older OTA bundle that
 *  wrote Preferences afterwards). Preferences can only ADD to the journal, never replace it: keys the
 *  journal lacks are appended, journal rows win, nothing is deleted; then seal. Unreadable values are
 *  kept raw (quarantine + backup). */
async function finishTakeover(
  store: JournalOutboxStore,
  src: Exclude<Source, { kind: 'sentinel' }>,
  kv: KV,
  now: () => Date,
): Promise<void> {
  const at = now().toISOString()
  const items = src.kind === 'array' ? src.items : []
  if (src.kind === 'other' || src.kind === 'malformed') await quarantineQueue(kv, src.raw, at)
  const disk = await store.readDisk()
  const seal = await mergeLateWrites(store, items, disk, kv, await digestItems(items))
  await sealQueue(store, kv, src.raw, at, seal)
}

async function copyAll(store: JournalOutboxStore, items: readonly OutboxItem[], kv: KV, sourceSha: string): Promise<void> {
  const meta: Record<string, string> = {
    [MIGRATION_KEY]: 'copied',
    [SOURCE_SHA_KEY]: sourceSha,
    [SOURCE_COUNT_KEY]: String(items.length),
  }
  const refunds = kv.get(SYNCED_REFUNDS_KEY)
  if (refunds !== null) meta[SYNCED_REFUNDS_KEY] = refunds
  const archive = kv.get(RECEIPT_ARCHIVE_KEY)
  if (archive !== null) meta[RECEIPT_ARCHIVE_KEY] = archive
  const upserts = items.map((i) => ({ key: i.idempotencyKey, seq: i.seq, json: JSON.stringify(i) }))
  await store.applyBoot({ upserts, deletes: [], meta, replaceAll: true })
}

/** Null when the journal holds exactly the source; else why not. Every comparison is on the exact
 *  JSON text the server will later fingerprint. */
async function verifyCopy(
  items: readonly OutboxItem[],
  disk: JournalReadAllResult,
  kv: KV,
  sourceSha: string,
): Promise<string | null> {
  if (disk.rows.length !== items.length) return `count ${disk.rows.length} != ${items.length}`
  const byKey = new Map(disk.rows.map((r) => [r.key, r]))
  for (const item of items) {
    const row = byKey.get(item.idempotencyKey)
    if (!row) return `missing ${item.idempotencyKey}`
    const json = JSON.stringify(item)
    if (row.json !== json) return `json differs for ${item.idempotencyKey}`
    if (row.seq !== item.seq) return `seq differs for ${item.idempotencyKey}`
    let parsed: { payload?: unknown }
    try {
      parsed = JSON.parse(row.json)
    } catch {
      return `unparseable ${item.idempotencyKey}`
    }
    if (JSON.stringify(parsed) !== row.json) return `round trip differs for ${item.idempotencyKey}`
    if (JSON.stringify(parsed.payload) !== JSON.stringify(item.payload)) return `payload differs for ${item.idempotencyKey}`
  }
  if ((await digestRows(disk.rows)) !== sourceSha) return 'sha256 differs'
  if ((disk.meta[SYNCED_REFUNDS_KEY] ?? null) !== kv.get(SYNCED_REFUNDS_KEY)) return 'synced refunds differ'
  if ((disk.meta[RECEIPT_ARCHIVE_KEY] ?? null) !== kv.get(RECEIPT_ARCHIVE_KEY)) return 'receipt archive differs'
  return null
}

/** Old-bundle writes after the seal: keys the journal lacks are appended after its max seq (original
 *  order kept); keys it already has keep the JOURNAL row. Synced refunds are unioned. Idempotent. */
async function mergeLateWrites(
  store: JournalOutboxStore,
  items: readonly OutboxItem[],
  disk: JournalReadAllResult,
  kv: KV,
  sourceSha: string,
): Promise<{ count: number; sha256: string }> {
  const have = new Set(disk.rows.map((r) => r.key))
  let next = Math.max(store.maxSeq(), ...disk.rows.map((r) => r.seq), 0)
  const upserts: JournalRow[] = bySeq(items)
    .filter((i) => !have.has(i.idempotencyKey))
    .map((i) => {
      next += 1
      const renumbered: OutboxItem = { ...i, seq: next }
      return { key: renumbered.idempotencyKey, seq: next, json: JSON.stringify(renumbered) }
    })
  const meta: Record<string, string> = { [MERGED_SHA_KEY]: sourceSha }
  const refunds = unionRefunds(disk.meta[SYNCED_REFUNDS_KEY], kv.get(SYNCED_REFUNDS_KEY))
  if (refunds !== null) meta[SYNCED_REFUNDS_KEY] = refunds
  const archive = unionArchive(disk.meta[RECEIPT_ARCHIVE_KEY], kv.get(RECEIPT_ARCHIVE_KEY))
  if (archive !== null) meta[RECEIPT_ARCHIVE_KEY] = archive
  await store.applyBoot({ upserts, deletes: [], meta })
  const after = await store.readDisk()
  return { count: after.rows.length, sha256: await digestRows(after.rows) }
}

/** Receipt archive entries by orderUuid; the journal's entry wins (it is the newer copy). Null when
 *  neither side has one. An unparseable side contributes nothing and is never overwritten silently:
 *  the other side is kept, and with no other side the raw text stays. */
function unionArchive(a: string | undefined, b: string | null): string | null {
  const parse = (raw: string | null | undefined): { orderUuid: string }[] | null => {
    if (!raw) return null
    try {
      const list: unknown = JSON.parse(raw)
      return Array.isArray(list) ? (list as { orderUuid: string }[]).filter((e) => e && typeof e.orderUuid === 'string') : null
    } catch {
      return null
    }
  }
  const disk = parse(a)
  const kvList = parse(b)
  if (!disk && !kvList) return a ?? b
  const merged = new Map<string, { orderUuid: string }>()
  for (const e of kvList ?? []) merged.set(e.orderUuid, e)
  for (const e of disk ?? []) merged.set(e.orderUuid, e)
  return JSON.stringify([...merged.values()])
}

function unionRefunds(a: string | undefined, b: string | null): string | null {
  const merged = new Map<string, { orderId: string; at: number }>()
  for (const raw of [a, b]) {
    if (!raw) continue
    let list: unknown
    try {
      list = JSON.parse(raw)
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue
    for (const e of list as { orderId?: unknown; at?: unknown }[]) {
      if (!e || typeof e.orderId !== 'string' || typeof e.at !== 'number') continue
      const prev = merged.get(e.orderId)
      if (!prev || prev.at < e.at) merged.set(e.orderId, { orderId: e.orderId, at: e.at })
    }
  }
  if (!merged.size && a === undefined && b === null) return null
  return JSON.stringify([...merged.values()].sort((x, y) => x.at - y.at))
}

/** A non-array queue value is kept (never deleted) under the same quarantine key the Outbox would use. */
async function quarantineQueue(kv: KV, raw: string, at: string): Promise<void> {
  const quarantineKey = OUTBOX_QUARANTINE_PREFIX + at
  await kv.setDurable(quarantineKey, raw)
  await kv.setDurable(OUTBOX_CORRUPTION_MARKER_KEY, JSON.stringify({ quarantineKey, detectedAt: at }))
}

/** Verbatim backup, then the sentinel, then `migration='sealed'` in the journal (durable, FULL) so the
 *  takeover is recorded where Preferences cannot undo it. Each step failing is a (retryable) boot error:
 *  the next launch finds the verified journal and only merges/seals again. */
async function sealQueue(
  store: JournalOutboxStore,
  kv: KV,
  raw: string | null,
  at: string,
  s: { count: number; sha256: string },
): Promise<void> {
  try {
    if (raw !== null) {
      let key = LEGACY_BACKUP_PREFIX + at
      for (let n = 2; kv.get(key) !== null && kv.get(key) !== raw; n++) key = `${LEGACY_BACKUP_PREFIX}${at}.${n}`
      await kv.setDurable(key, raw)
    }
    await kv.setDurable(TAKEOVER_KEY, at)
    await kv.setDurable(OUTBOX_KEY, makeSentinel(at, s.count, s.sha256))
    await store.applyBoot({ upserts: [], deletes: [], meta: { [MIGRATION_KEY]: 'sealed' } })
  } catch (err) {
    throw new JournalBootError(msgSealFailed(errMsg(err)), err)
  }
}

// ── explicit repair (M4) ────────────────────────────────────────────────────

export interface QuarantineDeps {
  kv?: KV
  plugin?: OutboxJournalPlugin
  now?: () => Date
}

/** SUPPORT ACTION, never run automatically. After takeover a journal row that does not parse makes
 *  the whole journal refuse to open (boot error). This moves each bad row raw into meta
 *  `quarantine.<key>` and deletes it, in ONE transaction, after leaving a durable corruption marker
 *  in Preferences so the lasting banner and error report fire on the next launch. Nothing is lost:
 *  the raw rows stay in `meta`. Returns the quarantined keys (empty = nothing was wrong). */
export async function quarantineCorruptRows(deps: QuarantineDeps = {}): Promise<{ quarantined: string[] }> {
  const kv = deps.kv ?? getKV()
  const plugin = deps.plugin ?? OutboxJournal
  const at = (deps.now ?? (() => new Date()))().toISOString()
  const info = await plugin.open()
  if (info.quickCheck !== 'ok') throw new Error(`journal integrity check failed: ${info.quickCheck}`)
  const { rows } = await plugin.readAll()
  const bad = rows.filter((r) => rowProblem(r) !== null)
  if (!bad.length) return { quarantined: [] }
  const meta: Record<string, string> = {}
  for (const r of bad) meta[QUARANTINE_META_PREFIX + r.key] = JSON.stringify({ key: r.key, seq: r.seq, json: r.json, at })
  const quarantineKey = `journal:${Object.keys(meta).join(',')}`
  await kv.setDurable(OUTBOX_CORRUPTION_MARKER_KEY, JSON.stringify({ quarantineKey, detectedAt: at }))
  await plugin.apply({ upserts: [], deletes: bad.map((r) => r.key), meta })
  return { quarantined: bad.map((r) => r.key) }
}
