import type { components } from '@mandalika/api'
import { Outbox, type OutboxCorruption, type OutboxSettle, type OutboxItem, type OutboxType, type ReviewItem } from './outbox'
import { Snapshot } from './snapshot'
import { getDeviceId, uuid } from './device'
import { defaultKV, type KV, readJSON, writeJSON } from './storage'
import { PendingCredits, applyCredits, type CreditLine } from './pendingCredits'

const SYNC_LOG_KEY = 'mandalika.pos.synclog'
const INBOUND_KEY = 'mandalika.pos.inboundTransfers'

/** Strip sensitive fields (currently the receive PIN) from an outbox payload
 *  before it is surfaced to logs, error reports, or shareable blobs. */
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload && typeof payload === 'object' && 'pin' in payload) {
    const clone: Record<string, unknown> = { ...payload }
    delete clone.pin
    return clone
  }
  return payload
}

type Bundle = components['schemas']['SyncPullBundle']
type BatchResult = components['schemas']['SyncBatchResult']
type VersionInfo = components['schemas']['SyncVersion']
type Transfer = components['schemas']['Transfer']

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
  'key_conflict', 'busy', 'internal', 'actor_mismatch',
])

/** The whole /sync/batch request is aborted after this long so a hung connection
 *  cannot leave `flushing` stuck. */
export const BATCH_TIMEOUT_MS = 30_000
/** Backoff after a transient whole-batch failure: base * 2^n, capped, with jitter. */
export const BACKOFF_BASE_MS = 20_000
export const BACKOFF_CAP_MS = 5 * 60_000

type FailureKind = 'offline' | 'unauthorized' | 'transient' | 'rejected'
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
  if (status >= 400) return { kind: 'rejected', message }
  if (err instanceof TypeError) return { kind: 'offline', message }
  return { kind: 'transient', message } // unknown: never blame the item
}

const ONLINE = () => typeof navigator === 'undefined' || navigator.onLine

export class SyncEngine {
  readonly deviceId: string
  readonly outbox: Outbox
  readonly snapshot: Snapshot
  readonly pending: PendingCredits
  private creditedView: Bundle | null = null
  private flushing = false
  // idempotencyKeys already surfaced via onDeadLetter — emit each once.
  private reportedDead = new Set<string>()
  private reportedStuck = new Set<string>()
  // Transient whole-batch failures push this out (exponential backoff + jitter).
  private nextFlushAt = 0
  private backoffStep = 0
  private disposed = false
  private stopTimers: (() => void) | null = null
  private wall: WallState
  private reachable: boolean = ONLINE()

  private readonly kv: KV

  constructor(
    private api: ApiLike,
    private events: SyncEvents = {},
    kv: KV = defaultKV,
  ) {
    this.kv = kv
    this.deviceId = getDeviceId(kv)
    this.outbox = new Outbox(kv)
    this.snapshot = new Snapshot(kv)
    this.pending = new PendingCredits(kv)
    this.recomputeCredited()
    this.wall = { raised: false, localVersion: this.snapshot.localVersion(), serverVersion: this.snapshot.localVersion() }
  }

