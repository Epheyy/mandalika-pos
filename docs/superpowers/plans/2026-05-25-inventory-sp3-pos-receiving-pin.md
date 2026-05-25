# SP3 — POS-Side Transfer Receiving + Manager Step-Up PIN — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **The 6 working rules (user-required, every task):** 1) Ask, don't assume · 2) Don't touch unrelated · 3) Flag uncertainty · 4) Verify on failure (never fake success) · 5) Show changes · 6) Admit gaps.

**Goal:** Let a destination outlet's POS receive an in-transit transfer with an informed physical count, authorized by a manager's per-user step-up PIN, fully offline with optimistic stock credit + reconciliation.

**Architecture:** In-transit transfers (dest = this outlet) and a scoped list of approving users (with argon2id PIN hashes) are added to the POS pull bundle. The cashier counts on a new POS receive screen; a manager picks their name and enters a PIN validated on-device (`hash-wasm` argon2id) with lockout, then the receive is enqueued as a new `transfer_receive` outbox item and the counted qty is optimistically credited to local stock. On flush the server re-validates PIN + role + scope and calls the existing `ReceiveTransfer`; an idempotency key makes retries safe. Reconciliation retires the optimistic credit once the authoritative snapshot includes it, or rolls it back (with a notice) if the receive is rejected.

**Tech Stack:** Go (chi, pgx, `golang.org/x/crypto/argon2`), OpenAPI + oapi-codegen, Postgres (Neon), TypeScript, React, `@mandalika/sync` (custom offline engine), `@mandalika/api` (generated client), Vitest, `hash-wasm` (new), Cloud Run + Cloudflare Pages + GH Actions APK.

---

## Source spec

`docs/superpowers/specs/2026-05-25-inventory-sp3-pos-receiving-pin-design.md` (9 locked decisions). Read it before starting.

## Verified current-state anchors (do not re-discover)

- Migrations: `backend/internal/db/migrations/NNNN_*.sql`, embedded + applied on boot (`cmd/server/main.go` → `database.Migrate`), tracked in `schema_migrations`. Latest = `0016_transfers.sql`. **Next = 0017.**
- PIN hashing: **reuse** `backend/internal/auth/password.go` → `HashPassword(s)` / `VerifyPassword(s, encoded)` (argon2id, PHC string `$argon2id$v=19$m=65536,t=1,p=4$<b64salt>$<b64hash>`, `base64.RawStdEncoding`). `golang.org/x/crypto` already in `go.mod`.
- Users: `users(id,email,password_hash,display_name,role,outlet_id,photo_url,created_at)` + `user_permissions(user_id,permission)`. Roles enum `admin|manager|cashier`. Write store: `backend/internal/auth/store.go`. User read obj: `read/repo.go` `userObj` + `Users()`.
- Transfers (SP2): `transfers` / `transfer_items` (migration 0016). Write repo `backend/internal/write/transfer.go` — `ReceiveTransfer(ctx,id,TransferReceive)` already credits actual qty + records `difference` + requires reason on diff + bumps dest outlet version. Read `read/repo.go` `transferObj`/`transferFrom` + `Transfers()`/`Transfer()`.
- App settings: singleton row `app_settings WHERE id=1`. Read `read/repo.go` `AppSettings()`; write `write/repo.go` `UpdateAppSettings(raw)`; handler `handlers/writes.go` `UpdateAppSettings`.
- Sync: `backend/internal/sync/sync.go` — `PullBundle` struct + `Pull(ctx,scope,outletID)`; `processOne` switch on `it.Type`; `BatchItem{Type,IdempotencyKey,Payload}` / `ItemResult{IdempotencyKey,Status,...}` / `BatchResult{...,Version}`.
- Routing: `backend/internal/server/server.go` — `manage_inventory` group registers `/transfers...`. Admin middleware `mw.RequirePermission` / role checks in `middleware/middleware.go`.
- OpenAPI: spec `backend/api/openapi.yaml`; codegen `cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml` (or `make gen-go`); TS regen `corepack pnpm --filter @mandalika/api gen`. **CI `make gen-check` fails on drift — always commit regenerated `internal/api/api.gen.go`.**
- `packages/sync`: `storage.ts` (`KV{get,set,remove}`, `defaultKV`, `getKV`, `readJSON`, `writeJSON`); `outbox.ts` (`OutboxType` union, `Outbox` class); `snapshot.ts` (`Snapshot{get,replace,localVersion}`, keys `mandalika.pos.snapshot` / `mandalika.pos.contentVersion`); `engine.ts` (`SyncEngine`); `device.ts` (`uuid`,`getDeviceId`); `index.ts` exports.
- Stock the POS guards: `snapshot.products[].variants[].stock` (per-outlet resolved). Read via `engine.getSnapshot()` (`CashierScreen.tsx:122`); guard e.g. `CashierScreen.tsx:186`, `ProductGrid.tsx:78`.
- POS wiring: `cashier/SyncProvider.tsx` builds `SyncEngine` with `onWall/onOutboxChange/onDeadLetter/debug` + `getKV()`, exposes via `SyncContext`. `cashier/MenuDrawer.tsx` `opItems: Item[]` (`Item{Icon,label,active?,badge?,onClick}`). `cashier/CashierScreen.tsx` toast = `showToast(msg)`; enqueue pattern `engine.enqueue('order', {...})`.
- Vitest: `apps/pos` `"test":"vitest run"`, example `cashier/scan.test.ts`.
- Backoffice: client `apps/backoffice/src/api.ts` (`api.updateUser(id,body)` etc.); `screens/Users.tsx` edit modal; `screens/SettingsScreen.tsx` (`Tabs` sections + `Toggle`); `screens/transfers/ReceiveModal.tsx`; primitives `apps/backoffice/src/ui/` (Button, Field/Input/Select/Textarea, Modal, Card, Badge, IconButton, EmptyState, PageHeader, Tabs).
- **No JS hashing lib installed** → add `hash-wasm` to `apps/pos`.

## Deploy / verify loop (per backend batch)

```bash
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos/backend" && gofmt -w internal/ && make gen-go
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos" && corepack pnpm --filter @mandalika/api gen
# build/typecheck the touched app(s):
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
# backend deploy (background ~4-6 min; migrations auto-apply on boot):
gcloud run deploy mandalika-pos --source backend --region asia-southeast2 --quiet
# verify:  curl -s https://mandalika-pos-538849926142.asia-southeast2.run.app/readyz
```
Commit on its own line (commit hook false-positives on `git commit && …`), then push separately. Backend Bash calls need `dangerouslyDisableSandbox: true` for `gcloud`.

---

## File structure (created / modified)

**Backend**
- Create `backend/internal/db/migrations/0017_receive_pin.sql`
- Modify `backend/api/openapi.yaml` (AppSettings, ReceiveApprover, SetReceivePinRequest, SyncPullBundle, batch type enum)
- Modify `backend/internal/auth/store.go` (SetReceivePin / ClearReceivePin)
- Modify `backend/internal/read/repo.go` (AppSettings +field, ReceiveApprovingUsers, TransfersForOutlet)
- Modify `backend/internal/write/repo.go` (UpdateAppSettings +field)
- Modify `backend/internal/write/transfer.go` (ReceiveTransfer + meta/idempotency)
- Create `backend/internal/write/transfer_meta_test.go` (pure helper tests)
- Modify `backend/internal/sync/sync.go` (PullBundle +2 fields, Pull, transfer_receive case, payload struct)
- Create `backend/internal/sync/transfer_receive_test.go`
- Modify `backend/internal/handlers/writes.go` (SetReceivePin handler)
- Modify `backend/internal/server/server.go` (route)

**packages/sync**
- Create `packages/sync/src/pin.ts` (verifyPin) + `pin.test.ts`
- Create `packages/sync/src/lockout.ts` (pure state machine) + `lockout.test.ts`
- Create `packages/sync/src/pendingCredits.ts` (store) + `applyCredits` + `pendingCredits.test.ts`
- Modify `packages/sync/src/outbox.ts` (+`'transfer_receive'`)
- Modify `packages/sync/src/snapshot.ts` (no version-bump setter if needed — see Task D6)
- Modify `packages/sync/src/engine.ts` (pending-credit integration, credited getSnapshot, reconcile arms, enqueueTransferReceive)
- Modify `packages/sync/src/index.ts` (exports)
- Modify `apps/pos/package.json` (`hash-wasm`)

