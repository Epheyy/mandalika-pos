// @mandalika/sync — POS offline core (plan §5, §5a).
// Durable outbox keyed by device_id:order_uuid, ordered idempotent flush to
// POST /sync/batch, read-only reference snapshot, content_version sync wall.

export { SyncEngine } from './engine'
export type { ApiLike, SyncEvents, WallState } from './engine'
export { Outbox } from './outbox'
export type { OutboxItem, OutboxType, OutboxStatus } from './outbox'
export { Snapshot } from './snapshot'
export { getDeviceId, uuid } from './device'
export { defaultKV, readJSON, writeJSON, getKV, initSecureKV } from './storage'
export type { KV } from './storage'
