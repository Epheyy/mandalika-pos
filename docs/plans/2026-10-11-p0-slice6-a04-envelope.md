# P0 slice 6 — A04a capture-time envelope + fixed terminal (plan, 2026-10-11)

Opus planner, read-only, `prod-hardening` @ 3953514. Core slice needs **no migration**.

## Findings (correct HANDOFF where noted)
- Attribution is flush-time: `sync.go:275-282` (order), refund `:329`, shift_open `:343-344`, shift_close `:359`,
  cash_flow `:378-380`, transfer receiveScope `:444`, receipt scope `:230`; `c` from `writes.go:1311-1314` via
  X-Outlet-Id (`middleware.go:28-38`, admin may switch). `commitOutbox` (`engine.ts:275-288`) stamps deviceId +
  clientCreatedAt only. No shift-ownership check (`order.go:432`, `shift.go:189`).
- **Correction:** server already rejects a *sequential* second shift_open (`shift.go:40-48` → Conflict→review);
  only concurrent opens race (count-then-insert, no lock). POS duplicate source = auto-open after an offline
  boot (`useShift.ts:80-88` with `currentShift` null from the failed fetch `:40-53`).
- Offline-opened shifts have no id until sync → orders carry `shiftId: null` (`CashierScreen.tsx:665`) and are
  excluded from shift totals (`shift.go:127`).
- Admin-outlet/Offline root: `authStore.outletId = user.outletId` (null for admin, `auth.tsx:55,69,84`);
  `/sync/version` lacks the outlet check (`writes.go:1268-1276`) → `Version('')` 500 → `checkVersion` treats any
  error as unreachable (`engine.ts:252-256`). OutletSwitcher offered to managers (`OutletSwitcher.tsx:32`) but
  only admins may switch (`middleware.go:31`). `user_outlets` and `devices` tables unused.
- New wire fields are safe: batch/shift decoders ignore unread keys. `actor_mismatch` already maps to POS review.

## Design
1. POS `OutboxItem.envelope` `{v:1, outletId, userId, deviceId, capturedAt, shiftId?, appVersion?}` stamped in
   `commitOutbox` from an `actor()` provider (null → enqueue rejects), persisted via `Outbox.add`→`setDurable`,
   sent as a sibling of `payload` (A11 fingerprint unchanged). Never backfill old items.
2. Server `attribute()` in `internal/sync`, first in `processOneWithCommands`; result replaces `c` everywhere
   (version stays on header outlet). Rules: v==1; userId==token user; deviceId==idempotency-key prefix;
   outlet: admin any existing outlet, manager/cashier only DB `users.outlet_id`; shift: other outlet →
   actor_mismatch, closed → accept + log late, missing → accept with NULL + warn. Missing envelope: legacy path
   + warn until `SYNC_LEGACY_ENVELOPE_UNTIL` (unset = accept), then actor_mismatch. Concurrent opens: outlet row
   `FOR UPDATE` before the count.
3. Fixed terminal: `terminalBinding.ts` durable `mandalika.pos.terminal`; `authStore.outletId` always from the
   binding; login guard (different user with queue/review > 0 → refused; parse failure counts as not empty);
   remove OutletSwitcher + logout; guarded "Lepas terminal" in Settings (queue/review 0, online).
4. Shift header: persist last-known shift per outlet, refetch on mount/reachable/shift ack, overlay pending
   shift ops, auto-open only after a successful fetch this session; offline open per Q1.
5. `/sync/version` with no outlet → 403; `checkVersion` 4xx = reachable + account problem.
6. OpenAPI: `envelope $ref SyncEnvelope` (optional, not nullable), add missing `transfer_receive` enum, regen.

## Tests
PG gate **EV** `TestCaptureEnvelopePostgres` (port 56448): audit A04 scenario (capture outlet X, flush with
header Y → lands at X); cross-user → actor_mismatch with zero effects; reassigned cashier; unknown outlet;
device prefix; shift cases; every op type attributed to envelope outlet; legacy before/after cutoff;
concurrent shift_open (fails on today's code). Go unit + engine/POS tests listed in the session plan.

## Rollout
Backend first (accepts both, tablets at 0 pending), APK 1.5 (versionCode 6), cutoff = fleet on 1.5 + 14 days
(1.1–1.4 tablets would review/park every item after it). Rollback to 00088-qoh safe (envelope ignored).
Hidden-revision deploy `--tag ev6 --set-env-vars SYNC_LEGACY_ENVELOPE_UNTIL=<date>` + zero-residue smoke.

## Tasks
T1 version 403 · T2 OpenAPI+regen · T3 batch decoder · T4 attribute + config + shift lock (EV failing first)
· T5 engine/outbox · T6 binding/auth/picker/guard · T7 remove switcher+logout · T8 Lepas terminal · T9 useShift
· T10 (if Q5) migration 0047 operator/refunder · T11 HANDOFF. Opus reviews T1–T10.

## Owner questions
Q1 offline Buka Shift (block vs client ids) · Q2 admin/outlet-less accounts on tablets · Q3 different account
with queued items · Q4 late sale for closed shift (keep, no recompute — recommended) · Q5 operator/refunder now
(migration 0047) or later.
