# Head-office review resolve screen — design

Status: design approved in chat 2026-10-12 (owner), spec awaiting owner review.
Next step after approval: implementation plan (`docs/plans/2026-10-12-review-resolve-plan.md`).

## 1. Problem

A sync item the server refuses for good (a denied refund, an item queued by another account, a
competing transfer receipt, a rejected sale, …) is parked on the tablet as a **review item**
(`Outbox.reviewItems()`: `status: 'failed'`, `attempts >= MAX_ATTEMPTS`, optional
`reviewCode`/`reviewReason`). Today:

- the item exists **only on that tablet**. The server stores nothing for a refused item
  (`backend/internal/sync/sync.go:326`: "A refused item has no effect and stores no receipt");
  `onDeadLetter` ships a one-off line to the error log, which has no state and no key;
- nothing can clear it. The cashier's only action is "Coba lagi" (`engine.retryFailed`, own
  items only), which re-sends the same item.

Owner decision 2026-10-10 still stands: a denied/refused item is never deleted silently. The open
question "who resolves" is now answered: **head office**.

## 2. Goal and success criteria

Head office sees every review item from every tablet, fixes what needs fixing by hand elsewhere
(e.g. a manual refund in the backoffice), and marks the item handled with a note. The tablet then
removes it.

Success:
1. A review item parked on a tablet appears in the backoffice within seconds of the tablet being
   online (or at most 5 minutes later if no new item triggered a check-in).
2. Resolving it with a note removes it from that tablet at its next check-in, with a toast.
3. Nothing in this feature can apply, re-apply or delete a sale, refund, shift, cash flow, customer
   or transfer on the server; stock and money code paths are untouched.
4. The tablet never removes an item that is pending, re-queued, or not in review state.
5. The server row (who resolved, when, note) is kept as the audit record; rows are never deleted.

## 3. Decisions (owner, 2026-10-12)

| Topic | Decision |
|---|---|
| What head office can do | **See + mark handled** (option A). No "approve and apply". |
| Tablet after resolve | **Remove the item** from the queue. Record stays on the server. |
| Who can resolve | New permission `resolve_sync_review`; admins have it via the existing admin bypass. |
| Mechanism | Approach 1: separate check-in endpoint, outside `/sync/batch`. |
| Rollout | Ships in APK 1.8 (= 1.7 + this). The 1.7 fleet rollout is held for 1.8. |
| Related | Refresh-token TTL → 30 days (`JWT_REFRESH_TTL_HOURS=720`) on this backend deploy. Debug flag stays on until go-live. |

## 4. Design

### 4.1 Data (migration `0048_sync_review_items.sql`)

```sql
CREATE TABLE IF NOT EXISTS sync_review_items (
  idempotency_key    text PRIMARY KEY,          -- the outbox key, `${deviceId}:${uuid}`
  outlet_id          uuid NOT NULL REFERENCES outlets(id),  -- reporting outlet, from the caller's auth scope
  captured_outlet_id uuid,                      -- envelope.outletId at capture, informational only
  op_type            text NOT NULL,             -- one of OutboxType
  review_code        text,                      -- NULL = parked by old attempt counting
  review_reason      text,
  last_error         text,
  owner_user_id      uuid,                      -- envelope.userId, when present
  payload            jsonb NOT NULL,            -- redacted snapshot (no `pin`), size-capped
  client_created_at  timestamptz NOT NULL,      -- tablet clock
  first_reported_at  timestamptz NOT NULL DEFAULT now(),
  last_reported_at   timestamptz NOT NULL DEFAULT now(),
  reported_by        uuid NOT NULL,             -- account that sent the check-in
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text,
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK ((resolved_at IS NULL) = (resolution_note IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_sync_review_items_open
  ON sync_review_items (outlet_id, client_created_at) WHERE resolved_at IS NULL;
```

Exact column types/foreign keys follow the existing migrations' conventions (checked in the plan).
Rows are never deleted. The resolution columns are the audit record (the backend has no separate
activity-log table).

### 4.2 Permission

New string `resolve_sync_review`. Permissions are free strings on the user
(`auth.HasPermission`, admin role bypasses), so no data migration. Add it to
`packages/types` `UserPermission` and to the backoffice `PermissionPicker`
("Tinjauan Sinkron — Melihat dan menyelesaikan item sinkron yang ditolak tablet").

