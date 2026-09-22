import type { components } from '@mandalika/api'
import { Outbox, type OutboxItem, type OutboxType } from './outbox'
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
  request<T>(method: string, path: string, body?: unknown): Promise<T>
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
  /** Fired once per item when it permanently dead-letters (server kept refusing
   *  past the retry cap) so the app can ship it to the server error log. */
  onDeadLetter?: (
    items: { type: OutboxType; idempotencyKey: string; payload: Record<string, unknown>; lastError?: string }[],
  ) => void
  /** Fired when a transfer_receive is terminally rejected by the server and rolled
   *  back (handled — NOT a failed sync the cashier must retry). */
  onReceiveRejected?: (msg: string) => void
  /** Fired when a transfer_receive is accepted by the server. Carries the full
   *  completed Transfer snapshot (with the freshly-assigned tandaTerimaNo and
   *  resolved receiver letterhead) so the UI can render the post-receive slip
   *  without a second roundtrip. */
  onReceiveAccepted?: (transfer: Transfer) => void
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

  /** Queue a mutation. Returns the idempotency key + generated order uuid. */
  enqueue(
    type: OutboxType,
    payload: Record<string, unknown>,
    orderUuid = uuid(),
  ): { idempotencyKey: string; orderUuid: string } {
    const idempotencyKey = this.key(orderUuid)
    this.outbox.add(type, idempotencyKey, {
      ...payload,
      orderUuid,
      deviceId: this.deviceId,
      clientCreatedAt: new Date().toISOString(),
    })
    this.events.onOutboxChange?.(this.outbox.count())
    void this.flush()
    return { idempotencyKey, orderUuid }
  }

  /** Enqueue a POS transfer receive and optimistically credit the counted qty.
   *  The PIN is validated by the UI before this; it rides in the payload for
   *  server re-validation and is dropped from the outbox when the item acks. */
  enqueueTransferReceive(input: {
    transferId: string
    items: { productId: string; variantSize: string; receivedQty: number }[]
    discrepancyReason?: string
    approverUserId: string
    pin: string
  }): { idempotencyKey: string } {
    const { idempotencyKey } = this.enqueue('transfer_receive', {
      transferId: input.transferId,
      items: input.items,
      discrepancyReason: input.discrepancyReason ?? '',
      approverUserId: input.approverUserId,
      pin: input.pin,
    })
    const lines: CreditLine[] = input.items
      .filter((it) => it.receivedQty > 0)
      .map((it) => ({ productId: it.productId, variantSize: it.variantSize, qty: it.receivedQty }))
    this.pending.add({ idempotencyKey, lines, ackVersion: null })
    this.recomputeCredited()
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

  /** Manual retry of parked items. */
  retryFailed(): void {
    this.outbox.retryDeadLettered()
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
   */
  async flush(): Promise<BatchResult | null> {
    if (this.flushing || !ONLINE()) return null
    const pending = this.outbox.pending()
    if (pending.length === 0) return null
    this.flushing = true
    try {
      const items = pending.map((i) => ({
        type: i.type,
        idempotencyKey: i.idempotencyKey,
        payload: i.payload,
      }))
      const typeByKey = new Map(pending.map((i) => [i.idempotencyKey, i.type]))
      const r = await this.api.request<{ data: BatchResult }>(
        'POST',
        '/api/v1/sync/batch',
        { items },
      )
      for (const res of r.data.results) {
        if (res.status === 'ok' || res.status === 'duplicate') {
          this.outbox.ack(res.idempotencyKey)
          this.pending.stampAck(res.idempotencyKey, r.data.version ?? 0)
          // SP4: surface the completed transfer to the UI so the tanda-terima
          // prompt can render. Only on a fresh 'ok' (a 'duplicate' replay means
          // the cashier already saw the prompt — skip the second modal).
          if (
            typeByKey.get(res.idempotencyKey) === 'transfer_receive' &&
            res.status === 'ok' &&
            res.transfer
          ) {
            this.events.onReceiveAccepted?.(res.transfer)
          }
        } else if (typeByKey.get(res.idempotencyKey) === 'transfer_receive') {
          // Deterministic rejection (e.g. already received elsewhere): roll back the
          // optimistic credit and resolve the item cleanly — not a failed sync.
          this.pending.remove(res.idempotencyKey)
          this.outbox.discard(res.idempotencyKey)
          this.events.onReceiveRejected?.('Penerimaan dibatalkan — transfer sudah diterima di tempat lain. Stok dikembalikan.')
        } else {
          if (this.events.debug) {
            // eslint-disable-next-line no-console
            console.error('[sync] item rejected', res.idempotencyKey, res.error)
          }
          this.outbox.fail(res.idempotencyKey, res.error ?? 'sync error')
        }
      }
      this.recomputeCredited()
      this.outbox.prune()
      this.events.onOutboxChange?.(this.outbox.count())
      this.events.onReconcile?.(r.data)
      // Server returns its version on every ack — refresh wall state.
      const local = this.snapshot.localVersion()
      this.wall = {
        raised: (r.data.version ?? 0) > local,
        localVersion: local,
        serverVersion: r.data.version ?? 0,
      }
      this.events.onWall?.(this.wall)
      return r.data
    } catch (err) {
      // Whole-batch failure (network blip OR a hard HTTP reject like 403
      // "no active outlet"). A transient blip should retry; a persistent
      // reject must not loop forever — count it against every in-flight item
      // so a poison batch eventually dead-letters instead of showing
      // "Menunggu sinkronisasi" indefinitely.
      const msg = err instanceof Error ? err.message : 'sync failed'
      if (this.events.debug) {
        // eslint-disable-next-line no-console
        console.error('[sync] batch failed', msg, err)
      }
      for (const i of pending) this.outbox.fail(i.idempotencyKey, msg)
      this.events.onOutboxChange?.(this.outbox.count())
      return null
    } finally {
      this.flushing = false
      this.emitDeadLetters()
    }
  }

  /** Surface newly dead-lettered items to the app (once each) for error reporting. */
  private emitDeadLetters(): void {
    if (!this.events.onDeadLetter) return
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
    const onOnline = () => {
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
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
      }
      clearInterval(timer)
    }
  }
}
