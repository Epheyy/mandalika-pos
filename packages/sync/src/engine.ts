import type { components } from '@mandalika/api'
import { Outbox, MAX_ATTEMPTS, summarizeQueue, type QueueSummary, type OutboxEnvelope, type OutboxCorruption, type OutboxSettle, type OutboxItem, type OutboxType, type ReviewItem } from './outbox'
import { Snapshot } from './snapshot'
import { getDeviceId, uuid } from './device'
import { defaultKV, type KV, readJSON, writeJSON } from './storage'
import { KVOutboxStore, type OutboxStore } from './outboxStore'
import { SyncedRefunds } from './syncedRefunds'
import { ReceiptArchive, receiptEntryFromItem, type ReceiptContext, type ReceiptEntry } from './receiptArchive'
import { PendingCredits, applyCredits, type CreditLine } from './pendingCredits'
import { SettlingDebits, type DebitLine } from './settlingDebits'
import { redactForLogs, redactSecrets, redactString } from './redact'
import { OfflineContact, type OfflineCapState } from './offlineContact'

const SYNC_LOG_KEY = 'mandalika.pos.synclog'
const INBOUND_KEY = 'mandalika.pos.inboundTransfers'

type Payload = Record<string, unknown>
/** Log/diagnostic tier: secrets + PII removed, size-capped (A37). Never mutates the outbox item. */
const forLogs = (p: Payload): Payload => redactForLogs(p) as Payload
const forLogsText = (t: string | undefined): string | undefined => (t === undefined ? t : redactString(t, 'logs'))

type Bundle = components['schemas']['SyncPullBundle']
type BatchResult = components['schemas']['SyncBatchResult']
type VersionInfo = components['schemas']['SyncVersion']
type Transfer = components['schemas']['Transfer']
type ReviewReport = components['schemas']['SyncReviewReport']
type ReviewReportRequest = components['schemas']['SyncReviewReportRequest']
type ReviewReportResult = components['schemas']['SyncReviewReportResult']

