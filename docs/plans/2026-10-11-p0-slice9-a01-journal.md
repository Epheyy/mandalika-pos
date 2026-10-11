# P0 slice 9 (A01b) — SQLite outbox journal with verified, resumable migration (plan, 2026-10-11)

Opus planner (read-only) against `prod-hardening` @ `d4b3986` (backend live `00092-naf`, APK 1.6 / versionCode 7).
**Client-only: no backend change, no DB migration** (optional T10 backend OTA hardening). **APK required** (native plugin): 1.7 / versionCode 8.
Main-session spot-check: `@capacitor/preferences@8.0.1` `Preferences.java:43` uses `editor.apply()` (confirmed).

## 0. Facts (current code)

- KV: sync `get/set/remove` + `setDurable/removeDurable` (`packages/sync/src/storage.ts:5-14`); web `LocalStorageKV` (`:16-46`); native `CapacitorPreferencesKV` hydrates all `mandalika.*` into a mirror, lifts leftover localStorage keys (`:84-133`, `:97-111`); `setDurable` awaits `Preferences.set` then updates the mirror (`:125-128`); `initSecureKV()` (`:150-166`); hydrate failure → `BootError` (`main.tsx:15-24`).
- "Awaited writes" (A01a, APK 1.1+) = value reached the SharedPreferences in-memory map and an async disk write was queued (`apply()`), **not** on disk. Survives WebView renderer crash and normal backgrounding (QueuedWork drain on stop — AOSP reading, not device-verified). **Not** kill -9 / native crash / OOM / power loss in the window. SharedPreferences rewrites the whole `CapacitorStorage.xml` (incl. big snapshot) per apply; atomic `.bak` swap → "lose last writes", not corruption; window grows with file size.
- Outbox rewrites the whole array per change: `commit()` → `kv.setDurable(OUTBOX_KEY, JSON.stringify(next))` (`outbox.ts:237-243`); serialized `run` chain (`:227-234`); `add` fails loudly (`:263-285`), `settle/prune` best-effort (`:247-259,333-420`). O(n) bytes per change (500-sale backlog ≈ 1–2.5 MB/write). UI success only after `await engine.enqueue` (`CashierScreen.tsx:649`, refund `:789`, receive `:802`, customer `:463`).
- Corruption: non-array → raw to `mandalika.outbox.corrupt.<ts>` + durable marker + empty queue + banner (`outbox.ts:178-203`, `SyncProvider.tsx:125-138`); marker never cleared.
- `'sent'` declared, never written (`outbox.ts:25`) → in-flight items stay `pending`, resent same key (A11 → duplicate → ack).

| Key | Today | This slice |
|---|---|---|
| `mandalika.pos.outbox` | Preferences durable | **→ journal** |
| `mandalika.pos.syncedRefunds` (`syncedRefunds.ts:4,31`) | `kv.set` fire-and-forget | **→ journal**, durable before prune (T7) |
| `mandalika.pos.deviceId` (`device.ts:22`) / `orderSeq` (`orderRef.ts:36-37`) | Preferences | stay (Q6) |
| `mandalika.pos.terminal` (`terminalBinding.ts:47-52`) | durable | stay |
| refresh token / user (`authBoot.ts:6-8`) | Preferences | stay (secrets out of journal) |
| snapshot, contentVersion, pendingCredits, inbound, shift cache, `mandalika.cache.*` | Preferences/localStorage | stay (caches) |

- `OUTBOX_KEY` consumers: `outbox.ts:178`; **`terminalBinding.ts:134-145` `readQueueState(kv)`** (login guard `auth.tsx:149`, release guard `auth.tsx:181`); browser gate `tests/browser/pos-scenarios.ts:125-196`; HANDOFF CDP helper.
- Fingerprint (`backend/internal/service/receipts.go:49-64`): UseNumber + re-marshal; key order irrelevant, number text matters. Rule: store each item as exact `JSON.stringify(item)`; never rewrite with SQLite JSON functions or split into columns.
- Platform: Capacitor 8.5.3; minSdk 24, target 36; versionCode 7/"1.6"; no SQLite package; only `MainActivity.java` native; `allowBackup="true"`.
- OTA: Capgo `resetWhenUpdate` default true; but `backend/internal/ota/decide.go:24-33` offers any *different* version (incl. older); bucket empty.

