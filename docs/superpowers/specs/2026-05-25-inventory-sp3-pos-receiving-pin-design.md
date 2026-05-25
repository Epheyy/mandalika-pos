# Inventory Module — SP3: POS-Side Receiving + PIN Approval — Design

Date: 2026-05-25 · Branch: `prod-hardening`

## Module context (continuity)

The Inventory module = **warehouses + product transfers** for the multi-brand POS
template, decomposed into four sequenced sub-projects (each its own spec → plan →
build):

- **SP1 — Warehouse foundation** ✅ DONE & LIVE (backend rev 00021-d5c, migration
  0015): warehouses CRUD + `warehouse_variant_stock` + goods-in + adjust +
  location-polymorphic stock-count + `manage_inventory` perm.
- **SP2 — Transfers core (backoffice)** ✅ DONE & LIVE (backend rev 00023-tz9,
  migration 0016): draft → send → in-transit → receive → discrepancy; mesh
  polymorphic source/dest; cancel; `content_version` bump on outlet legs. Backoffice
  can already receive ANY transfer via the same receive API.
- **SP3 — POS-side receiving + PIN** *(this spec)*: in-transit transfers destined for
  an outlet sync to that outlet's POS; the receiver confirms on-device with real
  counted qty; a manager authorizes with a per-user PIN; fully offline-capable with
  optimistic stock credit + reconciliation.
- **SP4 — Transfer documents & sharing**: printable delivery note (thermal BLE print
  + in-device view) at send; PDF/image export + WhatsApp/OS-share.

**Module-wide locked decisions** (apply across SPs):
- Topology = **mesh** (any location ↔ any).
- Transfer flow = **two-step send → receive with in-transit**; **draft** before send.
- Warehouse modeling = **separate subsystem** (own tables; never POS-synced).
- Discrepancy = **receive actual qty, record the difference** with a reason.
- Approval = **authoritative PIN + selected roles** — realized here in SP3.
- Permission **`manage_inventory`** gates inventory ops in backoffice (admin implicit).

## SP3-specific decisions (locked this session)

1. **Approval model = per-user PIN, manager step-up.** The cashier (the only role
   that logs into the POS) performs the physical count; a user whose role is allowed
   to approve (a *manager step-up*) enters their **personal** PIN on the cashier's
   device to finalize. The completed receive is **attributed to that approver**.
2. **PIN validation = on-device (full offline) + server re-validation on flush.**
   Approving users' salted PIN hashes (**argon2id**) sync to the device so the PIN is
   checked locally with instant feedback and a failed-attempt **lockout**; the receive
   then enqueues fully offline. On flush the **server re-validates** the PIN + role +
   scope (defense-in-depth — a tampered device cannot push an unauthorized receive).
3. **Count mode = informed count.** The receive screen pre-fills each line with the
   admin's `sentQty`; the receiver edits only lines that physically differ. Any line
   where counted ≠ sent requires a discrepancy reason (reuses SP2 `ReceiveTransfer`
   semantics).
4. **Receive boundary = POS primary + backoffice override.** Outlet-destination
   transfers are normally received on that outlet's POS. The backoffice keeps an
   **admin-only "force receive"** for stuck cases (POS device lost/broken), recorded
   as a backoffice receive with no on-device count. Warehouse-destination transfers
   stay backoffice-only (no POS exists there).
5. **Approver gate = configurable, per-role, org-wide.** A backoffice setting lists
   roles with a "can approve receives" toggle each (e.g. `["admin","manager"]`); a
   user inherits approval rights from their role. (Not hardcoded; not per-user;
   not per-outlet.)
6. **PIN provisioning = admin assigns per user.** The admin sets/clears each
   approver's PIN on the Users screen. (Accepted trade-off: the admin knows the PINs;
   per-user attribution still records *which* approver authorized.)
7. **PIN-hash sync scope = outlet + admins.** Only approving-role users **assigned to
   this outlet**, plus **admins** (global / outlet-switchers), have their PIN hash
   synced to that outlet's device. Fewest hashes per device; a manager approves at
   their own outlet, admins anywhere.
8. **Received stock = optimistic local credit + reconciliation.** After an offline
   receive the credited qty is immediately sellable via a persisted pending-credit
   folded into the snapshot view; it is retired when the authoritative snapshot
   already contains it, and rolled back (with a cashier notice) if the receive is
   rejected. See "Optimistic credit & reconciliation".
9. **Receive is atomic.** The whole transfer is received in one action → `completed`
   (no partial/multi-session line receiving), matching SP2 `ReceiveTransfer`.