// Minimal seam onto the generated API client (packages/api `request`).
export interface ApiLike {
  request<T>(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<T>
}

export interface WallState {
  /** true = Backoffice changed reference data; a new sale is blocked. */
  raised: boolean
  localVersion: number
  serverVersion: number
}

export interface SyncEvents {
  onWall?: (w: WallState) => void
  onReconcile?: (r: BatchResult) => void
  onOutboxChange?: (pending: number) => void
  /** Real server reachability (a GET to the server actually succeeded/failed),
   *  not navigator.onLine — which lies on some Android WebViews. */
  onReachable?: (online: boolean) => void
  /** Dev-only: emit `[sync]` console diagnostics for rejected items and batch
   *  failures. Defaults off so release builds stay silent on devices; the app
   *  wires this to `import.meta.env.DEV`. */
  debug?: boolean
  /** Fired once per item when it enters the needs-review state (the server refused
   *  it for good, or kept refusing past the retry cap) so the app can ship it to the
   *  server error log. `reviewCode` is unset for items parked by attempt counting. */
  onDeadLetter?: (
    items: {
      type: OutboxType
      idempotencyKey: string
      payload: Record<string, unknown>
      lastError?: string
      reviewCode?: string
    }[],
  ) => void
  /** Fired when a transfer_receive lost to another receipt (or the transfer is gone):
   *  the optimistic stock credit was removed and the receipt, with its counts, is
   *  kept for review. First valid receipt wins. */
  onReceiveRejected?: (msg: string) => void
  /** Fired once per item when it has failed retryably many times in a row (it
   *  keeps retrying, but a persistent server problem needs a human). */
  onStuckRetrying?: (
    items: { type: OutboxType; idempotencyKey: string; payload: Record<string, unknown>; lastError?: string }[],
  ) => void
  /** Fired when a transfer_receive is accepted by the server. Carries the full
   *  completed Transfer snapshot (with the freshly-assigned tandaTerimaNo and
   *  resolved receiver letterhead) so the UI can render the post-receive slip
   *  without a second roundtrip. */
  onReceiveAccepted?: (transfer: Transfer) => void
  /** Head office resolved review items and they were removed from the queue (toast). */
  onReviewResolved?: (items: ReviewResolvedNotice[]) => void
}

/** A transfer_receive result goes to REVIEW (credit removed, payload kept) for these
 *  codes. With no code (older server) the old behaviour stays: discard + roll back.
 *  busy / internal / forbidden (e.g. wrong PIN) / rejected / key_conflict take the
 *  normal item-failure path. */
export const RECEIVE_CONFLICT_CODES: readonly string[] = ['competing_receipt', 'conflict', 'not_found']
function isReceiveConflict(code: string | undefined): boolean {
  return code !== undefined && RECEIVE_CONFLICT_CODES.includes(code)
}

/** Codes the server is known to send. A non-retryable result carrying one of these
 *  goes straight to review; anything else keeps the attempt counting. */
const KNOWN_ERROR_CODES = new Set([
  'rejected', 'forbidden', 'not_found', 'conflict', 'competing_receipt',
  'key_conflict', 'busy', 'internal', 'actor_mismatch', 'offline_expired',
])

/** The whole /sync/batch request is aborted after this long so a hung connection
 *  cannot leave `flushing` stuck. */
export const BATCH_TIMEOUT_MS = 30_000

/** A flush posts the outbox in slices of this size, so one request always fits well inside
 *  BATCH_TIMEOUT_MS and the server's batch caps (A29). */
export const BATCH_MAX_ITEMS = 25

/** Fold a chunk's answer into the flush result: concatenated results, last version, summed processed. */
function mergeBatch(a: BatchResult | null, b: BatchResult | null): BatchResult | null {
  if (!a || !b) return a ?? b
  return { ...b, processed: a.processed + b.processed, results: [...a.results, ...b.results] }
}

/** Review check-in: re-report everything at most this often... */
export const REVIEW_CHECKIN_MS = 5 * 60_000
/** ...but report a not-yet-reported review item within this. */
export const REVIEW_CHECKIN_NEW_MS = 30_000
/** Items per check-in; the rest follow in later rounds (least recently sent first). */
export const REVIEW_CHECKIN_MAX_ITEMS = 50
const REVIEW_CHECKIN_TIMEOUT_MS = 20_000

/** Head office resolved a review item and the tablet removed it. */
export interface ReviewResolvedNotice {
  idempotencyKey: string
  type: OutboxType
  note: string
  resolvedByName: string
}

function toReviewReport(i: ReviewItem): ReviewReport {
  return {
    idempotencyKey: i.idempotencyKey,
    type: i.type,
    clientCreatedAt: i.clientCreatedAt,
    payload: redactSecrets(i.payload) as Payload, // secrets only: head office needs the customer to resolve the item
    ...(i.reviewCode ? { reviewCode: i.reviewCode } : {}),
    ...(i.reviewReason ? { reviewReason: i.reviewReason } : {}),
    ...(i.lastError ? { lastError: i.lastError } : {}),
    ...(i.ownerUserId ? { ownerUserId: i.ownerUserId } : {}),
    ...(i.capturedOutletId ? { capturedOutletId: i.capturedOutletId } : {}),
  }
}
/** The stock lines of an order item (reward lines included: they decrement stock server-side too). */
function orderDebitLines(item: { payload: Record<string, unknown> }): DebitLine[] {
  const payload = item.payload as { items?: Array<{ productId?: string; variantSize?: string; quantity?: number }> }
  const lines: DebitLine[] = []
  for (const l of payload.items ?? []) {
    if (l.productId) lines.push({ productId: l.productId, variantSize: l.variantSize ?? '', qty: l.quantity ?? 0 })
  }
  return lines
}

/** An acked order is kept queued at most this many times when its settling-debit write fails. */
const SETTLING_HOLD_MAX = 3

/** Backoff after a transient whole-batch failure: base * 2^n, capped, with jitter. */
export const BACKOFF_BASE_MS = 20_000
export const BACKOFF_CAP_MS = 5 * 60_000

type FailureKind = 'offline' | 'unauthorized' | 'transient' | 'rejected' | 'account'

/** Only these statuses say "this request body is bad", so only they justify isolating
 *  items one by one. Every other 4xx on /sync/batch (403 outlet not permitted / no active
 *  outlet, 404/405 wrong base URL, 407 or a captive portal) is an account/session/transport
 *  problem that says nothing about any item. */
const BODY_REJECT_STATUSES = new Set([400, 413, 422])

export const ACCOUNT_PROBLEM_MESSAGE =
  'Masalah akun/outlet — hubungi admin. Transaksi tetap tersimpan di perangkat.'
interface Failure {
  kind: FailureKind
  message: string
}

/** Decide what a thrown request error means for the queue. Only a deterministic 4xx
 *  ('rejected') may ever be held against an item. */
function classifyFailure(err: unknown, online: boolean): Failure {
  const message = err instanceof Error ? err.message : 'sync failed'
  if (!online) return { kind: 'offline', message }
  const e = (err ?? {}) as { kind?: unknown; status?: unknown }
  const status = typeof e.status === 'number' ? e.status : 0
  if (status === 401) return { kind: 'unauthorized', message }
  if (e.kind === 'network') return { kind: 'offline', message }
  if (e.kind === 'timeout' || e.kind === 'invalid_response') return { kind: 'transient', message }
  if (status >= 500 || status === 429 || status === 408) return { kind: 'transient', message }
  if (BODY_REJECT_STATUSES.has(status)) return { kind: 'rejected', message }
  if (status >= 400) return { kind: 'account', message }
  if (err instanceof TypeError) return { kind: 'offline', message }
  return { kind: 'transient', message } // unknown: never blame the item
}

/** Who is operating the terminal right now, as known to the app at capture time. The
 *  engine adds deviceId/capturedAt/v. Returning null means "no verified identity":
 *  the mutation is refused and nothing is stored (A04). */
export interface ActorContext {
  outletId: string
  userId: string
  /** The shift the cashier is in, when its server id is known (offline-opened shifts have none yet). */
  shiftId?: string | null
  appVersion?: string
}
export type ActorProvider = () => ActorContext | null

export interface SyncEngineOptions {
  /** Stamps every new outbox item with its capture-time envelope. REQUIRED so a new call
   *  site cannot forget it: `null` (tests only) sends items without one (server: legacy path). */
  actor: ActorProvider | null
  /** Where the outbox persists (the SQLite journal once adopted). Default: the whole-array KV store
   *  over the engine's `kv`. Synced-refund memory follows the store (`store.kv`). */
  outboxStore?: OutboxStore
}

/** A refund not yet acknowledged by the server, as the POS gate and shift recap see it. */
export interface QueuedRefund {
  idempotencyKey: string
  /** '' when a legacy item carries no usable orderId. */
  orderId: string
  /** Shift stamped on the item at capture (envelope); null when unknown (offline-opened shift, legacy). */
  shiftId: string | null
  /** Parked for review: it will NOT be sent until a person retries it. */
  parked: boolean
  readonly payload: Readonly<Record<string, unknown>>
}

/** A sale made on this tablet, as the local receipt book shows it (A41). Receipt facts only: no customer,
 *  notes or salesman data. */
export interface LocalReceipt {
  orderUuid: string
  idempotencyKey: string
  /** Known once the server acknowledged the sale and returned its id. */
  serverOrderId?: string
  orderNumber: string
  capturedAt: string
  outletId: string
  shiftId: string | null
  paymentMethod: string
  quotedTotal: number | null
  /** The A10 receipt snapshot, verbatim. */
  receiptSnapshot: unknown
  /** queued = still in the outbox (queued or retrying); parked = needs review; synced = acknowledged. */
  state: 'queued' | 'parked' | 'synced'
  /** An unacknowledged refund (queued or parked) names this sale. */
  refundQueued: boolean
  /** This tablet saw the server acknowledge a refund of this sale. */
  refunded: boolean
}

/** Where a refund's sale stands for the send rule. */
type SaleState = 'acked' | 'queued' | 'parked' | 'unknown'

const SALE_IN_REVIEW_MESSAGE =
  'Penjualan asal refund ini sedang ditinjau, jadi refund ditahan dan tidak dikirim. Jangan bayar ulang. Hubungi admin untuk meninjau penjualan ini.'

/** A shift open/close still waiting in the outbox, for overlaying the header (A04). */
export interface PendingShiftOp {
  type: 'shift_open' | 'shift_close'
  idempotencyKey: string
  payload: Record<string, unknown>
  clientCreatedAt: string
  /** Parked for review: it will NOT be sent until a person retries it. */
  parked: boolean
}

export const ENVELOPE_REFUSED_MESSAGE =
  'Akun atau outlet terminal belum terverifikasi. Masuk ulang atau hubungi admin.'

const ONLINE = () => typeof navigator === 'undefined' || navigator.onLine

/** Every element must be an object with string idempotencyKey and note (name defaults to ''). */
function isValidResolvedReply(v: unknown): v is { idempotencyKey: string; note: string; resolvedByName?: string }[] {
  return Array.isArray(v) && v.every((x) => {
    if (typeof x !== 'object' || x === null) return false
    const o = x as Record<string, unknown>
    return typeof o.idempotencyKey === 'string' && typeof o.note === 'string'
  })
}

export class SyncEngine {
  readonly deviceId: string
  readonly outbox: Outbox
  readonly snapshot: Snapshot
  readonly pending: PendingCredits
  /** A15: debits of acked orders the next pulled snapshot may not contain yet (display only). */
  private readonly settling: SettlingDebits
  private readonly syncedRefunds: SyncedRefunds
  private refundMemory: Promise<boolean> = Promise.resolve(true)
  /** Local receipts of acknowledged sales (A41); follows the outbox store like the refund memory. */
  private readonly receiptArchive: ReceiptArchive
  private receiptMemory: Promise<boolean> = Promise.resolve(true)
  private creditedView: Bundle | null = null
  private flushing = false
  // idempotencyKeys already surfaced via onDeadLetter — emit each once.
  private reportedDead = new Set<string>()
  private reportedStuck = new Set<string>()
  // Set while the server answers the whole batch with an account/session-level 4xx.
  private accountProblemMsg: string | null = null
  // Transient whole-batch failures push this out (exponential backoff + jitter).
  private nextFlushAt = 0
  private backoffStep = 0
  private disposed = false
  /** How many times an acked order was held back from ack because its settling-debit write failed. */
  private readonly settlingHolds = new Map<string, number>()
  /** Bumped by every dispose(); lets an in-flight pull tell it was retired even if start() revived the engine. */
  private disposeEpoch = 0
  // Review check-in (head-office resolve). Key -> last time it was sent in a successful check-in.
  private reviewSentAt = new Map<string, number>()
  private reviewCheckInAt = 0
  private checkingIn = false
  // Automatic check-ins run only after start() outside flushOnly mode.
  private autoCheckIn = false
  private stopTimers: (() => void) | null = null
  private wall: WallState
  private reachable: boolean = ONLINE()

  private readonly kv: KV
  /** Last successful online contact (A05): drives the 12 h soft block and the item evidence. */
  private readonly contacts: OfflineContact
  private newestCapture = 0
  private newestScanned = false
  private actorProvider: ActorProvider | null

  constructor(
    private api: ApiLike,
    private events: SyncEvents = {},
    kv: KV = defaultKV,
    options: SyncEngineOptions,
  ) {
    this.kv = kv
    this.actorProvider = options.actor
    this.deviceId = getDeviceId(kv)
    this.contacts = new OfflineContact(kv)
    const store = options.outboxStore ?? new KVOutboxStore(kv)
    this.outbox = new Outbox(store)
    this.snapshot = new Snapshot(kv)
    this.pending = new PendingCredits(kv)
    this.settling = new SettlingDebits(kv)
    this.syncedRefunds = new SyncedRefunds(store.kv)
    this.receiptArchive = new ReceiptArchive(store.kv)
    // Self-heal: an acked refund still in the queue means a crash hit between its ack and the
    // synced-refund write; fold it into the memory now.
    this.refundMemory = this.foldAckedRefunds()
    this.receiptMemory = this.foldAckedReceipts()
    this.recomputeCredited()
    this.wall = { raised: false, localVersion: this.snapshot.localVersion(), serverVersion: this.snapshot.localVersion() }
  }