## 1. Audit ask (A01, `AUDIT_REPORT.md:136-146`)

Transactional SQLite journal; awaited commit failing explicitly before success; non-destructive resumable verified migration; secrets separate; don't relabel Preferences as transactional. Acceptance: kill before/after commit, before ack, during migration; full disk; malformed data — no successful capture vanishes, no silent empty ledger. → Outbox must move; synced-refund memory should; caches/secrets stay. One row per item in SQLite (its WAL/rollback journal is the journal).

## 2. Design

### 2.1 Seam (engine logic unchanged)
`packages/sync/src/outboxStore.ts`:
```ts
export type OutboxLoad = { kind: 'ok'; items: OutboxItem[] } | { kind: 'corrupt'; raw: string }
export interface OutboxStore {
  load(): OutboxLoad
  commit(prev: readonly OutboxItem[], next: readonly OutboxItem[]): Promise<void>
  readonly kv: KV
}
```
- `KVOutboxStore(kv)`: today's behaviour byte-for-byte; default for web/dev, browser gate, vitest, iOS, plugin-less shells (incl. 1.7 bundle OTA'd onto a 1.6 APK).
- `JournalOutboxStore(plugin)`: process singleton with hydrated mirror `Map<key,{item,json}>`; `load()` = mirror by seq; `commit(prev,next)` diffs against caller's **prev** (upsert changed JSON, delete keys in prev not next), one `apply` transaction, patch mirror after resolve. Stale instance can't delete rows it never saw. dispose/revive guard kept (`outbox.ts:175,205-213,237-241`).
- `Outbox` ctor accepts `KV | OutboxStore`; corrupt branch reads `store.load()`; commit → `store.commit(this.items,next)`. Existing `new Outbox(kv)` / `new SyncEngine(` call sites compile unchanged.
- Wiring: `SyncEngineOptions.outboxStore?` (`engine.ts:146-150,212`); `getOutboxStore()` in `storage.ts`; `SyncProvider.tsx:112-114`; `readQueueState`/`checkLoginAllowed` (`terminalBinding.ts:134,172`) accept `KV | OutboxStore`; `auth.tsx:149,181` pass `getOutboxStore()`.

### 2.2 Native journal (rec Q5: in-repo plugin)
`OutboxJournalPlugin.java` (~200 lines, Android built-in `android.database.sqlite`, no new deps) + `registerPlugin` in `MainActivity.onCreate` before super; TS `registerPlugin('OutboxJournal')` in `packages/sync/src/journalPlugin.ts`.
DB `mandalika_journal.db`, `user_version=1`:
```sql
CREATE TABLE outbox (idempotency_key TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, item_json TEXT NOT NULL);
CREATE TABLE meta   (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```
Methods: `open()` → `{quickCheck, journalMode, synchronous, userVersion}` (sets `synchronous=FULL`, returns effective values; JS refuses the store unless FULL); `readAll()` → `{rows:[{key,seq,json}], meta}`; `apply({upserts, deletes, meta, replaceAll})` in one transaction on Capacitor's plugin thread. FULL because WAL+NORMAL doesn't survive power loss. Implementer picks WAL vs DELETE after checking the setting sticks; `open()` reports it.
Alternative `@capacitor-community/sqlite@8.1.1`: runtime deps jeep-sqlite/sql.js/@stencil/core/localforage/jszip (lockfile churn, dependency-security exposure); possibly SQLCipher (unverified).

### 2.3 Synced refunds
Journal store exposes a meta-backed KV facade (whitelist `mandalika.pos.syncedRefunds`); `SyncedRefunds.addMany(ids): Promise<void>` via `setDurable`; `engine.ts:719-767`: collect refund ids → `await settle` → `await addMany` → `prune()` (skip prune if addMany fails); at engine construction fold acked refund rows still in the journal into synced refunds (self-heal).

## 3. Migration (`packages/sync/src/journalBoot.ts` `initJournal()`)
Called in `main.tsx` right after `initSecureKV()` inside the same BootError try; boot blocks → no sale mid-migration.
- Sentinel replaces `mandalika.pos.outbox` after verify: `{"movedTo":"journal","v":1,"at":…,"count":n,"sha256":…}` (non-array → old JS quarantines + banner; `readQueueState` readable:false → login/release locked; visible, never silent). Key never removed (stops hydrate lifting localStorage outbox). Verbatim backup `mandalika.outbox.legacy.<ts>`.