## Current-state facts (verified)

- **POS login is cashier-only** — `apps/pos/src/auth.tsx:20`,
  `ALLOWED_ROLES = new Set(['cashier'])`. A manager/admin is not normally signed in on
  the POS, which is *why* receiving uses a manager **step-up PIN** rather than a
  manager login.
- **No PIN / approval / step-up auth exists anywhere** in the codebase today — SP3
  builds it from scratch.
- **Transfers are NOT in the POS pull bundle.** `SyncPullBundle`
  (`packages/api/src/schema.d.ts:1755`) carries products/categories/customers/
  promotions/users/appSettings/loyaltySettings but no transfers. SP3 adds them.
- **The receive API already exists and is correct.** `ReceiveTransfer`
  (`backend/internal/write/transfer.go:270`) credits the dest with the actual
  `receivedQty` per line, sets `difference = received − sent`, requires a
  `discrepancyReason` when any line differs, completes the transfer, and bumps the
  dest outlet leg via `bumpVersionOutlets(ctx, tx, "products", []string{outletID})`
  (`transfer.go:335`). SP3 **reuses it unchanged** — the new work is the *gate* in
  front of it and the *surface* that calls it.
- **Offline mutation pattern is clean and idempotent.** `engine.enqueue(type,
  payload, orderUuid?)` (`packages/sync/src/engine.ts:138`) returns
  `{idempotencyKey: "${deviceId}:${orderUuid}", orderUuid}`, persists to the outbox,
  and flushes to `POST /api/v1/sync/batch`. Server returns `ok` / `duplicate` / error
  per item; items dead-letter after `MAX_ATTEMPTS = 5` (`outbox.ts:32`). Outbox types
  are a union in `outbox.ts:6` — SP3 adds `'transfer_receive'`.
- **Snapshot is read-only and replaced wholesale on resync** —
  `snapshot.replace(r.data)` (`engine.ts:86`); there is no local stock-delta ledger,
  and completed offline *sales* do not lower snapshot stock (in-memory cart reserve
  only). This is the constraint the optimistic-credit overlay is designed around.
- **Version/wall mechanism** — `checkVersion()` polls `/api/v1/sync/version`
  (`engine.ts:104`); `server > local` raises the wall; `flush()` and `resync()` both
  refresh wall state from the server version returned on the batch / pull
  (`engine.ts:243`, `engine.ts:87`). `onDeadLetter` (`engine.ts:38`) already fires
  once per permanently-rejected item — SP3 hooks it for rollback.
- **Inventory permission** — `manage_inventory` exists and gates the Gudang surface
  (`backend/.../server.go:131` `RequirePermission("manage_inventory")`). Admin is
  implicit.
- **Transfer read exists** — `read/repo.go:574-592` `Transfers(status, page, limit)`
  and `Transfer(id)` expose `transferNo`, `status`, `source`/`dest` (`{kind,id,name}`),
  `items[]` with `productName`, `variantSize`, `sku`, `sentQty`, `receivedQty`,
  `difference`. The POS bundle reuses this shape (filtered).
- Highest migration is **0016**; SP3 adds **0017**.

## Data model — new migration `0017_receive_pins.sql`

```sql
ALTER TABLE users ADD COLUMN receive_pin_hash text;          -- argon2id, NULL = no PIN
ALTER TABLE users ADD COLUMN receive_pin_set_at timestamptz; -- audit / "PIN set" UI state
```

- The **approver-role config** is org-wide and small; it is stored in the existing
  settings surface the POS already pulls as `appSettings` (candidate key
  `receiveApproverRoles: string[]`, default `["admin","manager"]`). Exact storage
  column/row is a plan detail; it must be: (a) editable in backoffice, (b) included in
  the POS bundle so the device knows nothing extra is needed beyond the approver list.
- No new transfer columns are required — `ReceiveTransfer` already records the
  receive. **Approver attribution** is added as one nullable column on `transfers`:

```sql
ALTER TABLE transfers ADD COLUMN received_by uuid REFERENCES users(id); -- approver
```

  Set server-side at receive (POS approver, or the admin on a backoffice override).
  A receive done via the backoffice override records the acting admin and is
  distinguishable by `received_via` (optional `text`, `'pos' | 'backoffice'`) — a
  plan-level nicety; minimum viable is `received_by` alone.

## Behavior / flow