  /** Durably record the orders of acked refunds (those just acked plus any still sitting in the
   *  queue). Resolves false, never rejects, when the write failed: the caller must then keep the rows. */
  private foldAckedRefunds(extra: readonly string[] = []): Promise<boolean> {
    const ids = new Set(extra)
    for (const i of this.outbox.all()) {
      if (i.type !== 'refund' || i.status !== 'acked') continue
      for (const id of [i.payload.orderId, i.payload.saleOrderUuid, i.ackedOrderId]) if (typeof id === 'string') ids.add(id)
    }
    ids.delete('')
    if (!ids.size) return Promise.resolve(true)
    return this.syncedRefunds.addMany([...ids]).then(
      () => true,
      (err) => {
        console.error('[sync] synced-refund memory write failed; acked refund rows are kept', err)
        return false
      },
    )
  }

  /** What the archive prune must respect, read from the live outbox: the unacknowledged sales (they
   *  count toward the newest 500) and the sales named by refunds that are not yet acknowledged. */
  private receiptContext(): ReceiptContext {
    const unsynced: ReceiptContext['unsynced'][number][] = []
    const referenced = new Set<string>()
    for (const i of this.outbox.all()) {
      if (i.status === 'acked') continue
      if (i.type === 'order' && typeof i.payload.orderUuid === 'string') {
        unsynced.push({ orderUuid: i.payload.orderUuid, outletId: i.envelope?.outletId ?? '', capturedAt: i.envelope?.capturedAt ?? i.clientCreatedAt, seq: i.seq })
      } else if (i.type === 'refund') {
        for (const k of [i.payload.saleOrderUuid, i.payload.orderId]) if (typeof k === 'string' && k) referenced.add(k)
      }
    }
    return { unsynced, referenced }
  }

  /** Durably archive the receipts of acked sales (those still sitting in the queue as acked rows) and
   *  prune the archive. Idempotent. Resolves false, never rejects, when the write failed: the caller must
   *  then keep the acked rows, which stay the only copy. */
  private foldAckedReceipts(): Promise<boolean> {
    const incoming: ReceiptEntry[] = []
    for (const i of this.outbox.all()) {
      if (i.status !== 'acked') continue
      const e = receiptEntryFromItem(i)
      if (e) incoming.push(e)
    }
    return this.receiptArchive.addMany(incoming, () => this.receiptContext()).then(
      () => true,
      (err) => {
        console.error('[sync] receipt archive write failed; acked sale rows are kept', err)
        return false
      },
    )
  }

  /** Resolves when this engine has nothing queued to write (outbox, refund memory, receipt archive). Call on the
   *  old engine before building its replacement (journal wiring rule). */
  async idle(): Promise<void> {
    await this.outbox.idle()
    await this.syncedRefunds.idle()
    await this.receiptArchive.idle()
    await this.settling.idle()
    await this.refundMemory
    await this.receiptMemory
  }

  /** Re-read the committed queue from the store and re-fold acked refunds. Only after the previous
   *  engine and the store are idle (see {@link idle}); no-op on the KV store. */
  async rehydrate(): Promise<void> {
    await this.outbox.refresh()
    // A flush on this same instance (a flush-only <-> normal flip keeps it) may be inside a settling write:
    // wait for it, or reload() would read the old blob and drop that entry.
    await this.settling.idle()
    this.settling.reload() // the predecessor's last writes landed after this engine's constructor read the key
    this.refundMemory = this.foldAckedRefunds()
    this.receiptMemory = this.foldAckedReceipts()
    await this.refundMemory
    await this.receiptMemory
  }

  /** Retire this engine (SyncProvider unmounted / replaced after logout): stop
   *  timers, ignore an in-flight flush's result, and make its outbox read-only so
   *  it can never overwrite what the next engine commits. `start()` revives it,
   *  because React StrictMode re-runs effects on the same instance in dev. */
  dispose(): void {
    this.disposed = true
    this.disposeEpoch += 1
    this.settling.dispose()
    this.stopTimers?.()
    this.stopTimers = null
    this.outbox.dispose()
  }

  /** Still-retrying items past the consecutive-retryable-failure threshold. */
  stuckRetrying(): { idempotencyKey: string; type: string; lastError?: string }[] {
    return this.outbox.stuckRetrying().map((i) => ({
      idempotencyKey: i.idempotencyKey,
      type: i.type,
      lastError: i.lastError,
    }))
  }

  /** Last known real server reachability (updated by resync / checkVersion). */
  isReachable(): boolean {
    return this.reachable
  }

  private setReachable(online: boolean): void {
    if (online === this.reachable) return
    this.reachable = online
    this.events.onReachable?.(online)
  }

  private recomputeCredited(): void {
    const credits = this.pending.list()
    this.creditedView = credits.length ? applyCredits(this.snapshot.get(), credits) : null
  }

  // ── Reference snapshot ──────────────────────────────────

  /** Initial/refresh pull when online; atomically swaps the local snapshot. */
  async resync(): Promise<void> {
    // A15: number the pull before it is sent. Debits acked before this number was taken are in what the
    // server answers; anything acked after (or while) it is in flight stays until a later pull.
    const epoch = this.disposeEpoch
    const pullNo = await this.settling.beginPull()
    const r = await this.api.request<{ data: Bundle }>('GET', '/api/v1/sync/pull')
    if (this.disposeEpoch !== epoch) return // disposed mid-flight: the live engine owns the snapshot and the settling state
    this.setReachable(true)
    this.noteContact() // a 2xx pull is a contact (unsigned: the pull carries no token)
    const known = new Set<string>()
    for (const p of r.data.products ?? []) for (const v of p.variants) known.add(`${p.id}|${v.size}`)
    // A response older than one already applied would roll the snapshot (and stock) back.
    if (!this.settling.applyPull(pullNo, known)) return
    this.snapshot.replace(r.data)
    this.pending.retire(r.data.version ?? 0)
    this.recomputeCredited()
    this.wall = {
      raised: false,
      localVersion: r.data.version ?? 0,
      serverVersion: r.data.version ?? 0,
    }
    this.events.onWall?.(this.wall)
  }

  /** Read-only: version of the reference data (catalog, prices, rules) this device sells against. */
  referenceVersion(): number {
    return this.snapshot.localVersion()
  }

  getSnapshot(): Bundle {
    return this.creditedView ?? this.snapshot.get()
  }

  getWall(): WallState {
    return this.wall
  }

  /** Poll the lightweight version endpoint; raise the wall on a server bump. */
  async checkVersion(): Promise<WallState> {
    if (!ONLINE()) {
      this.setReachable(false)
      return this.wall
    }
    try {
      const r = await this.api.request<{ data: VersionInfo }>(
        'GET',
        `/api/v1/sync/version?deviceId=${encodeURIComponent(this.deviceId)}`,
      )
      this.setReachable(true)
      // A05: only a 2xx counts as contact (the 4xx branch below never does).
      this.noteContact(r.data.contact)
      const server = r.data.version ?? 0
      const local = this.snapshot.localVersion()
      this.wall = {
        raised: server > local,
        localVersion: local,
        serverVersion: server,
      }
      this.events.onWall?.(this.wall)
      this.accountProblemMsg = null // the account/outlet is fine again (e.g. a terminal outlet was picked)
    } catch (err) {
      this.contacts.state(this.newestCaptureMs()) // time passes offline: advance the high-water mark
      const failure = classifyFailure(err, true)
      if (failure.kind === 'account' || failure.kind === 'rejected' || failure.kind === 'unauthorized') {
        // A 4xx means the server ANSWERED: reachable, but this account/outlet is refused
        // (e.g. 403 no active outlet). Not "offline" and not a reason to block selling.
        this.setReachable(true)
        if (failure.kind !== 'unauthorized') this.accountProblemMsg = ACCOUNT_PROBLEM_MESSAGE
      } else {
        // The GET failed → the server is unreachable (navigator.onLine can falsely
        // report online on Android WebViews). Keep selling on last snapshot.
        this.setReachable(false)
      }
    }
    return this.wall
  }