P = plugin available; M = journal `meta.migration`; K = Preferences `OUTBOX_KEY`.

| P | open/quick_check | M | K | Action |
|---|---|---|---|---|
| no | – | – | array/null | KV store (today) |
| no | – | – | sentinel | **BootError** "antrean tersimpan di journal; versi aplikasi tidak cocok" |
| yes | fails | – | sentinel | **BootError** |
| yes | fails | – | array/null | Q1 |
| yes | ok | absent | null/well-formed array | copy → verify → backup → seal |
| yes | ok | absent | malformed array | no migrate: KV + banner + report (Q1) |
| yes | ok | absent | non-array | existing quarantine, then seal count 0 |
| yes | ok | verified | array, sha = source | crashed before seal: seal only |
| yes | ok | verified | array, sha differs | old JS wrote via OTA: merge missing keys (seq renumbered after max, order kept); differing keys keep journal row; seal |
| yes | ok | verified | sentinel | normal boot |
| yes | ok | absent/empty | sentinel | **BootError** "journal hilang" |

Steps: (1) copy: one `apply({replaceAll, upserts: JSON.stringify(item) rows, meta:{migration:'copied', source_sha256, source_count, syncedRefunds}})` — resume = redo. (2) verify via `readAll()`: count; per item `row.json === JSON.stringify(item)`, round-trip idempotent, payload stringify equal; sha256 (hash-wasm, already a dep) over seq-ordered JSON = source; syncedRefunds equal. Fail → M unset, K stays source, Q1. (3) `meta.migration='verified'`. (4) `setDurable(legacy backup)` then `setDurable(OUTBOX_KEY, sentinel)`; failure → BootError (retryable). (5) hydrate mirror; `getOutboxStore()` → journal.
New JS ignores a corruption marker whose quarantined raw is our sentinel. Parked/review, acked-not-pruned, retryableFailures, envelope, transfer PIN copied verbatim in `item_json`. Precondition: tablets at 0 pending (still built/tested for non-empty).

## 4. Native vs OTA, rollback
APK required (Java class + registerPlugin); `build.gradle:24-25` → 8 / "1.7"; push before `android-release.yml`. Downgrade below versionCode needs uninstall (wipes data) → rollback = roll forward; 1.6 only via uninstall at 0 pending. Realistic regression path = old OTA bundle on 1.7 shell (decide.go): sentinel banner/lock + merge path; process: no OTA until T10. 1.7 bundle on 1.6 shell → KV path = 1.6 behaviour. Never deleted: legacy backup, quarantine copies, DB file. No backend rollback needed.

## 5. Tests (failing first)
A. `packages/sync` vitest: `testFixtures/fakeJournal.ts` (persisted Map, real tx semantics, crash injection `failAt: 'beforeCommit'|'afterCommit'|{nthApply}`, restart over same maps + controllableKV, open() failures/non-FULL).
- `outbox.store-parity.test.ts`: existing `outbox.durable.test.ts` scenarios under `describe.each([kv, journal])`; settle 100 = one apply; prune → deletes only; stale instance can't delete unseen rows; failed apply leaves mirror+rows; rejected add burns no seq.
- `journalBoot.test.ts`: every §3 row; crash at each step → identical set, no dup keys, sentinel + backup.
- Byte identity fixture: sale with 10.5 / 0.1+0.2 total, unicode, nested items; refund with display keys; parked (attempts 5, reviewCode); retryable-failed; acked-not-pruned; envelope ± shiftId; legacy no envelope; transfer_receive with PIN → per-item/payload stringify equal and Go-canonical fingerprint unchanged.
- `engine.journal.test.ts`: enqueue→restart→same item; refund ack → crash between settle and addMany → self-heal, refund not re-offered; addMany fails → no prune.
B. `apps/pos`: guards over journal with pending items while Preferences holds sentinel → refused; `initJournal` rejection → BootError.
C. Unchanged and green: all engine tests, `storage.durable.test.ts`, browser gate, `quality:ci`.
D. Java: no JVM test infra → Opus review + emulator; `open()` reports effective PRAGMAs.

