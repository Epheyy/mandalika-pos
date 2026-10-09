# P0 remediation plan (A01–A13) — 2026-10-10

Planner: Opus (high), read-only. Citations are to `prod-hardening` @ `ebceb46` unless
marked "audit". Spot-checked by the main session: A13 `transfer.go:98-103` (no `FOR UPDATE`),
A06 `server.go:140` (`/sync/batch` has no `process_refund`), A11 `service/shift.go:127-136`
(cash flow inserted without a key). Status of decisions: **pending owner answers** (§4).

## 0. Branch facts

- `prod-hardening` is a strict ancestor of `audit/hosted-proof-20260922`: merging is a
  fast-forward. Nearly all app code changes are in one squashed commit `e957154`; the rest
  are dependency bumps, CI gates and the oapi-codegen 2.7 regeneration (`e295775`).
- No DB migrations on the audit branch. Go bumps: pgx 5.9, x/crypto 0.56, kin-openapi 0.149,
  oapi-codegen 2.7. Backoffice: vendored xlsx tarball, vite ^8.0.16.
- Audit-branch CI: backend + PostgreSQL gates pass; **Chromium browser gate red since
  2026-10-09** (last green 2026-09-25 on `0478648`, cause not yet known); dependency-security
  reports 26 blockers. The audit `android-release.yml` needs the browser gate, so merging
  as-is blocks APK builds.
- The PostgreSQL concurrency harness (`scripts/ci/postgres_gate.py`) exists only on the audit
  branch; each new concurrency test needs a fixture row there.

## 1. Per-finding status

| ID | Risk (plain) | Audit branch already did | Remaining | Size |
|---|---|---|---|---|
| A01 | "Sale complete" shown before a durable write; quota errors swallowed; corrupt JSON → empty queue (`packages/sync/src/storage.ts:19-45,85,96-99`, `outbox.ts:42-63`, `CashierScreen.tsx:815`) | Nothing | Awaited fail-loud writes + quarantine; then approved SQLite journal | L |
| A02 | 5 transport failures park sales/refunds; "export log" deletes them (`engine.ts:257-278,347-360`, `outbox.ts:33,69-84,125-133`) | Partial: delete path removed, diagnostics export is read-only | Transport failures never count as attempts; explicit pending / needs-review states | M |
| A03 | Any transfer-receive error drops the stock credit and the receive (`engine.ts:320-325`, `sync.go:142-150,324-361`) | Nothing | Stable server error codes; retry transient; competing receipt → review with quantities kept | S–M |
| A04 | Queued events attributed to whoever/wherever is active at flush time (`engine.ts:171-185`, `sync.go:194-202,257-260,291-294`, `middleware.go:28-38`) | Nothing | Containment: capture-time envelope (outlet/user/shift), mismatch → review, remove POS outlet switch + logout. Full: device registration | M / L |
| A06 | Refund permission bypassed via `/sync/batch`; no reason check (`server.go:129-140`, `sync.go:236-248`) | Partial: batch refund now requires `process_refund` | Reason parity, POS UI gate, denied refund → review (not park), parity test table | S |
| A09 | Negative quantity adds stock; cash shortfall silently balanced (`order.go:109-115,324,350-359`) | Partial: line validation (`service/order_input.go`) | Tender rules (cash sufficiency, keep captured non-cash amount + flag), discount permission | M |
| A11 | Retries re-apply writes: duplicate cash flow, shift-open failures (`service/shift.go:31-46,127-136`, `sync.go:236-300`, `0001_init.sql:276`) | Nothing (only strict decoding) | One operation-receipt table + helper for every mutation, with fingerprint and conflict outcome | M–L |
| A13 | Concurrent transfer actions double-move stock (`transfer.go:98-103,244-263,360-365,421-422`) | Nothing | Row lock, guarded status update, guarded stock decrement, PG concurrency tests | S–M |

## 2. Slice order (every slice: Opus review)