  // ── Outbox ──────────────────────────────────────────────

  private key(orderUuid: string): string {
    return `${this.deviceId}:${orderUuid}`
  }

  /** Non-null when the stored outbox was unreadable and has been quarantined
   *  (raw bytes kept under `mandalika.outbox.corrupt.*`). The UI shows a
   *  persistent banner; the queue itself started empty. */
  outboxCorruption(): OutboxCorruption | null {
    return this.outbox.corruptionInfo()
  }

  /** Capture-time identity for a new item, or undefined when no provider is configured
   *  (tests/legacy). A configured provider that returns null refuses the mutation: nothing
   *  may be queued under an unknown account/outlet (A04). */
  private captureEnvelope(capturedAt: string): OutboxEnvelope | undefined {
    if (!this.actorProvider) return undefined
    const a = this.actorProvider()
    if (!a || !a.outletId || !a.userId) throw new Error(ENVELOPE_REFUSED_MESSAGE)
    const env: OutboxEnvelope = {
      v: 1,
      outletId: a.outletId,
      userId: a.userId,
      deviceId: this.deviceId,
      capturedAt,
    }
    if (a.shiftId) env.shiftId = a.shiftId
    if (a.appVersion) env.appVersion = a.appVersion
    // A05 evidence for the server's offline cap; omitted until a contact is known.
    const ev = this.contacts.evidence(this.newestCaptureMs())
    if (ev) {
      env.contactDeviceAt = ev.contactDeviceAt
      env.offlineMs = ev.offlineMs
      if (ev.contact) env.contact = ev.contact
    }
    return env
  }

  /** A successful online contact (A05). It also resets the newest-capture high water: only items
   *  captured AFTER this contact may hold the window open, so a corrected clock plus a 2xx
   *  contact clears a lock caused by a wrongly-forward clock. */
  private noteContact(signed?: { at: string; sig: string } | null): void {
    this.contacts.contact(signed)
    this.newestCapture = 0
    this.newestScanned = true
  }

  /** Latest capture time (ms) among items captured since the current contact; holds the offline
   *  window open after a clock set back. Scanned once at start (only items stamped with this
   *  contact or a later one; parked review items and older rows are ignored), then kept current
   *  by commitOutbox and reset by every contact. */
  private newestCaptureMs(): number {
    if (!this.newestScanned) {
      this.newestScanned = true
      const since = this.contacts.record()?.deviceAt
      if (since !== undefined) {
        for (const i of this.outbox.all()) {
          const cd = i.envelope?.contactDeviceAt
          if (i.reviewCode || cd === undefined || cd < since) continue
          const t = Date.parse(i.envelope?.capturedAt ?? '')
          if (Number.isFinite(t)) this.newestCapture = Math.max(this.newestCapture, t)
        }
      }
    }
    return this.newestCapture
  }

  /** Where the tablet stands against the 12 h offline cap (A05). The UI gates new sales,
   *  refunds and cash in/out on `locked`; the engine itself never refuses to enqueue. */
  offlineState(): OfflineCapState {
    return this.contacts.state(this.newestCaptureMs())
  }

  /** Durably commit a mutation without triggering a flush. Resolves only once
   *  the outbox write succeeded; rejects (no trace left) if it failed. */
  private async commitOutbox(
    type: OutboxType,
    payload: Record<string, unknown>,
    orderUuid: string,
  ): Promise<string> {
    const idempotencyKey = this.key(orderUuid)
    const capturedAt = new Date().toISOString()
    const envelope = this.captureEnvelope(capturedAt)
    await this.outbox.add(type, idempotencyKey, {
      ...payload,
      orderUuid,
      deviceId: this.deviceId,
      clientCreatedAt: capturedAt,
    }, envelope)
    this.newestCapture = Math.max(this.newestCapture, Date.parse(capturedAt))
    return idempotencyKey
  }

  /** Queue a mutation. Resolves with the idempotency key + order uuid only
   *  after the item is durably stored; rejects if the write failed, in which
   *  case nothing was queued and nothing will be sent. */
  async enqueue(
    type: OutboxType,
    payload: Record<string, unknown>,
    orderUuid = uuid(),
  ): Promise<{ idempotencyKey: string; orderUuid: string }> {
    const idempotencyKey = await this.commitOutbox(type, payload, orderUuid)
    this.events.onOutboxChange?.(this.outbox.count())
    void this.flush()
    return { idempotencyKey, orderUuid }
  }

  /** Enqueue a POS transfer receive and optimistically credit the counted qty.
   *  The PIN is validated by the UI before this; it rides in the payload for
   *  server re-validation and is dropped from the outbox when the item acks. */
  async enqueueTransferReceive(input: {
    transferId: string
    items: { productId: string; variantSize: string; receivedQty: number }[]
    discrepancyReason?: string
    approverUserId: string
    pin: string
  }): Promise<{ idempotencyKey: string }> {
    const orderUuid = uuid()
    const idempotencyKey = this.key(orderUuid)
    const lines: CreditLine[] = input.items
      .filter((it) => it.receivedQty > 0)
      .map((it) => ({ productId: it.productId, variantSize: it.variantSize, qty: it.receivedQty }))
    // Outbox first: if the write fails nothing exists, so there is no credit to
    // roll back (a lost rollback would leave inflated stock that never retires).
    // Do not add an await between the commit and pending.add: an ack can only
    // arrive in a later macrotask, so stampAck always finds the credit.
    await this.commitOutbox('transfer_receive', {
      transferId: input.transferId,
      items: input.items,
      discrepancyReason: input.discrepancyReason ?? '',
      approverUserId: input.approverUserId,
      pin: input.pin,
    }, orderUuid)
    this.pending.add({ idempotencyKey, lines, ackVersion: null })
    this.recomputeCredited()
    this.events.onOutboxChange?.(this.outbox.count())
    void this.flush()
    return { idempotencyKey }
  }

  pendingCount(): number {
    return this.outbox.count()
  }

  /** Shift opens/closes not yet acknowledged by the server (queued, retrying or parked),
   *  oldest first. The shift header overlays these on the last known server shift so an
   *  offline open/close is visible and a second open is never offered (A04). */
  pendingShiftOps(): PendingShiftOp[] {
    const parked = new Set(this.outbox.deadLettered().map((i) => i.idempotencyKey))
    return this.outbox
      .all()
      .filter((i) => (i.type === 'shift_open' || i.type === 'shift_close') && i.status !== 'acked')
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((i) => ({
        type: i.type as 'shift_open' | 'shift_close',
        idempotencyKey: i.idempotencyKey,
        payload: i.payload,
        clientCreatedAt: i.clientCreatedAt,
        parked: parked.has(i.idempotencyKey),
      }))
  }

  /** The queue by what it means for releasing the terminal / signing in another account. */
  queueSummary(): QueueSummary {
    return summarizeQueue(this.outbox.all())
  }

  /** Items waiting to be sent or needing review (the terminal-release guard, A04). */
  unsettledCount(): number {
    return this.outbox.all().filter((i) => i.status !== 'acked').length
  }

