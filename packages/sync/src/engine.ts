import type { components } from '@mandalika/api'
import { Outbox, type OutboxType } from './outbox'
import { Snapshot } from './snapshot'
import { getDeviceId, uuid } from './device'
import { defaultKV, type KV } from './storage'

type Bundle = components['schemas']['SyncPullBundle']
type BatchResult = components['schemas']['SyncBatchResult']
type VersionInfo = components['schemas']['SyncVersion']

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
}

const ONLINE = () => typeof navigator === 'undefined' || navigator.onLine

export class SyncEngine {
  readonly deviceId: string
  readonly outbox: Outbox
  readonly snapshot: Snapshot
  private flushing = false
  private wall: WallState
  private reachable: boolean = ONLINE()

  constructor(
    private api: ApiLike,
    private events: SyncEvents = {},
    kv: KV = defaultKV,
  ) {
    this.deviceId = getDeviceId(kv)
    this.outbox = new Outbox(kv)
    this.snapshot = new Snapshot(kv)
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

  // ── Reference snapshot ──────────────────────────────────

  /** Initial/refresh pull when online; atomically swaps the local snapshot. */
  async resync(): Promise<void> {
    const r = await this.api.request<{ data: Bundle }>('GET', '/api/v1/sync/pull')
    this.setReachable(true)
    this.snapshot.replace(r.data)
    this.wall = {
      raised: false,
      localVersion: r.data.version ?? 0,
      serverVersion: r.data.version ?? 0,
    }
    this.events.onWall?.(this.wall)
  }

  getSnapshot(): Bundle {
    return this.snapshot.get()
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

  pendingCount(): number {
    return this.outbox.count()
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
      const r = await this.api.request<{ data: BatchResult }>(
        'POST',
        '/api/v1/sync/batch',
        { items },
      )
      for (const res of r.data.results) {
        if (res.status === 'ok' || res.status === 'duplicate') {
          this.outbox.ack(res.idempotencyKey)
        } else {
          // eslint-disable-next-line no-console
          console.error('[sync] item rejected', res.idempotencyKey, res.error)
          this.outbox.fail(res.idempotencyKey, res.error ?? 'sync error')
        }
      }
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
      // eslint-disable-next-line no-console
      console.error('[sync] batch failed', msg, err)
      for (const i of pending) this.outbox.fail(i.idempotencyKey, msg)
      this.events.onOutboxChange?.(this.outbox.count())
      return null
    } finally {
      this.flushing = false
    }
  }

  /** Wire connectivity + periodic version polling. Returns a disposer. */
  start(pollMs = 20000): () => void {
    const onOnline = () => {
      void this.flush()
      void this.checkVersion()
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
    }
    const timer = setInterval(() => {
      void this.flush()
      void this.checkVersion()
    }, pollMs)
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
      }
      clearInterval(timer)
    }
  }
}