### 4.3 Tablet endpoint — `POST /sync/review-items`

- Auth: any authenticated POS account. Outlet = the caller's resolved outlet scope (terminal
  outlet), never a value from the body. Global `api` rate-limit bucket.
- Body: `{ items: ReviewReport[] }`, 1–200 items. `ReviewReport` = `idempotencyKey`, `type`,
  `reviewCode?`, `reviewReason?`, `lastError?`, `ownerUserId?`, `capturedOutletId?`,
  `clientCreatedAt`, `payload`.
- Validation: `type` ∈ OutboxType; key non-empty, ≤ 200 chars; text fields ≤ 1000 runes;
  `clientCreatedAt` parseable. Payload > 64 KB serialized is stored as
  `{"_truncated": true, "bytes": N}` instead of being refused. The server deletes any top-level
  `pin` key before storing (backstop; the tablet already strips it). Invalid individual items are
  skipped, not the whole request (the reply only lists resolved keys, so skipping is safe).
- Per item, in one transaction:
  - new key → INSERT;
  - existing key, **same `outlet_id`** → UPDATE `last_reported_at`, and `review_code`,
    `review_reason`, `last_error` if changed. Never touches outlet, payload, owner or resolution;
  - existing key, **different `outlet_id`** → ignored, never returned as resolved.
- Reply: `{ resolved: [{ idempotencyKey, resolvedAt, resolvedByName, note }] }` — only keys from
  this request, same outlet, with `resolved_at` set.
- Re-reporting a resolved key never reopens it.

### 4.4 Backoffice endpoints (all `RequirePermission("resolve_sync_review")`)

- `GET /sync-review-items?status=open|resolved&outletId=&reviewCode=&limit=&offset=` →
  `{ items, total, openCount }`. OFFSET pagination like the customer list. Each item includes
  outlet and captured-outlet names, owner name, resolver name, and `appliedOnServer` =
  `EXISTS (SELECT 1 FROM operation_receipts WHERE idempotency_key = …)` (true when the item was
  later applied, e.g. after "Coba lagi"). Not scoped to one outlet: head office sees all.
- `POST /sync-review-items/{key}/resolve` `{ note }` → note trimmed, 1–500 runes (same rule as
  refund reasons). `UPDATE … SET resolved_* WHERE resolved_at IS NULL`; if already resolved,
  return the existing resolution with 200 (idempotent). Unknown key → 404.
- OpenAPI updated; Go server and TS client types regenerated (`gen:check`).

### 4.5 Tablet behaviour (`packages/sync` engine + POS)

- **Check-in trigger:** inside the existing sync loop, after a flush, when online **and**
  `reviewItems().length > 0` **and** no successful check-in in the last 5 minutes. Also
  immediately when items enter review (the `onDeadLetter` path), bypassing the throttle once.
- **Payload sent:** every `reviewItems()` entry (incl. legacy no-code parks and items owned by
  other accounts), payload passed through the existing `redactPayload`, plus
  `capturedOutletId = envelope.outletId` when present.
- **Removal:** new outbox settle op `resolve_review`. Inside the single queue mutation it removes
  an item **only if** it is still parked (`status === 'failed' && attempts >= MAX_ATTEMPTS`) at
  that moment; anything else (pending, re-queued by "Coba lagi", acked, unknown key) is left
  untouched. Persisted through the slice 9 journal in one transaction. Never reuses the plain
  `discard` op.
- **Cashier UI:** review rows show "Dilaporkan ke kantor pusat" after a successful check-in
  (in-memory flag, not persisted). On removal: toast "N item diselesaikan oleh kantor pusat:
  {note}" (first note when N > 1) and a sync-log line per item.
- **Failure:** offline, 4xx/5xx, expired auth, 404 (older server) → skip silently until the next
  cycle. The queue is never modified on failure. No retry storm (the 5-minute throttle applies
  after a failed attempt too).
- **Downgrade:** an older web layer ignores all of this; removed items are already gone and
  nothing new is persisted on the tablet.

### 4.6 Backoffice screen

- Sidebar item **"Tinjauan Sinkron"** (between Pengguna and Pengaturan), visible with
  `resolve_sync_review` or admin. Red badge = `openCount`, refreshed every 60 s and after a
  resolve.
