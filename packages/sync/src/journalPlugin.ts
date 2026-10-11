// TS side of the native OutboxJournal plugin (A01b, plan §2.2): a SQLite database with
// `outbox(idempotency_key PK, seq UNIQUE, item_json)` and `meta(k PK, v)`. The Java side lands in
// Phase C; until then `registerPlugin` yields a proxy whose calls reject, and the store refuses it.
import { registerPlugin } from '@capacitor/core'

export interface JournalOpenResult {
  /** `PRAGMA quick_check` text; only the exact string 'ok' is acceptable. */
  quickCheck: string
  /** Effective `journal_mode` (informational: 'wal' or 'delete'). */
  journalMode: string
  /** Effective `PRAGMA synchronous` as SQLite reports it: 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA. */
  synchronous: number
  userVersion: number
}

export interface JournalRow {
  /** idempotency_key */
  key: string
  seq: number
  /** item_json: the exact `JSON.stringify(item)` text, never re-serialized by SQLite. */
  json: string
}

export interface JournalReadAllResult {
  /** Ordered by seq. */
  rows: JournalRow[]
  meta: Record<string, string>
}

export interface JournalApplyRequest {
  upserts: JournalRow[]
  /** idempotency keys to delete. */
  deletes: string[]
  /** meta rows to upsert. */
  meta?: Record<string, string>
  /** Delete every outbox row first (migration copy). */
  replaceAll?: boolean
}

export interface OutboxJournalPlugin {
  /** Opens the DB, sets `synchronous=FULL`, runs quick_check, reports the effective values. */
  open(): Promise<JournalOpenResult>
  readAll(): Promise<JournalReadAllResult>
  /** ONE transaction: all of replaceAll/upserts/deletes/meta, or nothing. Resolves only after COMMIT. */
  apply(request: JournalApplyRequest): Promise<void>
}

export const OutboxJournal = registerPlugin<OutboxJournalPlugin>('OutboxJournal')
