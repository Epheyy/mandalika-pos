# Receipt numbers unique across tablets and reinstalls (server-assigned device code)

Date: 2026-10-14. HANDOFF follow-up "Receipt numbers repeat across tablets/reinstalls → server sequence or slice 10
device code". Not an AUDIT_REPORT finding; queued by the owner as item (b) of the 2026-10-14 non-policy queue.

## Today

`apps/pos/src/cashier/orderRef.ts`: `{OUTLET}-{DEV}{SEQ}`, e.g. `BSD-G0010`.
- `DEV` = 1 base36 char hashed from the per-install `deviceId` → 36 buckets; two tablets at one outlet collide 1 in 36.
- `SEQ` = counter in Preferences (`mandalika.pos.orderSeq`); reinstall / clear data / backup-restore (Preferences
  excluded from backup) → new deviceId + counter back to 0001 → old numbers repeat.
- Server: `orders.order_number` has no unique constraint (dropped in 0005); identity is `order_uuid` /
  `idempotency_key`. So repeats never corrupt data, but receipts, backoffice search (`order_number ILIKE`) and
  customer conversations ("struk BSD-G0010") become ambiguous. Seen on the test server: BSD-G0010..13 exist twice.

A pure server sequence cannot work: the tablet prints the number offline at sale time.

## Design

**The server assigns each install a device code per outlet, once, online.** Numbers become
`{OUTLET}-{CODE}{SEQ}` with `CODE` = two or more letters (`AA`, `AB`, … `ZZ`, then `AAA` …), SEQ ≥ 4 digits
(zero-padded to 4, grows past 9999).

- Every install gets a fresh deviceId → a fresh code → a fresh sequence. Codes are never reused at an outlet, so
  numbers never repeat, across tablets or reinstalls.
- Legacy numbers have exactly one tag character; new codes have ≥2 letters. The two formats can never produce the
  same string, so no back-scan of old orders is needed.
- **Never block a sale.** A tablet that has no code yet for its bound outlet (e.g. upgraded while offline) keeps the
  legacy format until registration succeeds. A binding always happens at sign-in, which is online, so this is a
  short transitional window.

### Backend

- Migration 0052 `pos_devices`: `device_id uuid`, `outlet_id uuid REFERENCES outlets(id)`, `code text NOT NULL`,
  `registered_by uuid`, `registered_at timestamptz DEFAULT now()`, `last_seen_at timestamptz`;
  `PRIMARY KEY (device_id, outlet_id)`, `UNIQUE (outlet_id, code)`.
- `POST /api/v1/pos/devices/register` `{deviceId}` → `{data: {code}}`. Authenticated; outlet = the caller's
  resolved outlet scope (terminal `X-Outlet-Id` rules as for sales); no outlet → 403. Idempotent: an existing
  `(device_id, outlet_id)` returns its code (and bumps `last_seen_at`). New: under
  `SELECT … FROM outlets WHERE id=$1 FOR NO KEY UPDATE` take the next code after the highest at that outlet
  (bijective base-26 letters starting at `AA`). deviceId must be a UUID (400 otherwise).
- OpenAPI + regenerated types; rate limit like other authed writes.

### POS

- New durable key `mandalika.pos.deviceCode` = `{outletId, code}` (via `kv.setDurable`).
- Register when online, bound (`authStore.outletId` set) and no code stored for that outlet: after sign-in /
  terminal settle and on sync resume; retry on the next tick on failure; never blocks the UI.
- `nextOrderNo`: if a code exists for the bound outlet → `{OUTLET}-{CODE}{SEQ}`, with SEQ stored per code
  (`mandalika.pos.orderSeq.<code>`, starts at 1); else the legacy format and legacy counter, unchanged.
- "Lepas terminal" / binding to another outlet clears the stored code (the new outlet registers its own).
- Shipped in the next APK / OTA (web layer only). Fleet is not rolled out yet.

### Not in scope

- Server-side rejection of duplicate numbers (offline sales must never be refused).
- Full slice 10 device registration (revocation, device list in backoffice). `pos_devices` is the table that work
  extends.

## Tests

- Go unit: code sequence (`AA`→`AB`, `AZ`→`BA`, `ZZ`→`AAA`).
- PG gate **DV** `TestDeviceRegisterPostgres` (port 56452, slug `dv`): same device twice → same code; two devices →
  `AA`, `AB`; same device at a second outlet → its own code there; 10 concurrent registrations → 10 distinct codes;
  no outlet → 403; bad deviceId → 400.
- POS vitest: registered → `BSD-AA0001`, `BSD-AA0002`; unregistered → legacy format; per-code counters; code for
  another outlet ignored; release clears it; registration failure leaves selling working.