- Tabs **Terbuka (n)** / **Selesai**; filters outlet and reason; paginated.
- Row: created time (WIB, "menurut tablet"), outlet (+ "dilaporkan dari X" if the captured outlet
  differs), type (Penjualan / Refund / Buka shift / Tutup shift / Kas masuk-keluar / Pelanggan
  baru / Terima transfer), cashier, reason label:
  `forbidden` → "Ditolak: tidak berwenang / PIN salah"; `actor_mismatch` → "Dibuat oleh akun
  lain"; `competing_receipt` → "Transfer sudah diterima tablet lain"; `rejected`/`conflict` →
  "Ditolak server"; `batch_rejected` → "Kiriman ditolak"; none → "Gagal berulang (versi lama)";
  unknown code → "Ditolak ({code})". `last_reported_at` older than 3 days → "tablet belum
  terhubung sejak {tanggal}".
- Detail panel: per-type summary (refund: receipt, amount, items, reason; sale: receipt, total,
  items, payment; shift: cash amounts; transfer: transfer, items; others: key fields), server
  reason and last error, "Sudah masuk ke server" badge when `appliedOnServer`, raw payload
  (collapsible). Resolve form: required note 1–500, button "Tandai selesai", confirm text "Item
  akan dihapus dari tablet saat tablet terhubung berikutnya. Perbaikan (mis. refund manual)
  dilakukan terpisah."
- Selesai tab: resolver, time, note.
- Components split (screen / list / detail / resolve form), each ≲ 300 lines, following the
  Pelanggan screen pattern.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| Same item reported repeatedly | Idempotent upsert; resolved rows stay resolved. |
| Resolved, then cashier "Coba lagi" before check-in | Guarded removal skips it. If it applies, `appliedOnServer` shows it. If refused again under the same key, the earlier resolution covers it and the next check-in removes it. |
| Key already stored under another outlet | Ignored; never returned as resolved. |
| Tablet moved to another outlet with old items | Stored under the reporting outlet, displayed with the captured outlet. |
| Tablet reinstalled / never back online | Row stays open with the stale warning; head office can resolve; nothing to remove. |
| Oversized payload | Stored as truncated marker; item still visible. |
| `pin` in a payload | Stripped on the tablet (`stripSecrets` at park time, `redactPayload` at send) and again on the server. |
| Account without the permission | 403 from the API; sidebar item hidden. |

## 6. Testing

- **Backend:** Go unit tests (validation, caps, pin strip, reply shape) and PostgreSQL integration
  tests added to the mandatory PG gate: insert/update/idempotency, cross-outlet isolation,
  resolve twice, 403 without permission, `appliedOnServer`, resolved-not-reopened.
- **`packages/sync` vitest:** trigger + 5-minute throttle; removal never deletes pending,
  re-queued, acked or unknown items; failed check-in leaves the queue byte-identical; removal via
  the journal store; redaction.
- **POS vitest:** "Dilaporkan ke kantor pusat" label; toast text.
- **Backoffice:** Chromium browser-gate scenario list → detail → resolve (no vitest harness exists).
- **Live:** throwaway Neon e2e `cmd/reviewe2e` (zero residue) after the backend deploy; emulator:
  park a refund from an account without `process_refund` → appears in backoffice → resolve →
  disappears from the tablet with the toast.
- Gates: `corepack pnpm quality:ci`, `gen:check`, backend CI (`-race`, gofmt).
- **Opus review** of every diff touching the outbox/journal, OpenAPI + generated types, and
  permissions.

## 7. Rollout

1. Backend: migration 0048 + endpoints + `JWT_REFRESH_TTL_HOURS=720`. Deploy `--no-traffic --tag`,
   smoke the tag, then move traffic. Safe for existing APKs (they never call the endpoint).
2. Backoffice: auto-deploys on push to `prod-hardening`.
3. APK 1.8 (1.7 + tablet part): emulator verification, then the held fleet rollout (each tablet at
   0 pending first; review items are preserved across the upgrade).

## 8. Out of scope

- "Approve and apply" a refused item from head office.
- Quarantine action for corrupt journal rows (`quarantineCorruptRows`).
- Tracking when a tablet actually removed a resolved item.
- Deep links from a review item into the order screen (backoffice has no router).