| # | Slice | DB migration | Ships via |
|---|---|---|---|
| 0 | Merge prep (§3) | No | Backend + Cloudflare |
| 1 | A13 transfer locking + PG race tests | No | Backend |
| 2 | A11 operation receipts (`0045_operation_receipts.sql`, claim key in the effect tx; advisory lock around startup migrations) | Yes | Backend — drain tablet queues before deploy |
| 3 | Error contract: `ItemResult.code` + `retryable` (additive, OpenAPI regen) | No | Backend |
| 4 | A01a awaited, fail-loud storage writes + quarantine | No | POS (OTA) |
| 5 | A02 + A03 client states (`needs_review`, backoff, competing receipt handling) | No | POS (OTA) |
| 6 | A04a capture-time envelope + fixed terminal (remove outlet switch/logout) | No | Backend + POS (OTA) |
| 7 | A06 completion (reason parity, UI gate, review, parity table) | No | Backend + POS (OTA) |
| 8 | A09 tender rules (offline shortfall accepted but flagged) | Likely | Backend |
| 9 | A01b SQLite journal with verified, resumable migration | Client only | APK |
| 10 | A04b device registration / authenticated recovery | Yes | Backend + APK/OTA |

Slices 1–3 are backend-only; slice 4 can run in parallel. A01–A03 all touch outbox persistence:
do them in sequence.

## 3. Merge recommendation

Fast-forward the audit branch into `prod-hardening` **before** P0 work, after these checks:
1. Browser gate green (find the cause first).
2. Decide whether the 26 dependency blockers gate deploys.
3. Opus review of behaviour that goes live on deploy in `e957154`: stricter sale validation and
   strict batch/shift decoders; batch refund denial (check which live accounts hold
   `process_refund`); A23 promotion-key rejection (run `cmd/promotion-key-preflight` read-only
   first, see `docs/PROMOTION_KEY_PREFLIGHT.md`); guest sales (A24).
4. JSON null/omit compatibility of the regenerated `api.gen.go` with the installed APK.
5. Cloudflare backoffice build with the vendored xlsx and lockfile in sync.
6. Drain tablet queues (or accept that invalid queued items park; test data only).
7. Remove stale `vercel.json` branch blocks.

Do not build P0 work on bare `prod-hardening`; the harness and overlapping containment live on
the audit branch. Fallback if the browser gate stalls: build slices 1–3 on a branch off the
audit branch.

## 4. Owner decisions needed

1. Merge the audit branch into `prod-hardening` after the §3 checks? — *Recommended: yes.*
2. Is the always-logged-in POS account the real operator or a shared terminal? — *Recommended:
   shared terminal; record the operator per shift.*
3. Remove the outlet switcher and logout from the POS; never wipe an unsynced queue on
   recovery? — *Recommended: yes.*
4. How long to accept old-format queued events without an envelope? — *Recommended: one release
   or 14 days, then review.*
5. Offline authority duration (Q03)? — *Recommended: defer to slice 10.*
6. Cash recorded below total: reject online, accept-and-flag offline? — *Recommended: yes.*
7. Non-cash amount differs from total: keep and flag instead of overwriting? — *Recommended: yes.*
8. Refund already paid out offline but denied by the server: keep as visible needs-review cash
   movement, never deleted? Who resolves (head office or outlet TL)? — *Recommended: yes.*
9. Competing transfer receipt: first valid wins, second → review with counts kept? —
   *Recommended: yes.*
10. Require all tablets at 0 pending items before sync-changing deploys and the SQLite APK? —
    *Recommended: yes while pre-launch.*
11. Which accounts hold `process_refund` today? (needed before the A06 containment goes live)

## 5. Not verified

Browser-gate cause and the 26 dependency blockers; live data, permissions, tablet queues and
installed app versions; runtime reproduction of A11/A13 races (inferred from code); JSON
compatibility of the regenerated types with the installed APK.