**apps/pos**
- Create `apps/pos/src/cashier/receive/ReceiveTransferPanel.tsx` (inbound list + receive screen)
- Create `apps/pos/src/cashier/receive/PinStepUpModal.tsx`
- Create `apps/pos/src/cashier/receive/receiveTypes.ts`
- Modify `apps/pos/src/cashier/MenuDrawer.tsx` (Terima Transfer item + badge)
- Modify `apps/pos/src/cashier/CashierScreen.tsx` (panel state, enqueue, rollback notice)
- Modify `apps/pos/src/cashier/SyncProvider.tsx` (dead-letter → transfer rollback notice hook)

**apps/backoffice**
- Modify `apps/backoffice/src/screens/Users.tsx` (set/clear receive PIN)
- Modify `apps/backoffice/src/screens/SettingsScreen.tsx` (approver-roles toggles)
- Modify `apps/backoffice/src/screens/transfers/ReceiveModal.tsx` (override labeling for outlet-dest)

---

# Phase A — Backend PIN + approver-roles foundation

### Task A1: Migration 0017

**Files:** Create `backend/internal/db/migrations/0017_receive_pin.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0017: per-user receive-approval PIN (argon2id hash, reuses auth password format),
-- transfer receive attribution + idempotency, and the org-wide approver-role config.
ALTER TABLE users ADD COLUMN receive_pin_hash   text;        -- NULL = no PIN set
ALTER TABLE users ADD COLUMN receive_pin_set_at timestamptz; -- audit / "PIN set" UI state

ALTER TABLE transfers ADD COLUMN received_by              uuid REFERENCES users(id);
ALTER TABLE transfers ADD COLUMN received_via             text;  -- 'pos' | 'backoffice'
ALTER TABLE transfers ADD COLUMN received_idempotency_key text;  -- POS offline retry guard

ALTER TABLE app_settings ADD COLUMN receive_approver_roles text[] NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: Build to confirm it embeds & boots**

Run: `cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos/backend" && go build ./...`
Expected: builds clean (migration is applied at runtime; no Go change yet).

- [ ] **Step 3: Commit**

```bash
git add backend/internal/db/migrations/0017_receive_pin.sql
git commit -m "feat(inventory): SP3 migration 0017 — receive PIN, transfer attribution+idempotency, approver-roles setting"
```

---

### Task A2: OpenAPI schemas + regen (AppSettings field, ReceiveApprover, SetReceivePinRequest)

**Files:** Modify `backend/api/openapi.yaml`; regenerate `backend/internal/api/api.gen.go` + `packages/api`

- [ ] **Step 1: Add `receiveApproverRoles` to the AppSettings schema**

In `backend/api/openapi.yaml`, in `components.schemas.AppSettings.properties`, add:

```yaml
    receiveApproverRoles:
      type: array
      items: { type: string }
      description: Roles whose users may approve a POS transfer receive.
```

If `AppSettings.required` lists fields, do NOT add this to `required` (default `'{}'` makes it always present, but keep it optional for forward-compat).

- [ ] **Step 2: Add the ReceiveApprover schema**

Under `components.schemas`:

```yaml
    ReceiveApprover:
      type: object
      required: [userId, displayName, receivePinHash]
      properties:
        userId: { type: string, format: uuid }
        displayName: { type: string }
        receivePinHash: { type: string }
```

- [ ] **Step 3: Add the SetReceivePinRequest schema**

```yaml
    SetReceivePinRequest:
      type: object
      properties:
        pin: { type: string, minLength: 4, maxLength: 8, nullable: true }
        clear: { type: boolean, nullable: true }
```

- [ ] **Step 4: Add the set-PIN path**

Under `paths`, add (mirror an existing admin user path for security/response shape):

```yaml
  /users/{id}/receive-pin:
    put:
      operationId: setUserReceivePin
      tags: [users]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/SetReceivePinRequest' }
      responses:
        '200': { description: ok, content: { application/json: { schema: { type: object, properties: { ok: { type: boolean } } } } } }
```

- [ ] **Step 5: Regenerate Go + TS types**

Run:
```bash
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos/backend" && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos" && corepack pnpm --filter @mandalika/api gen
```
Expected: `internal/api/api.gen.go` now has `AppSettings.ReceiveApproverRoles`, `ReceiveApprover`, `SetReceivePinRequest`, `SetUserReceivePin` server iface entry; `packages/api` TS types updated. Build: `cd backend && go build ./...` (will fail to implement the new server method until A5 — acceptable; if strict-server requires it, stub in A5 same commit).

- [ ] **Step 6: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api
git commit -m "feat(api): SP3 schemas — AppSettings.receiveApproverRoles, ReceiveApprover, SetReceivePinRequest, set-pin path"
```

---

### Task A3: Write store — SetReceivePin / ClearReceivePin + UpdateAppSettings field

**Files:** Modify `backend/internal/auth/store.go`, `backend/internal/write/repo.go`

- [ ] **Step 1: Add SetReceivePin/ClearReceivePin to the auth store**

In `backend/internal/auth/store.go` (reuse `HashPassword`):

```go
// SetReceivePin hashes and stores a user's receive-approval PIN (argon2id, same
// format as the password). Empty pin clears it.
func (s *Store) SetReceivePin(ctx context.Context, userID, pin string) error {
	if pin == "" {
		return s.ClearReceivePin(ctx, userID)
	}
	hash, err := HashPassword(pin)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx,
		`UPDATE users SET receive_pin_hash=$1, receive_pin_set_at=now() WHERE id=$2`,
		hash, userID)
	return err
}

