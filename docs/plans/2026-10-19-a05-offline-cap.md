# A05: 12 h offline cap and promo/loyalty clock-skew bound (plan)

Date 2026-10-19 · base `prod-hardening` 838517c · planner: Opus (read-only), saved by the main session.

## 0. Policy (owner, binding)

From HANDOFF "Decisions (owner)", 2026-10-17 item 1:
- Offline sales are allowed until shift close, capped at 12 h after the tablet's last successful online contact. The server decides on the next sync.
- A new shift still needs online authentication.
- A revoked credential must be told apart from an outage. An outage must not clear the session.
- An event refused for exceeding the cap becomes a visible review item ("Tinjauan Sinkron", head office resolves). It is never dropped.
- This slice also owns the promo/loyalty clock-skew bound that A28 deferred.

## 1. Already done vs still open (checked against source)

| A05 item | Status | Evidence |
|---|---|---|
| getKV() captured at module load | Done | `apps/pos/src/authBoot.ts` resolves `getKV()` at call time; `main.tsx` awaits `bootStorage()` |
| Boot clears the session on any refresh error | Done | `authBoot.ts` `classifyRefreshFailure`: only HTTP 401 = rejected |
| Server refresh contract | Done (A33/A07) | `backend/internal/auth/handlers.go:213-241`: 401 only invalid/revoked; DB failure 503 |
| Runtime silent refresh: revoked vs outage | **OPEN** | `packages/api/src/client.ts:434` `if (!res.ok) return 'rejected'`: any 400/403/404/407 logs the tablet out; a 200 without `access` (`:437`) also counts as rejected |
| Resume authorised shift after offline reboot | Done | `useShift.ts` per-outlet `readShiftCache` |
| New shift needs online | Done | `useShift.ts:138`, `OFFLINE_OPEN_MESSAGE` |
| Sales need an open shift | Done | `CashierScreen.tsx:300` `ensureShift()` |
| Shift-bounded offline lease / time cap | **OPEN** | nothing records last contact; envelope (`engine.ts:474-488`, `attribute.go` `Envelope`) carries no evidence; server has no cap |
| Promo clock skew (from A28) | **OPEN** | `service/order.go:226-229` `saleTime = ClientCreated`, unbounded; `/sync/loyalty-preview` (`handlers/writes.go:1066`) trusts the client time. Direct `POST /orders` already uses server time |
| Review mechanism for refused events | Exists | non-retryable known code goes to review (`engine.ts:92-95`, `:1030`), backoffice `screens/syncReview/` |

So A05 = (a) the 12 h cap end to end, (b) the skew bound, (c) the one-line runtime-refresh fix.

## 2. Design

### 2.1 "Last successful online contact"
- A 2xx answer to the authenticated `GET /api/v1/sync/version` (polled every 20 s and on `online`, `engine.ts:1135-1164`). A 2xx from `resync()` (`/sync/pull`) also counts. 401/403/5xx/timeout/network failure is NOT a contact. `checkVersion` sets `reachable=true` on a 4xx (`engine.ts:444-448`): do not reuse that flag.
- Server-signed contact: `/sync/version?deviceId=<uuid>` additionally returns `contact: { at, sig }`. `at` = server time RFC3339 stored verbatim. `sig = base64url(HMAC-SHA256(k, "v1|"+deviceId+"|"+at))`, `k = HMAC-SHA256(cfg.AccessSecret, "mandalika/offline-contact/v1")` (no new env var). A client cannot mint a later contact. Rotating `JWT_ACCESS_SECRET` makes old tokens unverifiable; server falls back to the elapsed-only rule (safe; note in RUNBOOK).
- Tablet storage: key `mandalika.pos.offlineContact` in the engine `kv` (Capacitor Preferences on native: survives reboot, excluded from Android backup, no journal change). Value `{v:1, deviceAt:number(ms), at?:string, sig?:string, highWater:number(ms)}`. Memory on every contact, persisted at most every 60 s plus immediately on the first contact after an offline period (a lost write only makes the window look older: fails closed). Without a server token (old server / pull path) store `{deviceAt}` only.
- Elapsed evidence: `offlineMs = max(Date.now(), highWater) - deviceAt`; `highWater = max(persisted highWater, newest outbox capturedAt, now)`, persisted on the same throttle, reset to now on each contact. Clock set back: highWater stops elapsed from shrinking. Clock set forward: blocks early, next contact fixes it. Not used: `performance.now()` (resets per process, stops in deep sleep). Not available: `SystemClock.elapsedRealtime` (native, needs APK).
- Residual risk: clock set back while the tablet is powered off after its last persist cannot be seen without native code. Server backstop: signed L plus arrival time catch it when the batch arrives within 12 h of L; unreconcilable evidence is logged. Owner action: lock date/time settings on tablets (kiosk/MDM).