  /** Retire this engine (SyncProvider unmounted / replaced after logout): stop
   *  timers, ignore an in-flight flush's result, and make its outbox read-only so
   *  it can never overwrite what the next engine commits. `start()` revives it,
   *  because React StrictMode re-runs effects on the same instance in dev. */
  dispose(): void {
    this.disposed = true
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
    const r = await this.api.request<{ data: Bundle }>('GET', '/api/v1/sync/pull')
    this.setReachable(true)
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
        '/api/v1/sync/version',
      )
      this.setReachable(true)
      const server = r.data.version ?? 0
      const local = this.snapshot.localVersion()
      this.wall = {
        raised: server > local,
        localVersion: local,
        serverVersion: server,
      }
      this.events.onWall?.(this.wall)
    } catch {
      // The GET failed → the server is unreachable (navigator.onLine can falsely
      // report online on Android WebViews). Keep selling on last snapshot.
      this.setReachable(false)
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

  /** Durably commit a mutation without triggering a flush. Resolves only once
   *  the outbox write succeeded; rejects (no trace left) if it failed. */
  private async commitOutbox(
    type: OutboxType,
    payload: Record<string, unknown>,
    orderUuid: string,
  ): Promise<string> {
    const idempotencyKey = this.key(orderUuid)
    await this.outbox.add(type, idempotencyKey, {
      ...payload,
      orderUuid,
      deviceId: this.deviceId,
      clientCreatedAt: new Date().toISOString(),
    })
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

  /** SP-CRM-9c: sum unsynced order quantities per `${productId}|${variantSize}` so
   *  the POS can optimistically decrement displayed stock. Includes reward lines
   *  because they decrement stock server-side too. Dead-lettered items are excluded
   *  (outbox.pending() already filters them). */
  pendingStockDeltas(): Record<string, number> {
    const deltas: Record<string, number> = {}
    for (const item of this.outbox.pending()) {
      if (item.type !== 'order') continue
      const payload = item.payload as { items?: Array<{ productId?: string; variantSize?: string; quantity?: number }> }
      for (const line of payload.items ?? []) {
        if (!line.productId) continue
        const key = `${line.productId}|${line.variantSize ?? ''}`
        deltas[key] = (deltas[key] ?? 0) + (line.quantity ?? 0)
      }
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

  /** Items needing review: explicit server/client verdicts plus legacy attempt-count
   *  parks. Never auto-retried, never deleted. */
  reviewItems(): ReviewItem[] {
    return this.outbox.reviewItems()
  }

  private resetBackoff(): void {
    this.nextFlushAt = 0
    this.backoffStep = 0
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
    await this.outbox.retryDeadLettered()
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
      const log = readJSON<unknown[]>(this.kv, SYNC_LOG_KEY, [])
      for (const d of dead) {
        log.push({
          at: now,
          deviceId: this.deviceId,
          type: d.type,
          idempotencyKey: d.idempotencyKey,
          lastError: d.lastError,
          reviewCode: d.reviewCode,
          reviewReason: d.reviewReason,
          clientCreatedAt: d.clientCreatedAt,
          payload: redactPayload(d.payload),
        })
      }
      writeJSON(this.kv, SYNC_LOG_KEY, log.slice(-200)) // keep last 200
    }
    const redacted = dead.map((d) => ({ ...d, payload: redactPayload(d.payload) }))
    return JSON.stringify(redacted, null, 2)
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
    const pending = this.outbox.pending()
    if (pending.length === 0) return null
    this.flushing = true
    try {
      const typeByKey = new Map(pending.map((i) => [i.idempotencyKey, i.type]))
      let data: BatchResult
      try {
        data = await this.post(pending)
      } catch (err) {
        if (this.disposed) return null // replaced mid-flight: the live engine owns the queue
        return await this.onBatchFailure(err, pending, typeByKey)
      }
      if (this.disposed) return null
      await this.applyBatch(data, typeByKey)
      return data
    } finally {
      this.flushing = false
      this.emitDeadLetters()
      this.emitStuckRetrying()
    }
  }

  private async post(items: readonly OutboxItem[]): Promise<BatchResult> {
    const r = await this.api.request<{ data: BatchResult }>(
      'POST',
      '/api/v1/sync/batch',
      { items: items.map((i) => ({ type: i.type, idempotencyKey: i.idempotencyKey, payload: i.payload })) },
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
    while (rest.length) {
      const [it, ...tail] = rest
      try {
        const data = await this.post([it])
        if (this.disposed) return null
        await this.applyBatch(data, typeByKey)
        last = data
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

  /** offline / 401 / transient: nothing is held against the items. */
  private async settleNonRejected(failure: Failure, items: readonly OutboxItem[]): Promise<void> {
    if (failure.kind === 'offline') {
      this.setReachable(false)
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
    for (const res of data.results) {
      const type = typeByKey.get(res.idempotencyKey)
      if (res.status === 'ok' || res.status === 'duplicate') {
        updates.push({ key: res.idempotencyKey, op: 'ack' })
        this.pending.stampAck(res.idempotencyKey, data.version ?? 0)
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
    await this.outbox.settle(updates)
    this.recomputeCredited()
    await this.outbox.prune()
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
        payload: redactPayload(i.payload),
        lastError: i.lastError,
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
        payload: redactPayload(i.payload),
        lastError: i.lastError,
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
  start(pollMs = 20000): () => void {
    this.disposed = false
    this.outbox.revive()
    const onOnline = () => {
      this.resetBackoff()
      void this.flush()
      void this.checkVersion()
      void this.pollInbound()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
    }
    void this.pollInbound()
    const timer = setInterval(() => {
      void this.flush()
      void this.checkVersion()
      void this.pollInbound()
    }, pollMs)
    const stop = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
      }
      clearInterval(timer)
    }
    this.stopTimers = stop
    return stop
  }
}