```
                          ┌─ POS (destination outlet) ──────────────────────────────┐
in_transit (SP2 send) ───▶│ inbound list → receive screen (informed count)          │
                          │   → manager step-up PIN (on-device validate + lockout)   │
                          │   → enqueue transfer_receive  +  optimistic credit       │
                          └──────────────────────┬──────────────────────────────────┘
                                                 │ flush /sync/batch (online)
                                                 ▼
                          server re-validates PIN+role+scope → ReceiveTransfer →
                          credit dest actual qty + difference + bump version
                                                 │
                            ack(version) ──▶ resync ──▶ snapshot includes credit
                                                 │            └─ retire pending credit
                            reject ──────▶ dead-letter ──▶ rollback credit + notice

                          ┌─ Backoffice override (admin, stuck cases) ──────────────┐
in_transit ──────────────▶│ force-receive → same ReceiveTransfer (no on-device count)│
                          └─────────────────────────────────────────────────────────┘
```

- The transfer reaches `in_transit` exactly as in SP2 (admin sends from backoffice).
- For an **outlet** destination, the in-transit transfer now appears in that outlet's
  POS bundle. The cashier opens **Terima Transfer**, counts (informed), a manager
  steps up with their PIN, and the receive enqueues. Offline-first throughout.
- For a **warehouse** destination, nothing changes — backoffice receives it (SP2).

## Sync / pull-bundle additions

`SyncPullBundle` gains two fields (assembled per outlet in the backend `Pull`):

1. `transfers`: in-transit transfers where `dest_outlet_id = this outlet`. Reuses the
   SP2 transfer read shape (filtered to `status='in_transit'` + dest = this outlet) —
   `transferNo`, `source` (`{kind,name}`), `note`, `items[]` with `productId`,
   `variantSize`, `productName`, `sku`, `sentQty`.
2. `receiveApprovers`: `[{ userId, displayName, receivePinHash }]` — users whose role
   is in `receiveApproverRoles` **and** (assigned to this outlet **or** an admin),
   **and** who have a PIN set. Plus `receiveApproverRoles` itself (so the POS can show
   an appropriate empty-state if no approver has a PIN yet).

The existing `ReceiveTransfer` already bumps the dest outlet's `content_version`, so a
completed receive (from any device) propagates to all that outlet's POS devices via the
existing wall/resync — no new push channel needed.

## Optimistic credit & reconciliation

The snapshot is replaced wholesale on resync and holds no stock-delta ledger, so the
credit lives in a **separate persisted store** in `packages/sync` (survives restart and
`snapshot.replace`), and is **folded into the snapshot view** so every existing
stock-read site (ProductGrid, scan guard, cart max) sees it with no changes.

**Pending-credit record:**
```
{ idempotencyKey, lines: [{productId, variantSize, qty: COUNTED_qty}], ackVersion: number | null }
```
`qty` is the *counted* quantity (what the server will actually credit), so discrepancies
stay consistent.

**Apply:** a pure `applyCredits(snapshot, pendingCredits) → snapshot'` folds the deltas
onto per-variant stock. Called after every `snapshot.replace()` and on enqueue, so:
- on enqueue → goods immediately sellable;
- after each resync → still-pending credits are re-applied on top of the fresh
  authoritative snapshot (no flicker while the receive is in flight).

**Reconciliation** = retiring a pending credit at the exact moment the authoritative
snapshot already contains it, so it is counted exactly once. Three arms:

- **A. Success.** On flush, the receive acks (`ok`/`duplicate`); the server has applied
  it, credited dest stock, and bumped the version returned on the batch. Stamp the
  credit with `ackVersion = returned version`. The bump triggers a resync; the fresh
  snapshot now includes the +qty. On resync, drop every pending credit where
  `ackVersion ≤ snapshot.version` (now baked into authoritative data → stop applying it).
  *Prevents double-count:* between ack and resync the old snapshot lacks it, so we keep
  applying — correct; once `ackVersion ≤ snapshot.version` we stop — correct.