## 6. Tasks
| # | Task | Reviewer |
|---|---|---|
| T1 | fake plugin + failing tests A/B | Opus |
| T2 | `OutboxStore` seam + `KVOutboxStore` (no behaviour change) | Opus |
| T3 | `JournalOutboxStore` (shared mirror, prev-diff, meta KV facade) | Opus |
| T4 | `initJournal()` table + copy/verify/seal + merge + sentinel-aware marker | Opus |
| T5 | wiring: engine options, SyncProvider, terminalBinding+auth guards, main.tsx | Opus |
| T6 | Java plugin + registerPlugin | Opus |
| T7 | synced refunds durable before prune + self-heal | Opus |
| T8 | version 1.7 / 8 | Haiku |
| T9 | HANDOFF CDP helper reads journal; outbox key = sentinel | Haiku |
| T10 | (Q4) decide.go strictly-newer semver + table test | Opus |
| T11 | push → APK 1.7 → emulator plan (owner go-ahead) | Opus |
Order T1→T2→T3→T4→T5→T7→T6→T8–T11. Implementer Sonnet. Size L (~200 Java, ~450 TS, ~900 tests; 2–3 sessions + 1 emulator session).

## 7. Ship + emulator plan
Preconditions: CI green; owner go-ahead (push, APK); fleet at 0 pending; no OTA published.
Release APK not debuggable → inspect via CDP; kill via `adb root` + kill -9 if google_apis image, else `am force-stop` (image type unverified).
1. Upgrade with non-empty queue (1.6 offline: sale, same-shift refund, cash_flow, parked item, transfer_receive if possible); dump Preferences outbox; install 1.7 offline; compare `OutboxJournal.readAll()` byte-for-byte; sentinel + legacy backup; same pending count; `open()` FULL.
2. Kill during migration at ~300/800/1500 ms after launch (fresh 1.6 each) → identical set, no dups.
3. Three offline sales, kill after each "berhasil" → 3 pending → online → each once on server, queue 0, rows pruned.
4. kill -9 within ~100 ms of Bayar ×10 → every shown receipt in journal, no half rows.
5. Refund memory survives kill. 6. Login/release guards with pending items. 7. (opt) disk full → visible error, nothing queued.
Not on device: OTA round-trip (unit only), power loss.

## 8. Risks
Fail-closed boot after seal = outage on that tablet (intended; quick_check + report); FULL fsync per sale (ms, unmeasured); CursorWindow irrelevant; snapshot still in SharedPreferences; Java not CI-tested; decide.go older-bundle (T10 + no-OTA precondition); legacy oddities copied verbatim; unobserved fleet migration → `/error-logs`.

## 9. Owner questions
1. Journal can't open/migrate on first 1.7 launch (before takeover): keep selling on old storage + warning (rec) vs stop selling. After takeover always stop.
2. Transfer-receive approver PIN stays in the queued item (plaintext, app sandbox): accept + follow-up one-time server approval (rec) vs strip on write.
3. Fleet at 0 pending before 1.7 install (owner rule 2026-10-10 — confirm).
4. Fix decide.go strictly-newer in this slice (T10, rec) + no OTA until then.
5. In-repo plugin on Android SQLite (rec) vs `@capacitor-community/sqlite`.
6. deviceId/orderSeq stay in Preferences; move with slice 10 (rec).
7. Keep `mandalika.outbox.legacy.*` backup until an admin clears it (rec).

Not verified: QueuedWork drain on stop; community plugin internals; effective `synchronous` with WAL on Android 24–36; emulator image type; fleet queue/snapshot sizes and fsync latency.

## Owner answers (2026-10-11)

1. Journal can't open/migrate before takeover -> **keep selling on old storage + warning + report, retry next launch**.
2. Transfer-receive PIN -> **accept for this slice**; follow-up: one-time server approval.
3. Fleet at 0 pending before 1.7 -> existing owner rule (2026-10-10); migration still built/tested for non-empty queues.
4. decide.go strictly-newer -> **fix in slice 9 (T10)**; no OTA published until then.
5. **In-repo plugin** on Android built-in SQLite.
6. deviceId/orderSeq stay in Preferences (default; slice 10).
7. Keep `mandalika.outbox.legacy.*` backup (default).

Execution split: Phase A = T1+T2+T3 (seam, journal store, parity tests); Phase B = T4+T5+T7 (boot migration, wiring, synced refunds); Phase C = T6+T8+T10 (Java plugin, version, decide.go); then T9/T11 ship + emulator.
