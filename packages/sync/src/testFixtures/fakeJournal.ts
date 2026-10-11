// In-memory fake of the native OutboxJournal plugin (plan §2.2) for vitest.
//
// What it models, because the store's safety argument depends on it:
//  - `persisted` is "the SQLite file": it survives {@link FakeJournal.restart}, which hands out a
//    NEW plugin over the SAME persisted maps (a process restart).
//  - `apply` is all-or-nothing: the batch is staged on copies and swapped in only if every
//    statement succeeds (NOT NULL json, UNIQUE seq), like a SQLite transaction.
//  - Durability gate: `ctl.mode` 'ok' | 'reject' | 'hold' (held applies commit only when released).
//  - Crash injection: `ctl.failAt` = 'beforeCommit' (rolls back, caller sees rejection),
//    'afterCommit' (commits, caller still sees rejection: the ambiguous crash), or
//    { nthApply, at? } (1-based apply count of this plugin instance; `at` defaults to beforeCommit).
//    One-shot: cleared once triggered.
//  - `open()` failure modes via `ctl.open` (quick_check text, synchronous level) and `ctl.openError`.
import type {
  JournalApplyRequest,
  JournalOpenResult,
  JournalReadAllResult,
  JournalRow,
  OutboxJournalPlugin,
} from '../journalPlugin'

export type FakeJournalFailAt =
  | 'beforeCommit'
  | 'afterCommit'
  | { nthApply: number; at?: 'beforeCommit' | 'afterCommit' }

export interface FakeJournalPersisted {
  rows: Map<string, { seq: number; json: string }>
  meta: Map<string, string>
}

export interface HeldApply {
  request: JournalApplyRequest
  resolve(): void
  reject(err?: Error): void
}

export interface FakeJournal {
  plugin: OutboxJournalPlugin
  persisted: FakeJournalPersisted
  ctl: {
    mode: 'ok' | 'reject' | 'hold'
    failAt: FakeJournalFailAt | undefined
    held: HeldApply[]
    /** What `open()` reports. Defaults: quick_check ok, WAL, synchronous FULL (2), v1. */
    open: JournalOpenResult
    /** When set, `open()` rejects with it. */
    openError: Error | undefined
    /** Every apply attempted, in issue order (deep copies), including failed ones. */
    applies: JournalApplyRequest[]
    /** Number of open() calls. */
    opens: number
  }
  /** Successfully committed applies only. */
  committed(): number
  /** A new plugin (fresh ctl and counters) over the same persisted maps. */
  restart(): FakeJournal
}

const SYNCHRONOUS_FULL = 2

const clone = (r: JournalApplyRequest): JournalApplyRequest => ({
  upserts: r.upserts.map((u) => ({ ...u })),
  deletes: [...r.deletes],
  meta: r.meta ? { ...r.meta } : undefined,
  replaceAll: r.replaceAll,
})

export function createFakeJournal(persisted?: FakeJournalPersisted): FakeJournal {
  const state: FakeJournalPersisted = persisted ?? { rows: new Map(), meta: new Map() }
  let commits = 0
  let applyCount = 0

  const ctl: FakeJournal['ctl'] = {
    mode: 'ok',
    failAt: undefined,
    held: [],
    open: { quickCheck: 'ok', journalMode: 'wal', synchronous: SYNCHRONOUS_FULL, userVersion: 1 },
    openError: undefined,
    applies: [],
    opens: 0,
  }

  // The transaction body: stage on copies, validate, swap in. Throws => nothing changed.
  function commitTx(req: JournalApplyRequest): void {
    const rows = new Map(state.rows)
    const meta = new Map(state.meta)
    if (req.replaceAll) rows.clear()
    for (const u of req.upserts) {
      if (typeof u.key !== 'string' || typeof u.json !== 'string' || !Number.isInteger(u.seq)) {
        throw new Error('NOT NULL constraint failed (synthetic)')
      }
      rows.set(u.key, { seq: u.seq, json: u.json })
    }
    for (const k of req.deletes) rows.delete(k)
    const seqs = new Set<number>()
    for (const r of rows.values()) {
      if (seqs.has(r.seq)) throw new Error('UNIQUE constraint failed: outbox.seq (synthetic)')
      seqs.add(r.seq)
    }
    for (const [k, v] of Object.entries(req.meta ?? {})) {
      if (typeof v !== 'string') throw new Error('NOT NULL constraint failed: meta.v (synthetic)')
      meta.set(k, v)
    }
    state.rows = rows
    state.meta = meta
    commits += 1
  }

  const plugin: OutboxJournalPlugin = {
    async open() {
      ctl.opens += 1
      if (ctl.openError) throw ctl.openError
      return { ...ctl.open }
    },
    async readAll(): Promise<JournalReadAllResult> {
      const rows: JournalRow[] = [...state.rows.entries()]
        .map(([key, r]) => ({ key, seq: r.seq, json: r.json }))
        .sort((a, b) => a.seq - b.seq)
      return { rows, meta: Object.fromEntries(state.meta) }
    },
    apply(request: JournalApplyRequest): Promise<void> {
      applyCount += 1
      const nth = applyCount
      const snapshot = clone(request)
      ctl.applies.push(snapshot)

      let crash: 'beforeCommit' | 'afterCommit' | undefined
      const f = ctl.failAt
      if (f === 'beforeCommit' || f === 'afterCommit') crash = f
      else if (f && f.nthApply === nth) crash = f.at ?? 'beforeCommit'
      if (crash) ctl.failAt = undefined

      const run = (): void => {
        if (crash === 'beforeCommit') throw new Error('crash before commit (synthetic)')
        commitTx(snapshot)
        if (crash === 'afterCommit') throw new Error('crash after commit (synthetic)')
      }

      if (ctl.mode === 'reject') return Promise.reject(new Error('disk full (synthetic)'))
      if (ctl.mode === 'ok') {
        try {
          run()
          return Promise.resolve()
        } catch (err) {
          return Promise.reject(err)
        }
      }
      return new Promise<void>((resolve, reject) => {
        ctl.held.push({
          request: snapshot,
          resolve: () => {
            try {
              run()
              resolve()
            } catch (err) {
              reject(err)
            }
          },
          reject: (err = new Error('apply failed (synthetic)')) => reject(err),
        })
      })
    },
  }

  return {
    plugin,
    persisted: state,
    ctl,
    committed: () => commits,
    restart: () => createFakeJournal(state),
  }
}

/** The persisted outbox rows as items, in seq order (what a cold reader of the file would see). */
export function persistedItems(p: FakeJournalPersisted): unknown[] {
  return [...p.rows.values()].sort((a, b) => a.seq - b.seq).map((r) => JSON.parse(r.json))
}