  /** SP-CRM-9c: sum unsynced order quantities per `${productId}|${variantSize}` so
   *  the POS can optimistically decrement displayed stock. Includes reward lines
   *  because they decrement stock server-side too. Parked (needs-review) orders are included until head
   *  office resolves them, and A15 adds acked orders until a pull sent after the ack. */
  pendingStockDeltas(): Record<string, number> {
    const deltas: Record<string, number> = {}
    // Queued and parked (needs review) sales never reached server stock, or are not yet in the snapshot.
    const unacked = [...this.outbox.pending(), ...this.outbox.deadLettered()]
    const unackedKeys = new Set(unacked.map((i) => i.idempotencyKey))
    // Only the outlet in effect (a flush-only or mismatched terminal may still drain another outlet's queue).
    const outlet = this.actorProvider?.()?.outletId
    const inScope = (o: string | undefined) => !outlet || !o || o === outlet
    const add = (lines: DebitLine[]) => {
      for (const l of lines) {
        const key = `${l.productId}|${l.variantSize}`
        deltas[key] = (deltas[key] ?? 0) + l.qty
      }
    }
    for (const item of unacked) {
      if (item.type === 'order' && inScope(item.envelope?.outletId)) add(orderDebitLines(item))
    }
    // A15: acked orders until a pull sent after the ack. Skip one only while its item is still unacked
    // (a failed settle write); an acked row left behind by a skipped prune must NOT hide it.
    for (const e of this.settling.list()) {
      if (!unackedKeys.has(e.key) && inScope(e.outletId)) add(e.lines)
    }
    return deltas
  }

  /** Permanently-rejected items (server kept refusing) with their error text. */
  deadLettered(): { idempotencyKey: string; type: string; lastError?: string }[] {
    return this.outbox.deadLettered().map((i) => ({
      idempotencyKey: i.idempotencyKey,
      type: i.type,
      lastError: i.lastError,
    }))
  }

  /** Unacknowledged refunds (queued, retrying or parked for review), oldest first. A parked refund
   *  is NOT settled: the cashier may already have paid the customer. Feeds the POS refund gate and
   *  the shift recap; read-only, the payload stays exactly as captured (A11 fingerprint). */
  queuedRefunds(): QueuedRefund[] {
    const parked = new Set(this.outbox.deadLettered().map((i) => i.idempotencyKey))
    return this.outbox
      .all()
      .filter((i) => i.type === 'refund' && i.status !== 'acked')
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((i) => ({
        idempotencyKey: i.idempotencyKey,
        orderId: typeof i.payload.orderId === 'string' ? i.payload.orderId : '',
        shiftId: i.envelope?.shiftId ?? null,
        parked: parked.has(i.idempotencyKey),
        payload: i.payload,
      }))
  }

  /** Orders whose refund this tablet saw the server acknowledge (persistent, bounded). */
  syncedRefundOrderIds(): Set<string> {
    return this.syncedRefunds.ids()
  }

  /** Orders that already have an unacknowledged refund (incl. parked): no second refund may start. */
  queuedRefundOrderIds(): Set<string> {
    return new Set(this.queuedRefunds().map((r) => r.orderId).filter((id) => id !== ''))
  }

  /** Sales (by client orderUuid) that already have an unacknowledged refund (incl. parked). */
  queuedRefundSaleUuids(): Set<string> {
    const out = new Set<string>()
    for (const r of this.queuedRefunds()) {
      const u = r.payload.saleOrderUuid
      if (typeof u === 'string' && u) out.add(u)
    }
    return out
  }

  /** Where the sale named by a linked refund stands. An acked row not yet pruned counts as acked. */
  private saleState(orderUuid: string): SaleState {
    const row = this.outbox.all().find((i) => i.type === 'order' && i.payload.orderUuid === orderUuid)
    if (row) {
      if (row.status === 'acked') return 'acked'
      return row.status === 'failed' && (row.attempts ?? 0) >= MAX_ATTEMPTS ? 'parked' : 'queued'
    }
    return this.receiptArchive.entries().some((e) => e.orderUuid === orderUuid) ? 'acked' : 'unknown'
  }

  /** Sales made on this tablet at the outlet in effect: the ones still in the outbox plus the archived
   *  receipts, newest first. A derived view; nothing here is stored twice. */
  localReceipts(): LocalReceipt[] {
    const outlet = this.actorProvider?.()?.outletId
    const inScope = (o: string | undefined) => !outlet || !o || o === outlet
    const refunded = this.syncedRefunds.ids()
    const queuedRefunds = new Set<string>()
    for (const r of this.queuedRefunds()) {
      if (r.orderId) queuedRefunds.add(r.orderId)
      const u = r.payload.saleOrderUuid
      if (typeof u === 'string' && u) queuedRefunds.add(u)
    }
    const flags = (orderUuid: string, serverOrderId?: string) => ({
      refundQueued: queuedRefunds.has(orderUuid) || (!!serverOrderId && queuedRefunds.has(serverOrderId)),
      refunded: refunded.has(orderUuid) || (!!serverOrderId && refunded.has(serverOrderId)),
    })
    const byUuid = new Map<string, { r: LocalReceipt; order: number }>()
    this.receiptArchive.entries().forEach((e, index) => {
      if (!inScope(e.outletId)) return
      byUuid.set(e.orderUuid, {
        order: index,
        r: {
          orderUuid: e.orderUuid, idempotencyKey: e.idempotencyKey, ...(e.serverOrderId ? { serverOrderId: e.serverOrderId } : {}),
          orderNumber: e.orderNumber, capturedAt: e.capturedAt, outletId: e.outletId, shiftId: e.shiftId,
          paymentMethod: e.paymentMethod, quotedTotal: e.quotedTotal, receiptSnapshot: e.receiptSnapshot, state: 'synced',
          ...flags(e.orderUuid, e.serverOrderId),
        },
      })
    })
    for (const i of this.outbox.all()) {
      if (i.status === 'acked' || i.type !== 'order' || !inScope(i.envelope?.outletId)) continue
      const e = receiptEntryFromItem(i)
      if (!e) continue
      byUuid.set(e.orderUuid, {
        order: i.seq,
        r: {
          orderUuid: e.orderUuid, idempotencyKey: e.idempotencyKey, orderNumber: e.orderNumber, capturedAt: e.capturedAt,
          outletId: e.outletId, shiftId: e.shiftId, paymentMethod: e.paymentMethod, quotedTotal: e.quotedTotal,
          receiptSnapshot: e.receiptSnapshot, state: i.status === 'failed' && (i.attempts ?? 0) >= MAX_ATTEMPTS ? 'parked' : 'queued',
          ...flags(e.orderUuid),
        },
      })
    }
    const at = (r: LocalReceipt) => {
      const t = Date.parse(r.capturedAt)
      return Number.isFinite(t) ? t : 0
    }
    return [...byUuid.values()].sort((a, b) => at(b.r) - at(a.r) || b.order - a.order).map((x) => x.r)
  }

  /** Items needing review: explicit server/client verdicts plus legacy attempt-count
   *  parks. Never auto-retried, never deleted. */
  reviewItems(): ReviewItem[] {
    return this.outbox.reviewItems()
  }

  private resetBackoff(): void {
    this.nextFlushAt = 0
    this.backoffStep = 0
  }

  /** Non-null while /sync/batch is refused for an account/session reason (e.g. 403
   *  outlet not permitted). Nothing is held against the items; cleared on a good batch. */
  accountProblem(): string | null {
    return this.accountProblemMsg
  }

  /** When the next automatic flush may run (epoch ms; 0 = no backoff). */
  nextFlushTime(): number {
    return this.nextFlushAt
  }

  private scheduleBackoff(): void {
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.backoffStep)
    this.backoffStep += 1
    this.nextFlushAt = Date.now() + Math.round(delay * (0.5 + Math.random() * 0.5))
  }

  /** User-initiated flush ("Kirim sekarang"): ignores any backoff. */
  flushNow(): Promise<BatchResult | null> {
    this.resetBackoff()
    return this.flush()
  }

  /** Manual retry of parked items. Rejects if the reset could not be stored. */
  async retryFailed(): Promise<void> {
    this.resetBackoff()
    // Another account's parked items stay parked: re-sending them would only be refused
    // again (actor_mismatch). Items without an envelope are retried as before.
    const me = this.actorProvider?.()?.userId
    const requeued: string[] = []
    await this.outbox.retryDeadLettered((i) => {
      const mine = !i.envelope || !me || i.envelope.userId === me
      if (mine) requeued.push(i.idempotencyKey)
      return mine
    })
    // A re-queued item that parks again is new to head office: clear its reported stamp.
    for (const k of requeued) this.reviewSentAt.delete(k)
    this.events.onOutboxChange?.(this.outbox.count())
    void this.flush()
  }