### 2.2 Client behaviour
Pure function in `packages/sync/src/offlineContact.ts`: `offlineCapState(nowMs, record, newestCaptureMs)` returns `unknown` (no record, e.g. OTA-installed while offline: no block, server decides) | `ok` | `warn` (from 10 h) | `locked` (from 12 h).

At `locked`, block new sales, refunds and cash in/out. Gate points: add-to-cart (next to `ensureShift`), checkout confirm (`CashierScreen.tsx` before `saleGate.current.run`, because a cart built at 11h59 can be confirmed at 12h01), refund submit (`CashierScreen.tsx:~807`), cash_flow in `SettingsScreen.tsx:156`. Do NOT throw from `engine.enqueue` (durableSubmit would show a false "tidak tersimpan"). Shift close stays allowed.

Messages (constants in new `apps/pos/src/lib/offlineCap.ts`):
- locked: "Tablet sudah offline lebih dari 12 jam. Penjualan, refund, dan kas masuk/keluar dikunci sampai tablet tersambung ke internet. Transaksi yang sudah tercatat tetap aman dan akan dikirim otomatis."
- warn (SyncStatus chip): "Tablet offline {n} jam. Sambungkan internet sebelum 12 jam agar penjualan tidak terkunci."

Every new outbox item gets the evidence in its envelope, stamped in `captureEnvelope` at commit time. Envelope `v` stays 1.

### 2.3 Server rule on /sync/batch
New file `backend/internal/sync/offlinecap.go`, pure function of (item type, envelope, arrival time A = `e.now()`, key). Constants `OfflineCap = 12h`, `ClockTolerance = 5m`.

```
capped types: order, refund, cash_flow
exempt:       shift_open, shift_close (drawer must always close)
              customer_create (a refused customer traps its order in a 23503 retry loop)
              transfer_receive (A08 makes it online-only)
no evidence (no offlineMs and no contact) -> accept, slog.Info "no offline evidence" (old bundles)
L ok := sig verifies for env.deviceId AND L <= A + tol
if L ok && A - L <= cap + tol             -> accept (fast path, independent of device clock)
E := max(offlineMs, capturedAt - contactDeviceAt)   (whichever present)
if E > cap + tol                          -> refuse: offline_expired (non-retryable -> review)
if E < -tol || (L ok && L + E > A + tol)  -> accept + slog.Warn "offline evidence inconsistent"
else                                      -> accept
```
- Placement: `processOneWithCommands` (`sync.go:330-345`), right after `attribute()`, before the type switch.
- Replay first: generalise the existing `code == apperr.ActorMismatch` replay probe to also cover `apperr.OfflineExpired`, so a key that already landed replays as ok/duplicate and never goes to review.
- Refusal message: "Transaksi dicatat lebih dari 12 jam setelah tablet terakhir online sehingga tidak diproses otomatis. Data tetap tersimpan dan ditinjau kantor pusat. Jangan input ulang."
- Every batch sale is `Offline:true` (`sync.go:388`); items captured while online carry `offlineMs` of about 20 s and never hit the cap. Direct online routes use server time.

### 2.4 Promo/loyalty clock-skew rule
- Never change stored `client_created_at` (recorded fact); only the evaluation time changes.
- Sync order branch computes `EvalTime` and `ClockSkew` with C = payload `clientCreatedAt`:
  - L verified: if C outside `[L - tol, A + tol]`, `EvalTime = clamp(L + E, L, A)` (or `clamp(C, L, A)` when E unknown), `ClockSkew = true`.
  - L not verified (old bundle/server): if `C > A + tol`, `EvalTime = A`, `ClockSkew = true`. No lower bound (late syncs are legitimate).