- **B. Rejection (dead-letter).** A permanently-rejected receive (e.g. the transfer was
  already received via the backoffice override, or server-side PIN re-validation failed)
  never credited server-side. Hook `onDeadLetter`: drop the pending credit (stock returns
  to real) and surface a **cashier notice** ("Penerimaan dibatalkan — transfer sudah
  diterima / PIN ditolak").
- **C. Never reconnects.** The credit stays applied — the intended offline behavior —
  until A or B eventually fires.

**Honest caveats (acknowledged, in scope to document, not to fix here):**
1. *Asymmetry with sales* — this overlay covers receive credits only; offline sales
   still do not decrement snapshot stock (pre-existing). Offline stock stays approximate.
2. *Override interaction* — optimistic credit can let a cashier sell goods the server
   has not confirmed; if those goods are then received via the backoffice override, the
   POS receive dead-letters and rolls back, but any sale already made stands. Rare
   (override is a stuck-device valve) and explicitly accepted.

## Components / boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| migration `0017` | `users.receive_pin_hash` / `_set_at`; `transfers.received_by` (+ optional `received_via`) | users, transfers |
| backend PIN store | hash/verify argon2id; set/clear PIN per user; list approvers for an outlet | users table, argon2 lib |
| backend sync handler (`transfer_receive`) | re-validate PIN+role+scope; idempotent; call `ReceiveTransfer`; set `received_by` | auth/PIN store, write repo, sync batch |
| backend bundle assembly | add `transfers` (in-transit, dest=outlet) + `receiveApprovers` (scoped) to `Pull` | read repo, PIN store, settings |
| backend settings | read/write `receiveApproverRoles` | settings store |
| backend force-receive handler | admin + `manage_inventory`; call `ReceiveTransfer`; mark `received_via='backoffice'` | write repo |
| pure `applyCredits` + reconciler (`packages/sync`) | fold credits into snapshot; retire on version; rollback on dead-letter | snapshot, outbox events (unit-tested) |
| pending-credit store (`packages/sync`) | persist/list/retire credits across restart + `snapshot.replace` | KV storage |
| POS PIN verifier (pure) | argon2 verify + attempt-lockout state machine | crypto, KV (unit-tested) |
| POS receive screen + step-up modal | inbound list, informed-count entry, discrepancy reason, approver pick + PIN keypad | snapshot, useCart-style derive, engine.enqueue |
| backoffice Users PIN field | admin set/clear receive PIN | users API, `ui/` primitives |
| backoffice approver-roles setting | per-role toggles | settings API |
| backoffice force-receive action | admin override on stuck outlet transfers | transfers API |

## API

**Backend sync batch — new item type** (existing `POST /api/v1/sync/batch`):
- `type: "transfer_receive"`, payload:
  `{ transferId, items:[{productId, variantSize, receivedQty}], discrepancyReason?,
     approverUserId, pin, orderUuid, deviceId, clientCreatedAt }`.
  Server: verify `approverUserId` role ∈ `receiveApproverRoles`, `pin` matches that
  user's `receive_pin_hash`, and the approver is in scope for the transfer's dest
  outlet (assigned there or admin); then `ReceiveTransfer(transferId, …)` and set
  `received_by = approverUserId`. Idempotent on `idempotencyKey`; returns
  `ok` / `duplicate` / error (`pin salah`, `tidak berwenang`, `transfer sudah diterima`).
- The PIN travels over TLS and is validated server-side against the hash; it is
  **cleared from the outbox payload on ack**. (Flagged: brief at-rest window in the
  local outbox while offline — the device already holds the hash, so this does not
  widen the exposure surface.)

**Backoffice (gated `manage_inventory` / admin):**
- `PUT /users/{id}/receive-pin` — admin set/clear a user's PIN (`{ pin } | { clear:true }`).
- `GET/PUT` settings `receiveApproverRoles`.
- `POST /transfers/{id}/force-receive` — admin override → same `ReceiveTransfer`,
  `received_via='backoffice'`, no on-device count (defaults each line to `sentQty`
  unless qty overrides + reason supplied, mirroring the SP2 backoffice receive screen).

**POS bundle (read):** `transfers` + `receiveApprovers` added to `GET /api/v1/sync/pull`.

## POS UI

- **"Terima Transfer"** entry in the MenuDrawer *Operasional* section with a **badge**
  = count of inbound in-transit transfers in the snapshot. Empty/zero → no badge.
- **Inbound list**: one row per in-transit transfer for this outlet — `transferNo`,
  source name, line/qty summary, arrival (sent) date.
- **Receive screen** (one transfer): each line shows product · variant · **pre-filled
  `sentQty`** (informed). The receiver edits only differing lines. A single
  discrepancy-reason field becomes required once any line differs; the computed
  difference shows per line. Primary action **Terima**.
- **Step-up modal**: pick approver from `receiveApprovers` (displayName), numeric
  **PIN keypad**, validate on-device against that user's hash. **Lockout after 5 failed
  attempts** (persisted cooldown). Empty-state when no approver has a PIN set
  ("Belum ada penyetuju ber-PIN — hubungi admin").
- On success: atomic receive enqueued, optimistic credit applied, toast
  "Diterima — akan disinkronkan." Rollback notice surfaced if it later dead-letters.
- Reuses POS design language (light-luxury, gold tokens, semantic-only colors); keypad
  + list follow the anti-template quality bar already used on the POS.

## Backoffice UI

- **Users screen**: per-user "PIN penerimaan" control (admin only) — set / reset /
  clear; shows whether a PIN is set (never the PIN). Only meaningful for users whose
  role is an approver role (still settable regardless).
- **Settings**: "Peran yang boleh menyetujui penerimaan" — per-role toggles
  (admin/manager/cashier), org-wide.
- **Gudang › Transfer**: for an `in_transit` outlet-destination transfer, an admin-only
  **"Terima paksa (override)"** action, clearly labelled as a backoffice receive
  without an on-device count. Reuses the SP2 receive screen (actual qty + reason).

## Error handling

- Server re-validation messages (Indonesian, friendly): `pin salah`,
  `tidak berwenang` (role/scope), `transfer sudah diterima` (wrong status / already
  received), `alasan selisih wajib` (reuse SP2).
- On-device: lockout message + cooldown countdown after 5 wrong PINs; clear
  empty-state when no approver/PIN is available offline.
- Dead-letter rollback notice on the POS; the item also flows through the existing
  dead-letter/sync-error surface.
- Optimistic credit never double-counts (version-gated retirement) and never strands
  (rollback on reject) — both covered by unit tests.
- Detailed context logged server-side; PINs never logged.

## Security considerations

- **PINs are argon2id-hashed** at rest (server) and only **hashes** sync to devices.
- **Hash exposure minimized**: only approving-role users assigned to the outlet (+
  admins) sync to a given device (decision 7). Short PINs are brute-forceable from a
  stolen/rooted device's local store — mitigated by argon2id cost, the scoped hash set,
  on-device lockout, and admin-resettable per-user PINs.
- **Server is the authority**: every receive is re-validated server-side (PIN + role +
  scope) regardless of the on-device check, so a tampered client cannot push an
  unauthorized receive.
- PIN plaintext is transient (TLS in flight; cleared from the outbox on ack).
- Backoffice override is admin-gated and recorded (`received_by`, `received_via`).

## Testing

Repo pattern: pure logic unit-tested, DB/IO verified live.
- **Go table-tests**: `transfer_receive` validation (PIN match/mismatch, role in/out of
  approver set, scope in/out, wrong-status → already-received, discrepancy reason
  required), idempotency (duplicate key → `duplicate`, single credit), approver
  scoping for bundle assembly.
- **Vitest (pure)**: `applyCredits` folding; reconciliation arm A (retire when
  `ackVersion ≤ snapshot.version`, no double-count across the ack→resync window); arm B
  (dead-letter rollback removes credit); PIN verify + lockout state machine.
- **Live verification** (build → deploy → `/readyz` → device/Playwright smoke):
  in-transit transfer appears in the dest outlet's POS bundle; informed-count receive
  with a discrepancy + reason; manager PIN accept and reject (lockout); offline receive
  → reconnect → flush → resync → stock reflects credit once, badge clears; backoffice
  force-receive on a stuck transfer → POS pending credit (if any) dead-letters and
  rolls back with a notice.

## Out of scope (SP3)

Delivery note / PDF / thermal print / WhatsApp share (SP4); making offline *sales*
stock-accurate; inventory valuation / COGS; a generic stock-movement audit ledger;
per-user (vs per-role) or per-outlet approver configuration; manager *login* on the POS;
partial/multi-session receiving against one transfer; self-service PIN management by the
approver (admin-assigned only this round).

## Plan phasing hint

**A:** migration 0017 + backend PIN store (argon2id hash/verify, set/clear) +
`receiveApproverRoles` settings read/write + backoffice Users PIN field + settings
toggles. **B:** bundle assembly — add `transfers` (in-transit, dest=outlet) +
`receiveApprovers` (scoped) to `Pull`; openapi/codegen. **C:** `transfer_receive` sync
handler (server re-validate + `ReceiveTransfer` + `received_by`, idempotent) +
backoffice force-receive override. **D:** `packages/sync` pending-credit store +
`applyCredits` + reconciler + PIN verify/lockout (pure, unit-tested). **E:** POS UI —
Terima Transfer menu/badge, inbound list, informed-count receive screen, step-up PIN
modal; wire enqueue + optimistic credit + rollback notice.