  /**
   * Build shareable diagnostics without resolving or changing parked operations.
   * Detach the JSON-compatible queue data before redaction/formatting so even
   * nested diagnostic edits cannot change the original retry payloads.
   * Only the separate support log is capped; the operational outbox is untouched.
   */
  buildFailedSyncDiagnostics(): string {
    const dead = JSON.parse(JSON.stringify(this.outbox.deadLettered())) as OutboxItem[]
    if (dead.length) {
      const now = new Date().toISOString()
      this.appendSyncLog(dead.map((d) => ({
        at: now,
        deviceId: this.deviceId,
        type: d.type,
        idempotencyKey: d.idempotencyKey,
        lastError: forLogsText(d.lastError),
        reviewCode: d.reviewCode,
        reviewReason: forLogsText(d.reviewReason),
        clientCreatedAt: d.clientCreatedAt,
        payload: forLogs(d.payload),
      })))
    }
    const redacted = dead.map((d) => ({
      ...d,
      payload: forLogs(d.payload),
      ...(d.lastError !== undefined ? { lastError: forLogsText(d.lastError) } : {}),
      ...(d.reviewReason !== undefined ? { reviewReason: forLogsText(d.reviewReason) } : {}),
      ...(d.envelope ? { envelope: redactForLogs(d.envelope) as typeof d.envelope } : {}),
    }))
    return JSON.stringify(redacted, null, 2)
  }

  private appendSyncLog(entries: readonly unknown[]): void {
    const log = readJSON<unknown[]>(this.kv, SYNC_LOG_KEY, [])
    log.push(...entries)
    writeJSON(this.kv, SYNC_LOG_KEY, log.slice(-200)) // keep last 200
  }

  /** True once the item went out in a successful review check-in (cashier label). */
  isReviewReported(key: string): boolean {
    return this.reviewSentAt.has(key)
  }

  /** Report parked review items to head office and remove the ones it resolved.
   *  Throttled; any failure leaves the queue untouched and is retried next cycle. */
  async checkInReviews(): Promise<void> {
    if (this.disposed || this.checkingIn || !ONLINE()) return
    const all = this.outbox.reviewItems()
    if (all.length === 0) return
    const unreported = all.filter((i) => !this.reviewSentAt.has(i.idempotencyKey))
    const wait = unreported.length ? REVIEW_CHECKIN_NEW_MS : REVIEW_CHECKIN_MS
    if (Date.now() - this.reviewCheckInAt < wait) return
    this.reviewCheckInAt = Date.now()
    this.checkingIn = true
    try {
      const reported = all
        .filter((i) => this.reviewSentAt.has(i.idempotencyKey))
        .sort((a, b) => (this.reviewSentAt.get(a.idempotencyKey) ?? 0) - (this.reviewSentAt.get(b.idempotencyKey) ?? 0))
      const batch = [...unreported, ...reported].slice(0, REVIEW_CHECKIN_MAX_ITEMS)
      const body: ReviewReportRequest = { items: batch.map(toReviewReport) }
      const r = await this.api.request<{ data?: ReviewReportResult }>(
        'POST', '/api/v1/sync/review-items', body, { timeoutMs: REVIEW_CHECKIN_TIMEOUT_MS },
      )
      const resolved = r?.data?.resolved
      if (!isValidResolvedReply(resolved) || this.disposed) return
      const sentAt = Date.now()
      for (const i of batch) this.reviewSentAt.set(i.idempotencyKey, sentAt)
      if (resolved.length === 0) return
      const byKey = new Map(resolved.map((x) => [x.idempotencyKey, x]))
      // Snapshot what is parked now: a rejected removal may still have landed (the journal
      // store resyncs from disk on a failed write), so judge it by what is gone afterwards.
      const parkedBefore = new Map(
        this.outbox.reviewItems().filter((i) => byKey.has(i.idempotencyKey)).map((i) => [i.idempotencyKey, i]),
      )
      if (parkedBefore.size === 0) return
      // A15: a resolved sale may not be in the snapshot yet. Keep its debit (it can only err LOW) until a
      // later pull; the entry is hidden while the item is still parked, so recording first never double counts.
      await this.settling.recordMany(
        [...parkedBefore.values()].filter((i) => i.type === 'order').map((i) => ({
          key: i.idempotencyKey, outletId: i.capturedOutletId, lines: orderDebitLines(i),
        })),
      ).catch((err) => console.error('[sync] settling-debit write failed for resolved review items', err))
      let removed: readonly Pick<OutboxItem, 'idempotencyKey' | 'type'>[]
      try {
        removed = await this.outbox.resolveReviewed([...parkedBefore.keys()])
      } catch {
        // Judge by absence from the WHOLE queue, not reviewItems(): that lists parked items
        // only, so a key a concurrent "Coba lagi" flipped to pending would look removed.
        const present = new Set(this.outbox.all().map((i) => i.idempotencyKey))
        removed = [...parkedBefore.values()].filter((i) => !present.has(i.idempotencyKey))
      }
      if (removed.length === 0) return
      const notices = removed.map((i): ReviewResolvedNotice => {
        const x = byKey.get(i.idempotencyKey)!
        this.reviewSentAt.delete(i.idempotencyKey)
        return { idempotencyKey: i.idempotencyKey, type: i.type, note: x.note, resolvedByName: x.resolvedByName ?? '' }
      })
      // Notify first; a failing event handler or sync-log write must not suppress the other.
      try {
        this.events.onReviewResolved?.(notices)
      } finally {
        try {
          const at = new Date().toISOString()
          this.appendSyncLog(notices.map((n) => ({
            at, deviceId: this.deviceId, type: n.type, idempotencyKey: n.idempotencyKey,
            event: 'diselesaikan kantor pusat', note: n.note, resolvedByName: n.resolvedByName,
          })))
        } catch {
          // The log is best-effort diagnostics; the items are already gone and announced.
        }
      }
    } catch {
      // Offline, server error, expired login, older server or a failed queue write:
      // nothing changed; the throttle above spaces out the retry.
    } finally {
      this.checkingIn = false
    }
  }

  /** The recorded sync-failure debug log (most recent last, capped at 200). */
  syncLog(): unknown[] {
    return readJSON<unknown[]>(this.kv, SYNC_LOG_KEY, [])
  }