- `service/order.go`: `saleTime = EvalTime ?? ClientCreated ?? now`; promo and loyalty share the hoisted `saleTime`. If `ClockSkew` and any promo/code applied, append new `ViolationClockSkew = "clock_skew"` (`promo_validate.go`) to `discountWarnReason` (offline accept-and-flag convention: discount kept, warning badge, `Orders.tsx:235` tooltip). Failing a promo rule at the corrected time follows the existing flag path.
- `/sync/loyalty-preview` (`writes.go:1066`): use `ClientCreatedAt` only if within ±tol of server now, else server now.

### 2.5 Runtime refresh fix
`client.ts` `trySilentRefresh`: only 401 returns `'rejected'`; any other non-OK status returns `ApiError(status)` (no verdict, session kept); a 200 without `access` returns `ApiError(0, ..., 'invalid_response')`. Matches boot `classifyRefreshFailure`.

## 3. Wire, OpenAPI, codegen, migration, PG gate
`backend/api/openapi.yaml`:
- New schema `OfflineContact {at: date-time, sig: string}` (both required).
- `SyncVersion.contact`: optional `$ref OfflineContact`, NOT nullable ($ref+nullable codegen gotcha).
- `GET /sync/version`: optional query `deviceId` (uuid); missing/invalid means no `contact`.
- `SyncEnvelope` gains optional `contact` ($ref), `contactDeviceAt` (int64 device ms), `offlineMs` (int64 >= 0). `v` stays 1 (`attribute.go:198` rejects other v; bumping would make a rolled-back server refuse everything).
- `SyncItemResult.code` enum gains `offline_expired`.

Go: `apperr.OfflineExpired`; `attribute.go` `Envelope` gains `Contact *contactToken`, `ContactDeviceAt *int64`, `OfflineMs *int64`; `sync.Engine.ContactKey []byte` wired in `server/server.go:81`.
Codegens: `make gen-go` (backend) and `corepack pnpm --filter @mandalika/api gen`, then `corepack pnpm gen:check` and `go run ./cmd/codegen -check`.
Migration: NONE (0061 stays free, 0057 reserved for A15 Phase B).
PG gate: new `("OC", "TestOfflineCapPostgres", 56463, "oc")` in `scripts/ci/postgres_gate.py` GATES.
Old-server tolerance: `attribute.go` uses plain `json.Unmarshal` (unknown keys ignored), `batch_envelope.go` keeps the envelope opaque, A11 fingerprint covers payload only (`engine.ts:889`).

## 4. Rollout and compatibility
1. Backend deploy (additive, no migration), after 0058-0060, tablets at 0 pending.
2. POS via OTA (`make ota-release`), web layer only.
3. Backoffice review label ships with the first non-skip push.

| Combination | Behaviour |
|---|---|
| Old bundle -> new server | No evidence: accepted and logged, never `offline_expired`; future-time bound (unverified branch) still applies to promos |
| New bundle -> old server | Extra keys and `?deviceId` ignored; unsigned contacts; soft-block works; server never refuses |
| New bundle, no contact yet | `unknown`: no block, no evidence, accepted |
| Old bundle meets `offline_expired` | Cannot happen; unknown code is parked by attempt counting, never dropped |

## 5. Test plan
Go unit: `sync/contact_test.go` (sign/verify; wrong device, tampered at, wrong key, future at fail); `sync/offlinecap_test.go` (every branch of 2.3); sync-level replay test with a fake lookup (style of `refund_permission_test.go`); `attribute_test.go` (new + unknown keys attribute); pure `boundSaleTime` table; handler tests for `/sync/version` with/without `deviceId` and preview clamp.
TS unit: `packages/sync/src/offlineContact.test.ts` (states, clock back clamps to highWater, clock forward inflates, contact resets highWater, persist throttle); `engine.offline-evidence.test.ts` (envelope carries evidence; 2xx checkVersion records signed contact; 4xx/5xx/network do not; resync records unsigned; old server no contact); `engine.error-codes.test.ts` (`offline_expired` goes to review); `apps/pos/src/lib/apiClient.errors.test.ts` (refresh 400/403/404/407 and 200-without-access keep session; 401 logs out); `apps/pos/src/lib/offlineCap.test.ts`, `SyncStatus` test, `reviewLabels.test.ts`.
PG gate OC (56463) in `backend/internal/handlers/offline_cap_integration_test.go` via `ProcessBatch`: (1) order over cap refused `offline_expired`, non-retryable, no order/stock/processed_keys row; (2) A-L <= 12h ok; (3) refund and cash_flow over cap refused, refunded order stays completed; (4) shift_close and customer_create over cap ok; (5) key applied within cap re-sent later = duplicate; (6) skew: promo with active hours, C inside hours but L+E outside: `discount_warning_reason` contains clock_skew,outside_hours, `client_created_at` equals C; (7) extra case in `capture_envelope_integration_test.go`: envelope with unknown extra keys accepted.
Browser gate: no scenario change expected (`tests/browser/pos-scenarios.ts:36` mock of `/sync/version` returns no contact).
Final gates (merger re-runs): full PG gate, `quality:ci`, `browser:ci`, `gen:check`, `go test -race ./...`, gofmt-clean.

