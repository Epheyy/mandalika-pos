// @mandalika/sync — POS offline core (plan §5, §5a).
// Durable outbox keyed by device_id:order_uuid, ordered idempotent flush to
// POST /sync/batch, read-only reference snapshot, content_version sync wall.

export { SyncEngine, RECEIVE_CONFLICT_CODES, BATCH_TIMEOUT_MS, BACKOFF_BASE_MS, BACKOFF_CAP_MS, ACCOUNT_PROBLEM_MESSAGE, ENVELOPE_REFUSED_MESSAGE } from './engine'
export type { ApiLike, SyncEvents, WallState, ActorContext, ActorProvider, SyncEngineOptions, PendingShiftOp } from './engine'
export { Outbox } from './outbox'
export type { OutboxItem, OutboxEnvelope, OutboxType, OutboxStatus, OutboxCorruption, ReviewItem } from './outbox'
export { Snapshot } from './snapshot'
export { getDeviceId, uuid } from './device'
export { defaultKV, readJSON, writeJSON, getKV, initSecureKV } from './storage'
export type { KV } from './storage'
export { PendingCredits, applyCredits, retireByVersion } from './pendingCredits'
export type { PendingCredit, CreditLine } from './pendingCredits'
export { verifyPin } from './pin'
export { canAttempt, recordFailure, reset as resetLockout, MAX_PIN_ATTEMPTS, LOCKOUT_MS } from './lockout'
export type { Lockout } from './lockout'
