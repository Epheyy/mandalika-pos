// @mandalika/sync — POS offline store + outbox + sync engine.
// Phase C implements this (Capacitor SQLite local store, durable outbox keyed
// by device_id:order_uuid, ordered flush to POST /sync/batch, server
// reconciliation, content_version sync wall). Placeholder for Phase B scaffold.

export const SYNC_PLACEHOLDER = true as const