  /**
   * Flush the outbox in order, one batch at a time. Always allowed even while
   * the sync wall is raised so pending revenue is never trapped (plan §5a).
   * Skipped while a transient-failure backoff is running (see {@link flushNow}).
   */
  async flush(): Promise<BatchResult | null> {
    if (this.disposed || this.flushing || !ONLINE()) return null
    if (Date.now() < this.nextFlushAt) return null
    // One snapshot per flush, never re-read between chunks: settling-held orders (A15) stay pending
    // and would be resent in the same flush. Items enqueued meanwhile go out on the next tick.
    const pending = this.outbox.pending()
    if (pending.length === 0) return null
    this.flushing = true
    try {
      const typeByKey = new Map(pending.map((i) => [i.idempotencyKey, i.type]))
      let merged: BatchResult | null = null
      // Mirrors processBatch/onBatchFailure: after a retryable result, a later shift_close/shift_open must
      // not go out in another request (the server hold only sees the same request), so those stay pending
      // and unsent. Every other item keeps draining, so one stuck item cannot block the rest of the queue.
      let earlierRetryable = false
      // A41: a refund that names its sale by uuid is held (with every later shift open/close) until that sale
      // is acknowledged. Held items stay pending; a second pass sends them once their sale was acked by this
      // same flush, so sale and refund do not need two ticks.
      let work: readonly OutboxItem[] = pending
      const held = new Set<string>()
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) {
          if (held.size === 0 || this.disposed || !ONLINE()) break
          const keys = new Set(held)
          held.clear()
          work = this.outbox.pending().filter((i) => keys.has(i.idempotencyKey))
        }
        let linkedHold = false
        for (let at = 0; at < work.length; at += BATCH_MAX_ITEMS) {
          if (at > 0 && (this.disposed || !ONLINE())) break
          let chunk = work.slice(at, at + BATCH_MAX_ITEMS)
          if (earlierRetryable) chunk = chunk.filter((i) => i.type !== 'shift_close' && i.type !== 'shift_open')
          if (linkedHold) {
            for (const i of chunk) if (i.type === 'shift_close' || i.type === 'shift_open') held.add(i.idempotencyKey)
            chunk = chunk.filter((i) => i.type !== 'shift_close' && i.type !== 'shift_open')
          }
          const gated = await this.gateLinkedRefunds(chunk)
          for (const k of gated.held) held.add(k)
          if (gated.held.size) linkedHold = true
          chunk = gated.send
          if (this.disposed) return null
          if (chunk.length === 0) continue
          let data: BatchResult
          try {
            data = await this.post(chunk)
          } catch (err) {
            if (this.disposed) return null // replaced mid-flight: the live engine owns the queue
            // Stop after a thrown chunk (and its isolation pass): the next tick continues. The result
            // returned covers the chunks already sent plus whatever isolation settled.
            return mergeBatch(merged, await this.onBatchFailure(err, chunk, typeByKey))
          }
          if (this.disposed) return null
          await this.applyBatch(data, typeByKey)
          merged = mergeBatch(merged, data)
          if (data.results.some((r) => r.status === 'error' && r.retryable !== false)) earlierRetryable = true
        }
      }
      return merged
    } finally {
      this.flushing = false
      this.emitDeadLetters()
      this.emitStuckRetrying()
      if (this.autoCheckIn) void this.checkInReviews()
    }
  }

  /** Apply the send rule to the linked refunds of a chunk, in order. A refund whose sale is acknowledged (or
   *  unknown here: the server decides) goes out; one whose sale is queued is held together with every later
   *  shift open/close (A06/M3); one whose sale is parked is parked too (sale_in_review): never sent, never
   *  deleted, and it does not hold anything back. */
  private async gateLinkedRefunds(chunk: readonly OutboxItem[]): Promise<{ send: OutboxItem[]; held: Set<string> }> {
    const send: OutboxItem[] = []
    const held = new Set<string>()
    const toPark: string[] = []
    let holding = false
    for (const i of chunk) {
      if (holding && (i.type === 'shift_close' || i.type === 'shift_open')) {
        held.add(i.idempotencyKey)
        continue
      }
      const sale = i.type === 'refund' ? i.payload.saleOrderUuid : undefined
      if (typeof sale !== 'string' || !sale) {
        send.push(i)
        continue
      }
      const state = this.saleState(sale)
      if (state === 'queued') {
        held.add(i.idempotencyKey)
        holding = true
      } else if (state === 'parked') {
        toPark.push(i.idempotencyKey)
      } else {
        send.push(i)
      }
    }
    if (toPark.length) {
      await this.outbox.settle(toPark.map((key) => ({ key, op: 'review' as const, code: 'sale_in_review', reason: SALE_IN_REVIEW_MESSAGE })))
      this.events.onOutboxChange?.(this.outbox.count())
    }
    return { send, held }
  }

  private async post(items: readonly OutboxItem[]): Promise<BatchResult> {
    const r = await this.api.request<{ data: BatchResult }>(
      'POST',
      '/api/v1/sync/batch',
      {
        items: items.map((i) => ({
          type: i.type,
          idempotencyKey: i.idempotencyKey,
          payload: i.payload,
          // Sibling of payload (the A11 fingerprint covers the payload only). Items stored
          // before A04 have none and are sent as they are: never backfilled with today's actor.
          ...(i.envelope ? { envelope: i.envelope } : {}),
        })),
      },
      { timeoutMs: BATCH_TIMEOUT_MS },
    )
    if (!r?.data || !Array.isArray(r.data.results)) {
      throw Object.assign(new Error('respons server tidak valid'), { kind: 'invalid_response' })
    }
    return r.data
  }

  /** A whole-batch request failed. Only a deterministic 4xx is ever isolated per item. */
  private async onBatchFailure(
    err: unknown,
    items: readonly OutboxItem[],
    typeByKey: Map<string, OutboxType>,
  ): Promise<BatchResult | null> {
    const failure = classifyFailure(err, ONLINE())
    if (this.events.debug) {
      // eslint-disable-next-line no-console
      console.error('[sync] batch failed', failure.kind, failure.message, err)
    }
    if (failure.kind !== 'rejected') {
      await this.settleNonRejected(failure, items)
      return null
    }
    if (items.length === 1) {
      await this.parkRejected(items, failure.message) // this request already was the isolated one
      return null
    }
    // One malformed item must never park the whole queue: resend one per request,
    // in order. Items that succeed settle normally; the bad one goes to review.
    let last: BatchResult | null = null
    let rest = [...items]
    // Mirrors the server (processBatch): once an isolated item came back retryable, a later shift_close or
    // shift_open must not go out alone, because the server hold only sees items of the same request.
    // They stay pending and unsent; every other item is still isolated so a malformed one parks.
    let earlierRetryable = false
    while (rest.length) {
      const [it, ...tail] = rest
      if (earlierRetryable && (it.type === 'shift_close' || it.type === 'shift_open')) {
        rest = tail
        continue
      }
      try {
        const data = await this.post([it])
        if (this.disposed) return null
        await this.applyBatch(data, typeByKey)
        last = data
        if (data.results.some((r) => r.idempotencyKey === it.idempotencyKey && r.status === 'error' && r.retryable === true)) earlierRetryable = true
      } catch (e) {
        if (this.disposed) return null
        const f = classifyFailure(e, ONLINE())
        if (f.kind !== 'rejected') {
          await this.settleNonRejected(f, rest) // offline / 401 / transient: stop, hold nothing against them
          return last
        }
        await this.parkRejected([it], f.message)
      }
      rest = tail
    }
    return last
  }

  /** offline / 401 / account / transient: nothing is held against the items. */
  private async settleNonRejected(failure: Failure, items: readonly OutboxItem[]): Promise<void> {
    if (failure.kind === 'offline') {
      this.setReachable(false)
    } else if (failure.kind === 'account') {
      this.accountProblemMsg = ACCOUNT_PROBLEM_MESSAGE
      this.scheduleBackoff()
    } else if (failure.kind === 'transient') {
      // No attempt is burned, but a long outage still trips the after-10 report.
      await this.outbox.settle(
        items.map((i) => ({ key: i.idempotencyKey, op: 'fail' as const, error: failure.message, retryable: true })),
      )
      this.scheduleBackoff()
    } // 'unauthorized': the api client already ran the refresh path; keep everything queued
    this.events.onOutboxChange?.(this.outbox.count())
  }

  private async parkRejected(items: readonly OutboxItem[], message: string): Promise<void> {
    await this.outbox.settle(
      items.map((i) => ({ key: i.idempotencyKey, op: 'review' as const, code: 'batch_rejected', reason: message })),
    )
    this.events.onOutboxChange?.(this.outbox.count())
  }

  /** Apply a server batch response: ack/park each result, then refresh derived state. */
  private async applyBatch(data: BatchResult, typeByKey: Map<string, OutboxType>): Promise<void> {
    const updates: OutboxSettle[] = []
    const ackedRefundOrderIds: string[] = []
    const ackedOrders: { key: string; outletId?: string; lines: DebitLine[] }[] = []
    for (const res of data.results) {
      const type = typeByKey.get(res.idempotencyKey)
      if (res.status === 'ok' || res.status === 'duplicate') {
        // Only order/refund results carry an order id; other types return their own ids (shift, customer...).
        updates.push({ key: res.idempotencyKey, op: 'ack', ...((type === 'order' || type === 'refund') && res.orderId ? { orderId: res.orderId } : {}) })
        if (type === 'refund') {
          // The acked refund leaves the outbox: remember its order so a stale history row cannot offer it again.
          const acked = this.outbox.all().find((i) => i.idempotencyKey === res.idempotencyKey)
          for (const id of [acked?.payload.orderId, acked?.payload.saleOrderUuid, res.orderId]) {
            if (typeof id === 'string') ackedRefundOrderIds.push(id)
          }
        }
        this.pending.stampAck(res.idempotencyKey, data.version ?? 0)
        if (type === 'order') {
          // A15: keep the debit visible once the ack prunes the row; written before settle, so a crash
          // between the two can only leave a duplicate that the key-skip in pendingStockDeltas absorbs.
          const acked = this.outbox.all().find((i) => i.idempotencyKey === res.idempotencyKey)
          if (acked) ackedOrders.push({ key: acked.idempotencyKey, outletId: acked.envelope?.outletId, lines: orderDebitLines(acked) })
        }
        // SP4: surface the completed transfer to the UI so the tanda-terima
        // prompt can render. Only on a fresh 'ok' (a 'duplicate' replay means
        // the cashier already saw the prompt — skip the second modal).
        if (type === 'transfer_receive' && res.status === 'ok' && res.transfer) {
          this.events.onReceiveAccepted?.(res.transfer)
        }
        continue
      }
      const error = res.error ?? 'sync error'
      if (type === 'transfer_receive' && res.code === undefined) {
        // Older server (no error contract): keep the pre-contract behaviour.
        this.pending.remove(res.idempotencyKey)
        updates.push({ key: res.idempotencyKey, op: 'discard' })
        this.events.onReceiveRejected?.('Penerimaan dibatalkan — transfer sudah diterima di tempat lain. Stok dikembalikan.')
        continue
      }
      if (type === 'transfer_receive' && isReceiveConflict(res.code)) {
        // First valid receipt wins: take the optimistic credit back, but keep the
        // counted quantities for a person to review. Nothing is deleted.
        this.pending.remove(res.idempotencyKey)
        updates.push({ key: res.idempotencyKey, op: 'review', code: res.code as string, reason: error })
        this.events.onReceiveRejected?.(
          'Penerimaan perlu ditinjau — transfer ini sudah diterima di perangkat/akun lain. Stok dikembalikan; hitungan Anda tetap tersimpan.',
        )
        continue
      }
      if (this.events.debug) {
        // eslint-disable-next-line no-console
        console.error('[sync] item rejected', res.idempotencyKey, res.error)
      }
      if (res.retryable === false && res.code !== undefined && KNOWN_ERROR_CODES.has(res.code)) {
        updates.push({ key: res.idempotencyKey, op: 'review', code: res.code, reason: error })
      } else {
        updates.push({ key: res.idempotencyKey, op: 'fail', error, retryable: res.retryable })
      }
    }
    // One serialized write for the whole batch (settle is best-effort: a
    // failed write leaves items pending and the server dedups the resend).
    // If the debit could not be stored, do not ack/prune those orders now: the debit would vanish with the
    // row. They stay queued and the server dedups the resend (A11); the next batch records them again.
    // Bounded: after SETTLING_HOLD_MAX holds of one key it is acked anyway (the entry stays in memory), so
    // a persistently failing settling key can never block the queue and the terminal-release guard.
    let toSettle = updates
    try {
      await this.settling.recordMany(ackedOrders)
      for (const o of ackedOrders) this.settlingHolds.delete(o.key)
    } catch (err) {
      const held = new Set<string>()
      for (const o of ackedOrders) {
        const n = (this.settlingHolds.get(o.key) ?? 0) + 1
        this.settlingHolds.set(o.key, n)
        if (n <= SETTLING_HOLD_MAX) held.add(o.key)
        else this.settlingHolds.delete(o.key)
      }
      console.error(`[sync] settling-debit write failed; keeping ${held.size} acked order(s) queued`, err)
      toSettle = updates.filter((u) => !(u.op === 'ack' && held.has(u.key)))
    }
    await this.outbox.settle(toSettle)
    this.recomputeCredited()
    // The memory is the only copy once the acked row is pruned: durable first, and if it failed keep
    // the rows (the next engine start or batch folds them again).
    // Both folds always run; the acked rows are dropped only when both facts are durable.
    const [refundsOk, receiptsOk] = await Promise.all([this.foldAckedRefunds(ackedRefundOrderIds), this.foldAckedReceipts()])
    if (refundsOk && receiptsOk) await this.outbox.prune()
    this.accountProblemMsg = null
    this.resetBackoff()
    this.events.onOutboxChange?.(this.outbox.count())
    this.events.onReconcile?.(data)
    // Server returns its version on every ack — refresh wall state.
    const local = this.snapshot.localVersion()
    this.wall = {
      raised: (data.version ?? 0) > local,
      localVersion: local,
      serverVersion: data.version ?? 0,
    }
    this.events.onWall?.(this.wall)
  }

  /** Report (once each) items stuck in retryable failures; they keep retrying. */
  private emitStuckRetrying(): void {
    if (!this.events.onStuckRetrying || this.disposed) return
    const fresh = this.outbox.stuckRetrying().filter((i) => !this.reportedStuck.has(i.idempotencyKey))
    if (!fresh.length) return
    for (const i of fresh) this.reportedStuck.add(i.idempotencyKey)
    this.events.onStuckRetrying(
      fresh.map((i) => ({
        type: i.type,
        idempotencyKey: i.idempotencyKey,
        payload: forLogs(i.payload),
        lastError: forLogsText(i.lastError),
      })),
    )
  }

  /** Surface newly dead-lettered items to the app (once each) for error reporting. */
  private emitDeadLetters(): void {
    if (!this.events.onDeadLetter || this.disposed) return
    const fresh = this.outbox
      .deadLettered()
      .filter((i) => !this.reportedDead.has(i.idempotencyKey))
    if (!fresh.length) return
    for (const i of fresh) this.reportedDead.add(i.idempotencyKey)
    for (const i of fresh) {
      if (i.type === 'transfer_receive') this.pending.remove(i.idempotencyKey)
    }
    this.recomputeCredited()
    this.events.onDeadLetter(
      fresh.map((i) => ({
        type: i.type,
        idempotencyKey: i.idempotencyKey,
        payload: forLogs(i.payload),
        lastError: forLogsText(i.lastError),
        reviewCode: i.reviewCode,
      })),
    )
  }

  /** Poll the lightweight inbound-transfers endpoint (cashier-scoped to the
   *  caller's outlet). Caches the list locally; on failure keeps the last cache
   *  (offline-tolerant). Does NOT raise the wall or block sales. */
  async pollInbound(): Promise<void> {
    if (!ONLINE()) return
    try {
      const r = await this.api.request<{ data: Transfer[] }>('GET', '/api/v1/sync/inbound-transfers')
      this.setReachable(true)
      writeJSON(this.kv, INBOUND_KEY, r.data ?? [])
    } catch {
      this.setReachable(false) // keep the cached list
    }
  }

  /** Last-cached inbound in-transit transfers for this outlet (offline-tolerant). */
  getInboundTransfers(): Transfer[] {
    return readJSON<Transfer[]>(this.kv, INBOUND_KEY, [])
  }

  /** Wire connectivity + periodic version polling. Returns a disposer. */
  start(pollMs = 20000, opts: { flushOnly?: boolean } = {}): () => void {
    this.disposed = false
    this.settling.revive()
    this.outbox.revive()
    this.autoCheckIn = !opts.flushOnly
    // flushOnly (a terminal/outlet mismatch): drain the existing queue and keep reachability
    // fresh, but never read outlet data (no inbound-transfer cache) for an outlet that is not
    // the terminal's.
    const inbound = () => { if (!opts.flushOnly) void this.pollInbound() }
    const onOnline = () => {
      this.resetBackoff()
      void this.flush()
      void this.checkVersion()
      inbound()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
    }
    inbound()
    if (opts.flushOnly) {
      // Nothing else (no resync) kicks the queue off here: drain it right away.
      void this.flush()
      void this.checkVersion()
    }
    const timer = setInterval(() => {
      void this.flush()
      void this.checkVersion()
      inbound()
      if (this.autoCheckIn) void this.checkInReviews()
    }, pollMs)
    const stop = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
      }
      clearInterval(timer)
      this.autoCheckIn = false
    }
    this.stopTimers = stop
    return stop
  }
}