func (s *Store) ClearReceivePin(ctx context.Context, userID string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE users SET receive_pin_hash=NULL, receive_pin_set_at=NULL WHERE id=$1`, userID)
	return err
}
```

- [ ] **Step 2: Add `receiveApproverRoles` to UpdateAppSettings**

In `backend/internal/write/repo.go` `UpdateAppSettings`, add the field to the inline struct and the UPDATE. Ensure `github.com/lib/pq` is imported (check imports first; if pgx-native is preferred, use `t.Exec(... $11 ...)` with `s.ReceiveApproverRoles` directly — pgx encodes `[]string` to `text[]` natively, so **prefer passing the `[]string` directly without `pq.Array`**):

```go
		ReceiveApproverRoles []string `json:"receiveApproverRoles"`
```
and extend the UPDATE column list with `receive_approver_roles=$11` and append `s.ReceiveApproverRoles` as the 11th arg (pgx encodes `[]string`→`text[]`).

- [ ] **Step 3: Build**

Run: `cd backend && gofmt -w internal/ && go build ./...`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/auth/store.go backend/internal/write/repo.go
git commit -m "feat(inventory): SP3 write — set/clear receive PIN + persist receiveApproverRoles"
```

---

### Task A4: Read — AppSettings field + ReceiveApprovingUsers

**Files:** Modify `backend/internal/read/repo.go`

- [ ] **Step 1: Add `receiveApproverRoles` to AppSettings read**

In `read/repo.go` `AppSettings()`, add `'receiveApproverRoles',receive_approver_roles` to the `json_build_object(...)`.

- [ ] **Step 2: Add ReceiveApprovingUsers**

```go
// ReceiveApprovingUsers returns users who may approve a receive at this outlet:
// role ∈ app_settings.receive_approver_roles AND (outlet_id = outletID OR role='admin')
// AND a PIN is set. Hashes are synced to the device for offline on-device verify.
func (r *Repo) ReceiveApprovingUsers(ctx context.Context, outletID string) ([]api.ReceiveApprover, error) {
	rows, err := r.Pool.Query(ctx, `
		SELECT u.id, u.display_name, u.receive_pin_hash
		  FROM users u, app_settings s
		 WHERE s.id = 1
		   AND u.receive_pin_hash IS NOT NULL
		   AND u.role = ANY (s.receive_approver_roles)
		   AND (u.outlet_id = $1 OR u.role = 'admin')
		 ORDER BY u.display_name`, outletID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []api.ReceiveApprover{}
	for rows.Next() {
		var a api.ReceiveApprover
		if err := rows.Scan(&a.UserId, &a.DisplayName, &a.ReceivePinHash); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
```
Note: confirm `api.ReceiveApprover` field names from the generated file (`UserId`, `DisplayName`, `ReceivePinHash`) and that `UserId` is `openapi_types.UUID` (scan into it works with pgx; if not, scan a `string` into a temp and assign).

- [ ] **Step 3: Build**

Run: `cd backend && go build ./...`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(inventory): SP3 read — AppSettings.receiveApproverRoles + ReceiveApprovingUsers (scoped to outlet+admins)"
```

---

### Task A5: Handler + route — PUT /users/{id}/receive-pin (admin)

**Files:** Modify `backend/internal/handlers/writes.go`, `backend/internal/server/server.go`

- [ ] **Step 1: Add the handler**

In `handlers/writes.go` (match the project's body-decode + error helpers):

```go
func (h *Handlers) SetUserReceivePin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Pin   *string `json:"pin"`
		Clear *bool   `json:"clear"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	id := chi.URLParam(r, "id")
	pin := ""
	if body.Pin != nil && (body.Clear == nil || !*body.Clear) {
		pin = *body.Pin
	}
	if pin != "" && (len(pin) < 4 || len(pin) > 8) {
		httpx.Err(w, http.StatusBadRequest, "PIN harus 4-8 digit")
		return
	}
	h.mutated(w, r, h.Auth.SetReceivePin(r.Context(), id, pin))
}
```
Confirm the handler struct field that holds the auth store (`h.Auth`); if handlers reach it differently (e.g. `h.Store`), use that name.

- [ ] **Step 2: Register the route under the admin/user-management group**

In `server.go`, in the same group that registers user create/update (admin-gated), add:

```go
	r.Put("/users/{id}/receive-pin", h.SetUserReceivePin)
```

- [ ] **Step 3: Build + deploy + verify**

```bash
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos/backend" && gofmt -w internal/ && go build ./... && make gen-check
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos" && corepack pnpm --filter @mandalika/api gen
```
Then deploy (background) and after `/readyz` is ok, verify with an authed admin token (token via `git credential fill` / existing admin login):
- `PUT /api/v1/users/{managerId}/receive-pin {"pin":"1234"}` → 200; DB `users.receive_pin_hash` set, `receive_pin_set_at` non-null.
- `PUT .../receive-pin {"clear":true}` → 200; hash NULL again.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/handlers/writes.go backend/internal/server/server.go
git commit -m "feat(inventory): SP3 endpoint — admin set/clear user receive PIN"
```

---

### Task A6: Backoffice — set/clear receive PIN on Users

**Files:** Modify `apps/backoffice/src/screens/Users.tsx`, `apps/backoffice/src/api.ts` (only if a typed method wrapper is needed)

- [ ] **Step 1: Add modal state for the PIN**

In the Users edit modal state block add:
```tsx
const [pin, setPin] = useState('')           // empty = no change
const [clearPin, setClearPin] = useState(false)
```
Reset both when opening/closing the modal (alongside the existing `editRole`/`editPerms` resets).

- [ ] **Step 2: Render the field (only meaningful for approver roles, but always settable)**

After the Outlet select in the modal body:
```tsx
<Field label="PIN penerimaan transfer (opsional)">
  <Input
    inputMode="numeric"
    maxLength={8}
    placeholder={editingUser?.receivePinSet ? '•••• (tersetel) — isi untuk ganti' : 'Belum disetel'}
    value={pin}
    onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setClearPin(false) }}
    disabled={clearPin}
  />
  <label className="mt-1 flex items-center gap-2 text-sm text-gray-500">
    <input type="checkbox" checked={clearPin} onChange={(e) => setClearPin(e.target.checked)} />
    Hapus PIN
  </label>
</Field>
```
(If the `User` type has no `receivePinSet`, add a boolean to the user read/openapi — OR omit the placeholder hint; minimum viable: omit the "tersetel" hint and keep set/clear.)

- [ ] **Step 3: Call the endpoint on save**

In `saveUser`, after the existing `api.updateUser(...)`, if the PIN changed:
```tsx
if (clearPin) {
  await api.setUserReceivePin(editingUser.id, { clear: true })
} else if (pin) {
  await api.setUserReceivePin(editingUser.id, { pin })
}
```
Confirm the generated client exposes `setUserReceivePin`; if the client wraps operationIds differently, use the matching method or add a thin wrapper in `api.ts`.

- [ ] **Step 4: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add apps/backoffice/src/screens/Users.tsx apps/backoffice/src/api.ts
git commit -m "feat(backoffice): SP3 — set/clear receive PIN per user"
```

---

### Task A7: Backoffice — approver-roles toggles in Settings

**Files:** Modify `apps/backoffice/src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add a section + state**

Add an `'approver'` tab/section. Load `appSettings.receiveApproverRoles` into local state `const [approverRoles, setApproverRoles] = useState<string[]>(settings.receiveApproverRoles ?? [])`.

- [ ] **Step 2: Render per-role toggles**

```tsx
{(['admin','manager','cashier'] as const).map((role) => (
  <div key={role} className="flex items-center justify-between py-2">
    <span className="capitalize">{role}</span>
    <Toggle
      checked={approverRoles.includes(role)}
      onClick={() => setApproverRoles((prev) =>
        prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role])}
    />
  </div>
))}
```
Note: `admin` is implicitly always able to approve server-side, but showing it (default on) keeps the UI honest; the server query already includes admins regardless.

- [ ] **Step 3: Persist on save**

Wherever Settings persists (the existing save calls `api.updateAppSettings({...})`), include `receiveApproverRoles: approverRoles` in the payload. The backend merges it (Task A3).

- [ ] **Step 4: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add apps/backoffice/src/screens/SettingsScreen.tsx
git commit -m "feat(backoffice): SP3 — approver-roles toggles (org-wide)"
```

---

### Phase A verification (live)

- [ ] Deploy backend; push backoffice (auto-deploy). In backoffice: set approver roles = `["manager"]`; set a PIN on the test manager. Confirm `GET /api/v1/settings`/appSettings returns `receiveApproverRoles:["manager"]`, and the manager's `receive_pin_set_at` is set. **Show the diffs and the verification output.**

---

# Phase B — Bundle assembly (transfers + approvers → POS)

### Task B1: OpenAPI — SyncPullBundle fields + regen

**Files:** Modify `backend/api/openapi.yaml`; regen

- [ ] **Step 1: Add fields to SyncPullBundle**

In `components.schemas.SyncPullBundle.properties`:
```yaml
    transfers:
      type: array
      items: { $ref: '#/components/schemas/Transfer' }
    receiveApprovers:
      type: array
      items: { $ref: '#/components/schemas/ReceiveApprover' }
```
Do not add to `required` (older clients tolerate absence).

- [ ] **Step 2: Regen + build**

```bash
cd backend && go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml && go build ./...
cd .. && corepack pnpm --filter @mandalika/api gen
```
Expected: TS `SyncPullBundle` now has optional `transfers?`/`receiveApprovers?`.

- [ ] **Step 3: Commit**

```bash
git add backend/api/openapi.yaml backend/internal/api/api.gen.go packages/api
git commit -m "feat(api): SP3 — SyncPullBundle.transfers + receiveApprovers"
```

---

### Task B2: Read — TransfersForOutlet (in-transit, dest = outlet)

**Files:** Modify `backend/internal/read/repo.go`

- [ ] **Step 1: Add the method (reuse `transferObj`/`transferFrom`)**

```go
// TransfersForOutlet returns transfers of a given status destined to this outlet.
// Used by the POS pull bundle (status="in_transit") so the destination outlet can
// receive on-device.
func (r *Repo) TransfersForOutlet(ctx context.Context, outletID, status string) ([]api.Transfer, error) {
	sql := `SELECT ` + transferObj + ` ` + transferFrom +
		` WHERE t.dest_outlet_id=$1 AND t.status=$2 ORDER BY t.created_at DESC`
	rows, err := listJSON[api.Transfer](ctx, r.Pool, sql, outletID, status)
	return rows, err
}
```
If `listJSON` returns `(rows,total,err)`, adapt: `rows, _, err := listJSON[...](...)`. Match the existing helper signature used by `Transfers()`.

- [ ] **Step 2: Build**

Run: `cd backend && go build ./...` → clean.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/read/repo.go
git commit -m "feat(inventory): SP3 read — TransfersForOutlet (in-transit, dest outlet)"
```

---

### Task B3: Sync — add fields to PullBundle + Pull()

**Files:** Modify `backend/internal/sync/sync.go`

- [ ] **Step 1: Extend the PullBundle struct**

Add after `Users`:
```go
	Transfers        any `json:"transfers"`
	ReceiveApprovers any `json:"receiveApprovers"`
```

- [ ] **Step 2: Populate in Pull() (only for outlet scope)**

After the Users assignment, before returning `b`:
```go
	if b.Transfers, err = e.Read.TransfersForOutlet(ctx, outletID, "in_transit"); err != nil {
		return b, err
	}
	if b.ReceiveApprovers, err = e.Read.ReceiveApprovingUsers(ctx, outletID); err != nil {
		return b, err
	}
```
(`outletID` is already in scope in `Pull`. If `err` is declared per-call via `:=` elsewhere, match the existing assignment style.)

- [ ] **Step 3: Build + deploy + verify**

Build, deploy, then with the **cashier's** outlet token: create+send a test transfer to that outlet in backoffice → `GET /api/v1/sync/pull` returns it under `transfers`, and `receiveApprovers` lists the PIN'd manager (hash present). **Show the JSON excerpt.**

- [ ] **Step 4: Commit**

```bash
git add backend/internal/sync/sync.go
git commit -m "feat(inventory): SP3 — POS pull bundle carries in-transit transfers + scoped receive approvers"
```

---

# Phase C — Server-side receive via sync batch (PIN re-validate + idempotency)

### Task C1: ReceiveTransfer accepts receive metadata (attribution + via + idempotency)

**Files:** Modify `backend/internal/write/transfer.go`; callers in `handlers/writes.go`

- [ ] **Step 1: Add a meta struct + extend the signature**

In `transfer.go`:
```go
type ReceiveMeta struct {
	ReceivedBy     string // approver/admin user id ("" allowed)
	ReceivedVia    string // "pos" | "backoffice"
	IdempotencyKey string // POS offline retry guard ("" for backoffice)
}
```
Change `func (r *Repo) ReceiveTransfer(ctx context.Context, id string, rcv TransferReceive) error` to
`func (r *Repo) ReceiveTransfer(ctx context.Context, id string, rcv TransferReceive, meta ReceiveMeta) error`.

- [ ] **Step 2: Idempotency + attribution inside the tx**

After `loadTransfer` and BEFORE `transferTransition`, add the idempotency short-circuit (load status + existing key):
```go
	// Idempotent retry: a completed transfer whose stored key matches this one is a
	// duplicate of an already-applied POS receive → treat as success (no-op).
	if meta.IdempotencyKey != "" {
		var status string
		var existing *string
		if e := tx.QueryRow(ctx,
			`SELECT status, received_idempotency_key FROM transfers WHERE id=$1`, id,
		).Scan(&status, &existing); e != nil {
			return e
		}
		if status == "completed" && existing != nil && *existing == meta.IdempotencyKey {
			return tx.Commit(ctx) // already applied by this exact receive
		}
	}
```
Then in the final `UPDATE transfers SET status='completed' ...`, also set `received_by`, `received_via`, `received_idempotency_key`:
```go
	if _, e := tx.Exec(ctx,
		`UPDATE transfers SET status='completed', received_at=now(), discrepancy_reason=$1,
		   received_by=$2, received_via=$3, received_idempotency_key=$4 WHERE id=$5`,
		nullStr(rcv.DiscrepancyReason), nullUUID(meta.ReceivedBy),
		nullStr(meta.ReceivedVia), nullStr(meta.IdempotencyKey), id); e != nil {
		return e
	}
```
(Reuse the existing `nullStr`/`nullUUID` helpers from the write package.)

- [ ] **Step 3: Update the existing backoffice caller**

In `handlers/writes.go` `ReceiveTransfer`, pass `write.ReceiveMeta{ReceivedBy: c.userID, ReceivedVia: "backoffice"}` (get the caller via the existing `h.caller(r)` used by `CreateTransfer`). Update the call site signature.

- [ ] **Step 4: Build**

Run: `cd backend && gofmt -w internal/ && go build ./...` → clean (all callers updated).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/write/transfer.go backend/internal/handlers/writes.go
git commit -m "feat(inventory): SP3 — ReceiveTransfer records approver/via + idempotency key; backoffice marks via=backoffice"
```

---

### Task C2: Pure helper — approver authorization (table-tested)

**Files:** Create `backend/internal/sync/transfer_receive_test.go`; add helper to `backend/internal/sync/sync.go`

- [ ] **Step 1: Write the failing test for the pure auth check**

```go
package sync

import "testing"

func TestAuthorizeApprover(t *testing.T) {
	cases := []struct {
		name      string
		role      string
		roles     []string
		wantOK    bool
	}{
		{"manager allowed", "manager", []string{"manager"}, true},
		{"admin always", "admin", []string{"manager"}, true},
		{"cashier denied", "cashier", []string{"manager"}, false},
		{"empty roles denies non-admin", "manager", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := approverAllowed(c.role, c.roles); got != c.wantOK {
				t.Fatalf("approverAllowed(%q,%v)=%v want %v", c.role, c.roles, got, c.wantOK)
			}
		})
	}
}
```

- [ ] **Step 2: Run — expect FAIL (undefined)**

Run: `cd backend && go test ./internal/sync/ -run TestAuthorizeApprover`
Expected: FAIL `undefined: approverAllowed`.

- [ ] **Step 3: Implement**

In `sync.go`:
```go
func approverAllowed(role string, approverRoles []string) bool {
	if role == "admin" {
		return true
	}
	for _, r := range approverRoles {
		if r == role {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && go test ./internal/sync/ -run TestAuthorizeApprover` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sync/sync.go backend/internal/sync/transfer_receive_test.go
git commit -m "test(inventory): SP3 — approverAllowed pure auth check"
```

---

### Task C3: Sync batch — transfer_receive case

**Files:** Modify `backend/internal/sync/sync.go`

- [ ] **Step 1: Add the payload struct**

```go
type transferReceivePayload struct {
	TransferID        string `json:"transferId"`
	Items             []struct {
		ProductID   string `json:"productId"`
		VariantSize string `json:"variantSize"`
		ReceivedQty int    `json:"receivedQty"`
	} `json:"items"`
	DiscrepancyReason string `json:"discrepancyReason"`
	ApproverUserID    string `json:"approverUserId"`
	Pin               string `json:"pin"`
}
```

- [ ] **Step 2: Add the case to the `processOne` switch**

Mirror the `order` case's result/idempotency shape (`ItemResult`):
```go
case "transfer_receive":
	var p transferReceivePayload
	if err := json.Unmarshal(it.Payload, &p); err != nil {
		res.Status, res.Error = "error", "payload tidak valid"
		return res
	}
	appr, err := e.Read.UserAuth(ctx, p.ApproverUserID) // {role, receivePinHash}
	if err != nil {
		res.Status, res.Error = "error", "penyetuju tidak ditemukan"
		return res
	}
	roles, _ := e.Read.ReceiveApproverRoles(ctx)
	if !approverAllowed(appr.Role, roles) {
		res.Status, res.Error = "error", "tidak berwenang"
		return res
	}
	if appr.ReceivePinHash == "" {
		res.Status, res.Error = "error", "PIN belum disetel"
		return res
	}
	ok, _ := auth.VerifyPassword(p.Pin, appr.ReceivePinHash)
	if !ok {
		res.Status, res.Error = "error", "PIN salah"
		return res
	}
	items := make([]write.TransferReceiveItem, 0, len(p.Items))
	for _, it := range p.Items {
		items = append(items, write.TransferReceiveItem{
			ProductID: it.ProductID, VariantSize: it.VariantSize, ReceivedQty: it.ReceivedQty,
		})
	}
	err = e.Write.ReceiveTransfer(ctx, p.TransferID, write.TransferReceive{
		Items: items, DiscrepancyReason: p.DiscrepancyReason,
	}, write.ReceiveMeta{
		ReceivedBy: p.ApproverUserID, ReceivedVia: "pos", IdempotencyKey: it.IdempotencyKey,
	})
	if err != nil {
		res.Status, res.Error = "error", err.Error()
		return res
	}
	res.Status, res.OrderID = "ok", p.TransferID
	return res
```
Adjust to the exact field names of `ItemResult`/the engine's write+read handles (`e.Write`, `e.Read`, or `e.Orders` — confirm which struct holds the write repo + read repo in the sync `Engine`). The duplicate path: when `ReceiveTransfer` short-circuits on a matching idempotency key it returns nil → `"ok"` (functionally a duplicate; acceptable). If a distinct "duplicate" status is desired, have `ReceiveTransfer` return a sentinel `ErrAlreadyReceived` for the same-key case and map it to `res.Status="duplicate"`.

- [ ] **Step 3: Add the read helpers used above**

In `read/repo.go` add small reads (or reuse existing `User`):
```go
type ApproverAuth struct { Role, ReceivePinHash string }

func (r *Repo) UserAuth(ctx context.Context, id string) (ApproverAuth, error) {
	var a ApproverAuth
	var hash *string
	e := r.Pool.QueryRow(ctx, `SELECT role, receive_pin_hash FROM users WHERE id=$1`, id).Scan(&a.Role, &hash)
	if hash != nil { a.ReceivePinHash = *hash }
	return a, e
}

func (r *Repo) ReceiveApproverRoles(ctx context.Context) ([]string, error) {
	var roles []string
	e := r.Pool.QueryRow(ctx, `SELECT receive_approver_roles FROM app_settings WHERE id=1`).Scan(&roles)
	return roles, e
}
```
(pgx scans `text[]`→`[]string` natively.) Confirm the sync `Engine` exposes a `*read.Repo` (e.g. `e.Read`); if it only has a narrower interface, widen it minimally.

- [ ] **Step 4: Build + Go test + deploy + verify**

```bash
cd backend && gofmt -w internal/ && go build ./... && go test ./internal/... && make gen-check
```
Then deploy. Verify via authed batch POST `/api/v1/sync/batch` with one `transfer_receive` item for a real in-transit transfer:
- wrong PIN → `error: PIN salah`, transfer stays in_transit.
- correct PIN, full receive → `ok`; dest stock credited; `transfers.received_by`/`received_via='pos'` set; version bumped.
- **resend the same item (same idempotencyKey)** → `ok`/`duplicate`, **no double credit**.
- a second receive with a different key on the now-completed transfer → `error` (already received).
**Show the verification output.**

- [ ] **Step 5: Commit**

```bash
git add backend/internal/sync/sync.go backend/internal/read/repo.go
git commit -m "feat(inventory): SP3 — transfer_receive sync handler (PIN+role+scope re-validate, idempotent) calls ReceiveTransfer"
```

---

# Phase D — packages/sync: PIN verify, lockout, pending credits, engine reconcile

### Task D1: Add hash-wasm + cross-impl PIN verify spike (HIGH RISK FIRST)

**Files:** Modify `apps/pos/package.json`; Create `packages/sync/src/pin.ts`, `packages/sync/src/pin.test.ts`

- [ ] **Step 1: Add the dependency**

```bash
cd "C:/Users/MyBook Hype AMD/Downloads/mandalika-pos" && corepack pnpm --filter @mandalika/pos add hash-wasm
```
(`hash-wasm` is a small WASM lib with `argon2Verify`. If the monorepo prefers the dep in `packages/sync`, add it there instead so `pin.ts` can import it directly: `corepack pnpm --filter @mandalika/sync add hash-wasm`.)

- [ ] **Step 2: Write pin.ts**

```ts
import { argon2Verify } from 'hash-wasm'

/** Verify a 4-8 digit PIN against an argon2id PHC string produced by the Go
 *  backend (auth.HashPassword). Returns false on any parse/verify failure. */
export async function verifyPin(pin: string, encodedHash: string): Promise<boolean> {
  if (!pin || !encodedHash) return false
  try {
    return await argon2Verify({ password: pin, hash: encodedHash })
  } catch {
    return false
  }
}
```

- [ ] **Step 3: Write the round-trip fixture test (the spike)**

Generate ONE real hash from Go and paste it as a fixture:
```bash
cd backend && cat > /tmp/pinhash.go <<'EOF'
package main
import ("fmt"; "github.com/mandalika/pos-backend/internal/auth")
func main(){ h,_:=auth.HashPassword("1234"); fmt.Println(h) }
EOF
go run /tmp/pinhash.go   # copy the printed $argon2id$... string
```
Then `packages/sync/src/pin.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { verifyPin } from './pin'

// Fixture produced by backend auth.HashPassword("1234") — proves Go↔JS argon2id compat.
const GO_HASH = '$argon2id$v=19$m=65536,t=1,p=4$<PASTE_SALT>$<PASTE_HASH>'

describe('verifyPin (Go↔JS argon2id)', () => {
  it('accepts the correct PIN against a backend-generated hash', async () => {
    expect(await verifyPin('1234', GO_HASH)).toBe(true)
  })
  it('rejects a wrong PIN', async () => {
    expect(await verifyPin('9999', GO_HASH)).toBe(false)
  })
  it('rejects empty inputs', async () => {
    expect(await verifyPin('', GO_HASH)).toBe(false)
    expect(await verifyPin('1234', '')).toBe(false)
  })
})
```

- [ ] **Step 4: Run the spike**

Run: `corepack pnpm --filter @mandalika/sync exec vitest run src/pin.test.ts` (or the package that owns pin.ts).
Expected: PASS. **If `hash-wasm` rejects the `RawStdEncoding` (unpadded base64) PHC string, FLAG IT** and either (a) pad the base64 in a small pre-parse shim, or (b) switch the Go encoder to standard padded base64 in `password.go` (coordinate — it's shared with passwords; prefer the JS-side shim). Do not proceed to D-rest until this passes.

- [ ] **Step 5: Commit**

```bash
git add apps/pos/package.json packages/sync/src/pin.ts packages/sync/src/pin.test.ts pnpm-lock.yaml
git commit -m "feat(sync): SP3 — on-device argon2id PIN verify (hash-wasm) + Go↔JS round-trip test"
```

---

### Task D2: Pure lockout state machine

**Files:** Create `packages/sync/src/lockout.ts`, `packages/sync/src/lockout.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { canAttempt, recordFailure, reset, type Lockout, MAX_PIN_ATTEMPTS, LOCKOUT_MS } from './lockout'

const t0 = 1_000_000
describe('lockout', () => {
  it('allows attempts under the cap', () => {
    let s: Lockout = reset()
    for (let i = 0; i < MAX_PIN_ATTEMPTS - 1; i++) s = recordFailure(s, t0)
    expect(canAttempt(s, t0).allowed).toBe(true)
  })
  it('locks at the cap and reports remaining cooldown', () => {
    let s: Lockout = reset()
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) s = recordFailure(s, t0)
    const c = canAttempt(s, t0)
    expect(c.allowed).toBe(false)
    expect(c.remainingMs).toBe(LOCKOUT_MS)
  })
  it('unlocks after cooldown elapses', () => {
    let s: Lockout = reset()
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) s = recordFailure(s, t0)
    expect(canAttempt(s, t0 + LOCKOUT_MS + 1).allowed).toBe(true)
  })
  it('reset clears failures', () => {
    let s: Lockout = reset()
    s = recordFailure(s, t0)
    expect(canAttempt(reset(), t0).allowed).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `corepack pnpm --filter @mandalika/sync exec vitest run src/lockout.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement lockout.ts**

```ts
export const MAX_PIN_ATTEMPTS = 5
export const LOCKOUT_MS = 5 * 60 * 1000 // 5 min cooldown after the cap

export interface Lockout {
  failures: number
  lockedUntil: number // epoch ms; 0 = not locked
}

export function reset(): Lockout {
  return { failures: 0, lockedUntil: 0 }
}

export function recordFailure(s: Lockout, now: number): Lockout {
  const failures = s.failures + 1
  const lockedUntil = failures >= MAX_PIN_ATTEMPTS ? now + LOCKOUT_MS : 0
  return { failures, lockedUntil }
}

export function canAttempt(s: Lockout, now: number): { allowed: boolean; remainingMs: number } {
  if (s.lockedUntil && now < s.lockedUntil) {
    return { allowed: false, remainingMs: s.lockedUntil - now }
  }
  return { allowed: true, remainingMs: 0 }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `corepack pnpm --filter @mandalika/sync exec vitest run src/lockout.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/lockout.ts packages/sync/src/lockout.test.ts
git commit -m "feat(sync): SP3 — pure PIN lockout state machine + tests"
```

---

### Task D3: Pending credits store + applyCredits (pure)

**Files:** Create `packages/sync/src/pendingCredits.ts`, `packages/sync/src/pendingCredits.test.ts`

- [ ] **Step 1: Write the failing tests for applyCredits + retirement**

```ts
import { describe, it, expect } from 'vitest'
import type { components } from '@mandalika/api'
import { applyCredits, retireByVersion, type PendingCredit } from './pendingCredits'

type Bundle = components['schemas']['SyncPullBundle']

function bundle(version: number, stock: number): Bundle {
  return {
    version,
    products: [{
      id: 'p1', name: 'Parfum', brand: 'M', categoryId: 'c1',
      variants: [{ size: '10ml', price: 1000, stock, sku: 'S1' }],
      isFeatured: false, isFavourite: false, isActive: true, createdAt: '2026-01-01T00:00:00Z',
    }],
    categories: [], bundles: [], customers: [], promotions: [],
    discountCodes: [], loyaltyConditions: [],
  } as unknown as Bundle
}
const credit = (key: string, qty: number, ackVersion: number | null = null): PendingCredit => ({
  idempotencyKey: key, ackVersion,
  lines: [{ productId: 'p1', variantSize: '10ml', qty }],
})

describe('applyCredits', () => {
  it('adds credited qty to matching variant stock', () => {
    const out = applyCredits(bundle(5, 10), [credit('k1', 3)])
    expect(out.products![0].variants[0].stock).toBe(13)
  })
  it('is a no-op with no credits (same reference)', () => {
    const b = bundle(5, 10)
    expect(applyCredits(b, [])).toBe(b)
  })
  it('does not mutate the input bundle', () => {
    const b = bundle(5, 10)
    applyCredits(b, [credit('k1', 3)])
    expect(b.products![0].variants[0].stock).toBe(10)
  })
})

describe('retireByVersion', () => {
  it('drops credits whose ackVersion <= snapshot version', () => {
    const kept = retireByVersion([credit('k1', 3, 7), credit('k2', 1, null)], 7)
    expect(kept.map((c) => c.idempotencyKey)).toEqual(['k2'])
  })
  it('keeps un-acked and future-version credits', () => {
    const kept = retireByVersion([credit('k1', 3, 9)], 7)
    expect(kept).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `corepack pnpm --filter @mandalika/sync exec vitest run src/pendingCredits.test.ts` → FAIL.

- [ ] **Step 3: Implement pendingCredits.ts**

```ts
import type { components } from '@mandalika/api'
import type { KV } from './storage'
import { readJSON, writeJSON } from './storage'

type Bundle = components['schemas']['SyncPullBundle']

export interface CreditLine { productId: string; variantSize: string; qty: number }
export interface PendingCredit {
  idempotencyKey: string
  lines: CreditLine[]
  ackVersion: number | null // set when the receive acks; null while in flight
}

const KEY = 'mandalika.pos.pendingCredits'

/** Pure: fold credit deltas onto a bundle's per-variant stock. Returns the SAME
 *  reference when there are no credits; otherwise a shallow-cloned bundle (input
 *  is never mutated). */
export function applyCredits(bundle: Bundle, credits: PendingCredit[]): Bundle {
  if (!credits.length || !bundle.products) return bundle
  const delta = new Map<string, number>()
  for (const c of credits) {
    for (const l of c.lines) {
      const k = l.productId + '|' + l.variantSize
      delta.set(k, (delta.get(k) ?? 0) + l.qty)
    }
  }
  const products = bundle.products.map((p) => {
    let touched = false
    const variants = p.variants.map((v) => {
      const d = delta.get(p.id + '|' + v.size)
      if (!d) return v
      touched = true
      return { ...v, stock: v.stock + d }
    })
    return touched ? { ...p, variants } : p
  })
  return { ...bundle, products }
}

export function retireByVersion(credits: PendingCredit[], snapshotVersion: number): PendingCredit[] {
  return credits.filter((c) => c.ackVersion === null || c.ackVersion > snapshotVersion)
}

/** Persisted list of optimistic credits (survives restart + snapshot.replace). */
export class PendingCredits {
  constructor(private kv: KV) {}
  list(): PendingCredit[] { return readJSON<PendingCredit[]>(this.kv, KEY, []) }
  private save(v: PendingCredit[]): void { writeJSON(this.kv, KEY, v) }
  add(c: PendingCredit): void { this.save([...this.list(), c]) }
  stampAck(idempotencyKey: string, version: number): void {
    this.save(this.list().map((c) => c.idempotencyKey === idempotencyKey ? { ...c, ackVersion: version } : c))
  }
  remove(idempotencyKey: string): void {
    this.save(this.list().filter((c) => c.idempotencyKey !== idempotencyKey))
  }
  retire(snapshotVersion: number): void { this.save(retireByVersion(this.list(), snapshotVersion)) }
  isEmpty(): boolean { return this.list().length === 0 }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `corepack pnpm --filter @mandalika/sync exec vitest run src/pendingCredits.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/pendingCredits.ts packages/sync/src/pendingCredits.test.ts
git commit -m "feat(sync): SP3 — pending-credit store + pure applyCredits/retireByVersion + tests"
```

---

### Task D4: Outbox — add `transfer_receive` type

**Files:** Modify `packages/sync/src/outbox.ts`

- [ ] **Step 1: Extend the union**

```ts
export type OutboxType =
  | 'order'
  | 'refund'
  | 'shift_open'
  | 'shift_close'
  | 'cash_flow'
  | 'customer_create'
  | 'transfer_receive'
```

- [ ] **Step 2: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/sync exec tsc --noEmit
git add packages/sync/src/outbox.ts
git commit -m "feat(sync): SP3 — outbox transfer_receive type"
```

---

### Task D5: Engine — credited snapshot + reconcile arms + enqueueTransferReceive

**Files:** Modify `packages/sync/src/engine.ts`, `packages/sync/src/index.ts`

- [ ] **Step 1: Wire PendingCredits into the engine**

In `engine.ts` constructor, after `this.snapshot = new Snapshot(kv)`:
```ts
    this.pending = new PendingCredits(kv)
    this.recomputeCredited()
```
Add fields + import:
```ts
import { PendingCredits, applyCredits, type PendingCredit, type CreditLine } from './pendingCredits'
// ...
  readonly pending: PendingCredits
  private creditedView: Bundle | null = null
  private recomputeCredited(): void {
    const credits = this.pending.list()
    this.creditedView = credits.length ? applyCredits(this.snapshot.get(), credits) : null
  }
```

- [ ] **Step 2: Return the credited view from getSnapshot**

```ts
  getSnapshot(): Bundle {
    return this.creditedView ?? this.snapshot.get()
  }
```

- [ ] **Step 3: Re-apply + retire on resync**

In `resync()`, after `this.snapshot.replace(r.data)`:
```ts
    this.pending.retire(r.data.version ?? 0)
    this.recomputeCredited()
```

- [ ] **Step 4: Stamp ack + retire on flush**

In `flush()`, when an item acks (`res.status === 'ok' || 'duplicate'`), if it is a transfer_receive stamp its credit with the batch version. After the results loop, before returning, add:
```ts
    const ackVersion = r.data.version ?? 0
    for (const res of r.data.results) {
      if ((res.status === 'ok' || res.status === 'duplicate')) {
        this.pending.stampAck(res.idempotencyKey, ackVersion) // no-op if not a credit
      }
    }
    this.recomputeCredited()
```
(`stampAck` is a no-op for keys that aren't pending credits, so it's safe to call for every ack.)

- [ ] **Step 5: Rollback on dead-letter**

In `emitDeadLetters()`, before invoking the app callback, drop any pending credit for a dead-lettered transfer_receive and recompute:
```ts
    for (const i of fresh) {
      if (i.type === 'transfer_receive') this.pending.remove(i.idempotencyKey)
    }
    this.recomputeCredited()
```

- [ ] **Step 6: Add enqueueTransferReceive**

```ts
  /** Enqueue a POS transfer receive and optimistically credit the counted qty.
   *  PIN is validated by the caller (UI) before this; it is included in the
   *  payload for server re-validation and cleared when the item acks (prune). */
  enqueueTransferReceive(input: {
    transferId: string
    items: { productId: string; variantSize: string; receivedQty: number }[]
    discrepancyReason?: string
    approverUserId: string
    pin: string
  }): { idempotencyKey: string } {
    const { idempotencyKey } = this.enqueue('transfer_receive', {
      transferId: input.transferId,
      items: input.items,
      discrepancyReason: input.discrepancyReason ?? '',
      approverUserId: input.approverUserId,
      pin: input.pin,
    })
    const lines: CreditLine[] = input.items
      .filter((it) => it.receivedQty > 0)
      .map((it) => ({ productId: it.productId, variantSize: it.variantSize, qty: it.receivedQty }))
    const credit: PendingCredit = { idempotencyKey, lines, ackVersion: null }
    this.pending.add(credit)
    this.recomputeCredited()
    return { idempotencyKey }
  }
```

- [ ] **Step 7: Export new surface**

In `index.ts` add:
```ts
export { PendingCredits, applyCredits, retireByVersion } from './pendingCredits'
export type { PendingCredit, CreditLine } from './pendingCredits'
export { verifyPin } from './pin'
export { canAttempt, recordFailure, reset as resetLockout, MAX_PIN_ATTEMPTS, LOCKOUT_MS } from './lockout'
export type { Lockout } from './lockout'
```

- [ ] **Step 8: Typecheck + run all sync tests**

```bash
corepack pnpm --filter @mandalika/sync exec tsc --noEmit
corepack pnpm --filter @mandalika/sync exec vitest run
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add packages/sync/src/engine.ts packages/sync/src/index.ts
git commit -m "feat(sync): SP3 — credited snapshot view + reconcile (ack/retire/rollback) + enqueueTransferReceive"
```

---

# Phase E — POS UI

### Task E1: Receive types + inbound selectors

**Files:** Create `apps/pos/src/cashier/receive/receiveTypes.ts`

- [ ] **Step 1: Add typed helpers off the snapshot**

```ts
import type { components } from '@mandalika/api'

export type Transfer = components['schemas']['Transfer']
export type ReceiveApprover = components['schemas']['ReceiveApprover']
export type TransferItem = components['schemas']['TransferItem']

/** In-transit transfers carried in the snapshot (already dest-scoped server-side). */
export function inboundTransfers(bundle: components['schemas']['SyncPullBundle']): Transfer[] {
  return (bundle.transfers ?? []).filter((t) => t.status === 'in_transit')
}
export function receiveApprovers(bundle: components['schemas']['SyncPullBundle']): ReceiveApprover[] {
  return bundle.receiveApprovers ?? []
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
git add apps/pos/src/cashier/receive/receiveTypes.ts
git commit -m "feat(pos): SP3 — receive snapshot selectors/types"
```

---

### Task E2: PIN step-up modal

**Files:** Create `apps/pos/src/cashier/receive/PinStepUpModal.tsx`

- [ ] **Step 1: Implement the modal**

```tsx
import { useMemo, useState } from 'react'
import { verifyPin, canAttempt, recordFailure, reset as resetLockout, type Lockout } from '@mandalika/sync'
import type { ReceiveApprover } from './receiveTypes'

const LOCKOUT_KEY = 'mandalika.pos.pinLockout'
function loadLockout(): Lockout {
  try { return JSON.parse(localStorage.getItem(LOCKOUT_KEY) ?? '') as Lockout } catch { return resetLockout() }
}
function saveLockout(s: Lockout): void { localStorage.setItem(LOCKOUT_KEY, JSON.stringify(s)) }

interface Props {
  approvers: ReceiveApprover[]
  onCancel: () => void
  onApproved: (approverUserId: string, pin: string) => void
}

export function PinStepUpModal({ approvers, onCancel, onApproved }: Props) {
  const [approverId, setApproverId] = useState(approvers[0]?.userId ?? '')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lock, setLock] = useState<Lockout>(loadLockout)
  const approver = useMemo(() => approvers.find((a) => a.userId === approverId), [approvers, approverId])

  if (approvers.length === 0) {
    return (
      <Backdrop onCancel={onCancel}>
        <p className="text-center text-sm text-warm-600">
          Belum ada penyetuju ber-PIN untuk outlet ini. Hubungi admin.
        </p>
      </Backdrop>
    )
  }

  const submit = async () => {
    const gate = canAttempt(lock, Date.now())
    if (!gate.allowed) {
      setErr(`Terkunci. Coba lagi dalam ${Math.ceil(gate.remainingMs / 1000)}s`)
      return
    }
    if (!approver) { setErr('Pilih penyetuju'); return }
    setBusy(true); setErr(null)
    const ok = await verifyPin(pin, approver.receivePinHash)
    setBusy(false)
    if (!ok) {
      const next = recordFailure(lock, Date.now()); setLock(next); saveLockout(next)
      setErr('PIN salah'); setPin('')
      return
    }
    const cleared = resetLockout(); setLock(cleared); saveLockout(cleared)
    onApproved(approver.userId, pin)
  }

  return (
    <Backdrop onCancel={onCancel}>
      <h3 className="text-lg font-semibold">Persetujuan penerimaan</h3>
      <label className="mt-3 block text-sm">Penyetuju</label>
      <select className="mt-1 w-full rounded-lg border p-2"
        value={approverId} onChange={(e) => setApproverId(e.target.value)}>
        {approvers.map((a) => <option key={a.userId} value={a.userId}>{a.displayName}</option>)}
      </select>
      <label className="mt-3 block text-sm">PIN</label>
      <input className="mt-1 w-full rounded-lg border p-3 text-center text-2xl tracking-[0.5em]"
        inputMode="numeric" type="password" maxLength={8} value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoFocus />
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-4 flex gap-2">
        <button className="flex-1 rounded-lg border p-3" onClick={onCancel}>Batal</button>
        <button className="flex-1 rounded-lg bg-gold-600 p-3 text-white disabled:opacity-50"
          disabled={busy || pin.length < 4} onClick={() => void submit()}>
          {busy ? 'Memeriksa…' : 'Setujui'}
        </button>
      </div>
    </Backdrop>
  )
}

function Backdrop({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
```
(Match the POS's actual color tokens/classes — `gold-*`, `warm-*` — and any shared modal primitive if one exists in `apps/pos/src/components`. Keep the numeric keypad as a styled `inputMode="numeric"` field; a custom on-screen keypad is optional polish.)

- [ ] **Step 2: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
git add apps/pos/src/cashier/receive/PinStepUpModal.tsx
git commit -m "feat(pos): SP3 — manager step-up PIN modal (on-device verify + lockout)"
```

---

### Task E3: Receive panel (inbound list + informed count)

**Files:** Create `apps/pos/src/cashier/receive/ReceiveTransferPanel.tsx`

- [ ] **Step 1: Implement the panel**

```tsx
import { useMemo, useState } from 'react'
import type { Transfer, TransferItem } from './receiveTypes'

interface Props {
  transfers: Transfer[]
  onClose: () => void
  onConfirm: (transferId: string, items: { productId: string; variantSize: string; receivedQty: number }[], discrepancyReason: string) => void
}

const lineKey = (pid: string, size: string) => `${pid}|${size}`

export function ReceiveTransferPanel({ transfers, onClose, onConfirm }: Props) {
  const [selected, setSelected] = useState<Transfer | null>(null)
  if (!selected) {
    return (
      <Panel title="Terima Transfer" onClose={onClose}>
        {transfers.length === 0 ? (
          <p className="p-4 text-center text-sm text-warm-600">Tidak ada transfer masuk.</p>
        ) : transfers.map((t) => (
          <button key={t.id} className="flex w-full items-center justify-between border-b p-4 text-left"
            onClick={() => setSelected(t)}>
            <div>
              <div className="font-medium">{t.transferNo}</div>
              <div className="text-sm text-warm-600">Dari {t.source.name ?? '—'} · {t.items.length} item</div>
            </div>
            <span className="text-gold-600">Terima →</span>
          </button>
        ))}
      </Panel>
    )
  }
  return <ReceiveForm transfer={selected} onBack={() => setSelected(null)} onConfirm={onConfirm} />
}

function ReceiveForm({ transfer, onBack, onConfirm }: {
  transfer: Transfer
  onBack: () => void
  onConfirm: Props['onConfirm']
}) {
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(transfer.items.map((it) => [lineKey(it.productId, it.variantSize), String(it.sentQty)])))
  const [reason, setReason] = useState('')

  const anyDiff = useMemo(() => transfer.items.some((it) => {
    const v = Number(qty[lineKey(it.productId, it.variantSize)] ?? it.sentQty)
    return v !== it.sentQty
  }), [qty, transfer.items])

  const confirm = () => {
    if (anyDiff && !reason.trim()) return
    const items = transfer.items.map((it) => {
      const n = Number(qty[lineKey(it.productId, it.variantSize)] ?? it.sentQty)
      return { productId: it.productId, variantSize: it.variantSize, receivedQty: Number.isFinite(n) && n >= 0 ? n : 0 }
    })
    onConfirm(transfer.id, items, reason.trim())
  }

  return (
    <Panel title={`Terima ${transfer.transferNo}`} onClose={onBack}>
      {transfer.items.map((it: TransferItem) => {
        const k = lineKey(it.productId, it.variantSize)
        const v = Number(qty[k] ?? it.sentQty)
        const diff = v - it.sentQty
        return (
          <div key={k} className="flex items-center justify-between gap-3 border-b p-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{it.productName}</div>
              <div className="text-sm text-warm-600">{it.variantSize} · dikirim {it.sentQty}</div>
            </div>
            <div className="text-right">
              <input className="w-20 rounded-lg border p-2 text-center" inputMode="numeric" value={qty[k] ?? ''}
                onChange={(e) => setQty((s) => ({ ...s, [k]: e.target.value.replace(/\D/g, '') }))} />
              {diff !== 0 && <div className={`text-xs ${diff < 0 ? 'text-red-600' : 'text-amber-600'}`}>Selisih {diff > 0 ? '+' : ''}{diff}</div>}
            </div>
          </div>
        )
      })}
      {anyDiff && (
        <div className="p-3">
          <label className="block text-sm">Alasan selisih (wajib)</label>
          <textarea className="mt-1 w-full rounded-lg border p-2" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <div className="p-3">
        <button className="w-full rounded-lg bg-gold-600 p-3 text-white disabled:opacity-50"
          disabled={anyDiff && !reason.trim()} onClick={confirm}>Terima</button>
      </div>
    </Panel>
  )
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-white">
      <header className="flex items-center justify-between border-b p-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button onClick={onClose} aria-label="Tutup" className="text-2xl">×</button>
      </header>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}
```
Note: `onConfirm` here hands the counted lines up to `CashierScreen`, which opens the PIN modal then calls `engine.enqueueTransferReceive`. The panel does NOT verify the PIN itself (separation: count vs approve).

- [ ] **Step 2: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/pos exec tsc --noEmit
git add apps/pos/src/cashier/receive/ReceiveTransferPanel.tsx
git commit -m "feat(pos): SP3 — receive panel (inbound list + informed count + discrepancy reason)"
```

---

### Task E4: Wire menu item, panel, enqueue, and rollback notice

**Files:** Modify `apps/pos/src/cashier/MenuDrawer.tsx`, `apps/pos/src/cashier/CashierScreen.tsx`, `apps/pos/src/cashier/SyncProvider.tsx`

- [ ] **Step 1: MenuDrawer — add the item + badge**

Add to `MenuDrawer` props: `onReceiveTransfer: () => void; inboundCount: number`. In `opItems` add (after Riwayat or near Sinkronkan):
```tsx
{ Icon: BoxInIcon ?? BagIcon, label: 'Terima Transfer', badge: inboundCount > 0, onClick: () => { onClose(); onReceiveTransfer() } },
```
(Use an existing icon if no inbound icon exists. `badge` already renders the "Baru" dot per the existing `Item` type.)

- [ ] **Step 2: CashierScreen — panel state + counts**

Add state + derive inbound from the (credited) snapshot:
```tsx
const [showReceive, setShowReceive] = useState(false)
const [pendingReceive, setPendingReceive] = useState<null | {
  transferId: string; items: { productId: string; variantSize: string; receivedQty: number }[]; reason: string
}>(null)
const snapshot = engine.getSnapshot()
const inbound = inboundTransfers(snapshot)        // from receiveTypes
const approvers = receiveApprovers(snapshot)
```
Pass `onReceiveTransfer={() => setShowReceive(true)}` and `inboundCount={inbound.length}` to `MenuDrawer`.

- [ ] **Step 3: CashierScreen — render panel + PIN modal + enqueue**

```tsx
{showReceive && (
  <ReceiveTransferPanel
    transfers={inbound}
    onClose={() => setShowReceive(false)}
    onConfirm={(transferId, items, reason) => {
      setShowReceive(false)
      setPendingReceive({ transferId, items, reason })
    }}
  />
)}
{pendingReceive && (
  <PinStepUpModal
    approvers={approvers}
    onCancel={() => setPendingReceive(null)}
    onApproved={(approverUserId, pin) => {
      engine.enqueueTransferReceive({
        transferId: pendingReceive.transferId,
        items: pendingReceive.items,
        discrepancyReason: pendingReceive.reason,
        approverUserId,
        pin,
      })
      setPendingReceive(null)
      showToast('Diterima — akan disinkronkan')
    }}
  />
)}
```
Add the imports (`ReceiveTransferPanel`, `PinStepUpModal`, `inboundTransfers`, `receiveApprovers`).

- [ ] **Step 4: SyncProvider — rollback notice on dead-lettered receive**

In the `onDeadLetter` handler, detect `transfer_receive` and surface a user-facing notice (in addition to the existing error report). Add an app-level toast/banner mechanism the provider can call (e.g. a context callback `onReceiveRejected?: (msg: string) => void` wired down to `showToast`), and:
```tsx
const hadReceiveReject = items.some((i) => i.type === 'transfer_receive')
// ...existing reportErrors(...)
if (hadReceiveReject) onReceiveRejectedRef.current?.('Penerimaan dibatalkan — transfer mungkin sudah diterima atau PIN ditolak. Stok dikembalikan.')
```
The engine already removed the optimistic credit (Task D5, Step 5); this is only the human notice. Wire `onReceiveRejected` from `CashierScreen` into `showToast`.

- [ ] **Step 5: Typecheck**

Run: `corepack pnpm --filter @mandalika/pos exec tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/pos/src/cashier/MenuDrawer.tsx apps/pos/src/cashier/CashierScreen.tsx apps/pos/src/cashier/SyncProvider.tsx
git commit -m "feat(pos): SP3 — Terima Transfer menu/badge, receive→PIN→enqueue flow, rollback notice"
```

---

### Task E5: Backoffice override labeling (outlet-dest receive)

**Files:** Modify `apps/backoffice/src/screens/transfers/ReceiveModal.tsx`

- [ ] **Step 1: Label the receive as an override for outlet destinations**

For an `in_transit` transfer whose `dest.kind === 'outlet'`, show a caption in the modal: "Penerimaan paksa (tanpa hitung di POS) — gunakan hanya jika perangkat POS bermasalah." The action still calls the existing `api.receiveTransfer(...)` (which the backend now stamps `received_via='backoffice'`). No new endpoint. Warehouse-dest receives are unchanged.

- [ ] **Step 2: Typecheck + commit**

```bash
corepack pnpm --filter @mandalika/backoffice exec tsc --noEmit
git add apps/backoffice/src/screens/transfers/ReceiveModal.tsx
git commit -m "feat(backoffice): SP3 — frame outlet-dest receive as POS-override safety valve"
```

---

### Task E6: Build APK + live device/Playwright verification

- [ ] **Step 1: Dispatch the signed APK build**

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Epheyy/mandalika-pos/actions/workflows/android-release.yml/dispatches \
  -d '{"ref":"prod-hardening","inputs":{"api_url":"https://mandalika-pos-538849926142.asia-southeast2.run.app"}}'
```
Poll the run for the `mandalika-pos-release-apk` artifact.

- [ ] **Step 2: Verify the end-to-end flow (device or Playwright on pages.dev + APK)**

- Backoffice: send a transfer to the cashier's outlet; set approver roles + a manager PIN.
- POS: "Terima Transfer" badge shows; open → informed count (change one line) → reason required → PIN modal → correct PIN → toast; **received stock immediately sellable** (optimistic credit visible).
- Wrong PIN → error + lockout after 5 tries.
- Go offline, receive, reconnect → flush → resync → stock reflects credit **once** (no double count), badge clears, `transfers.received_via='pos'` + `received_by` set.
- Backoffice force-receive on a separate stuck transfer → if POS had an optimistic credit for it, it dead-letters with the rollback notice.
- **Report results honestly (rule 4 & 6): what passed, what is still USER-PENDING on a physical device.**

- [ ] **Step 3: Commit any fixes; update SESSION_HANDOFF.md + memory**

```bash
git add -A
git commit -m "docs: SP3 done & verified — POS receiving + PIN (handoff + memory update)"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §2 data model → A1 (PIN cols, transfer attribution+idempotency, approver-roles col). ✓
- §3 bundle (transfers + receiveApprovers, scoped) → B1–B3, A4. ✓
- §4 informed-count receive UX → E3. ✓
- §5 approval mechanics (per-user PIN, on-device + server re-validate, payload) → D1/E2 (on-device) + C3 (server). ✓
- §6 optimistic credit + 3-arm reconciliation → D3/D5 (apply, retire arm A, rollback arm B; arm C = credit persists until A/B). ✓
- §7 backoffice (Users PIN, approver-roles, override) → A6, A7, E5. ✓
- Security (argon2id reuse, scoped hashes, server authority, lockout) → A3/A4 (scope), C3 (authority), D1/D2 (verify+lockout). ✓
- §8 testing (Go table-tests + Vitest pure + live) → C2, D1–D3, E6. ✓

**Placeholder scan:** Pure-function code is complete; backend wiring shows exact snippets + the few "confirm the exact field name" notes are genuine integration checks against generated code, not deferred work. UI components are concrete (token/primitive matching flagged as the only adaptation).

**Type consistency:** `enqueueTransferReceive` payload (`transferId`,`items[{productId,variantSize,receivedQty}]`,`discrepancyReason`,`approverUserId`,`pin`) matches the Go `transferReceivePayload` (C3) and the outbox `transfer_receive` type (D4). `PendingCredit{idempotencyKey,lines,ackVersion}` is consistent across D3/D5. `ReceiveMeta{ReceivedBy,ReceivedVia,IdempotencyKey}` consistent C1/C3. `ReceiveApprover{userId,displayName,receivePinHash}` consistent A2/A4/B/E2.

**Known integration risks (flagged, not gaps):**
1. **hash-wasm ↔ Go PHC compat** (D1) — front-loaded as a spike; fallback documented.
2. **Sync `Engine` field names** for the write/read repos (`e.Write`/`e.Read` vs other) — verify in C3 against the real struct.
3. **`listJSON` arity** (B2) — match the existing helper's return signature.
4. **POS color tokens / shared modal primitive** — match existing POS conventions in E2/E3.