## 6. Ordered TDD tasks (Sonnet implementer, worktree off prod-hardening)
- T1 Contract: openapi.yaml, apperr.go, generated `api.gen.go` + `schema.d.ts`. Verify both codegens, gen:check, `go build ./...`, `corepack pnpm -r typecheck`.
- T2 Contact token: new `sync/contact.go` + test; Engine field; `server/server.go` key derivation; `handlers/writes.go` SyncVersion adds `contact` when `deviceId` parses as uuid. Test first.
- T3 Cap verdict: new `sync/offlinecap.go` + test; `attribute.go` Envelope fields; `sync.go:330-345` placement + replay-probe generalisation.
- T4 Skew bound: `sync/sync.go` order branch (EvalTime/ClockSkew); `service/order.go` `CreateOrderInput` (+2 fields) and `saleTime`; `service/promo_validate.go` `ViolationClockSkew`; `handlers/writes.go:1066` preview clamp. Check `apps/pos/src/cashier/promoParity.test.ts` and `promoValidate.ts` first: the code is server-only and must not break parity lists.
- T5 PG gate: new `offline_cap_integration_test.go`; `scripts/ci/postgres_gate.py` OC 56463; EV case.
- T6 Client evidence: new `packages/sync/src/offlineContact.ts` + test; `engine.ts` (`checkVersion` adds `?deviceId=` and records contact on 2xx only; `resync` records unsigned contact; `captureEnvelope` stamps contact/contactDeviceAt/offlineMs; public `offlineState()`; `KNOWN_ERROR_CODES` += `offline_expired`); `packages/sync/src/index.ts` exports; `engine.offline-evidence.test.ts`.
- T7 Runtime refresh: `packages/api/src/client.ts:431-437`; tests in `apps/pos/src/lib/apiClient.errors.test.ts`.
- T8 POS soft-block UI: new `apps/pos/src/lib/offlineCap.ts` + test; `cashier/CashierScreen.tsx` (add-to-cart, checkout confirm, refund); `screens/SettingsScreen.tsx` (cash_flow); `components/SyncStatus.tsx` + test (warn chip).
- T9 Backoffice label: `apps/backoffice/src/screens/syncReview/reviewLabels.ts` `offline_expired: 'Offline lebih dari 12 jam'` + filter entry + test.
- T10 Docs: HANDOFF board + release additions, tracker, sweep, release note ("backend before OTA; owner: lock tablet date/time settings").

## 7. Not in scope
Native monotonic/boot clock (needs APK) or forced APK; approve-and-apply for refused events (head office only marks handled); a "suspect clock" order badge/column (would need migration 0061; logs only); server-side per-device last-seen history; changing stored `client_created_at` or `business_date`; transfer-receive authority (A08); a cutoff for evidence-less items; device revocation; A27 T7.

## 8. Owner questions (each with a default)
1. A refused over-cap sale is not in revenue, stock or the shift recap; head office can only mark it handled and re-enter by hand, so the drawer shows a variance for that shift. Recommendation: keep "refuse -> review". Alternative: accept-and-flag.
2. Capped types: sales, refunds, cash in/out. Shift open/close and new customers exempt; transfer receive left to A08.
3. Owner action (not a question): lock date/time settings on the tablets.

## 9. Risks to watch in review
- Replay probe must run before any `offline_expired` refusal.
- `v` must stay 1.
- Contact recorded only on 2xx, never on the 4xx "reachable" path.
- Checkout gate must sit at confirm, not only add-to-cart.
- `ClockSkew` only adds a flag and never drops a discount.
- Rotating the JWT access secret silently disables the fast path (safe; RUNBOOK note).

## 10. Decisions
Owner questions 1-2 take the defaults (refuse -> review; capped types as listed); question 3 is an owner action (recorded in HANDOFF release additions).
