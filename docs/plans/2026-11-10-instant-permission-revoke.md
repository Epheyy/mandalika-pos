# Instant permission revocation (rights version in the access token, Redis-cached)

Date 2026-11-10 · base `origin/prod-hardening` @ `fe40c69c` · status: PLAN (not started) · author: Opus planner
Source: `docs/qa/2026-11-10-role-test-local.md` finding 2 (commit `8202cb05`); owner: "revoke immediately through Redis" (HANDOFF:32).

**Supersedes** A33 D1 "Role/permission change ... `token_version` is not added" (`docs/plans/2026-10-15-a33-postgres-auth-authority.md`, D1) and HANDOFF:1061 ("role change within 15 min"). Record the new decision in HANDOFF Decisions so a reviewer does not flag the contradiction.

## Goal

Within seconds of an admin changing a user’s role, permissions or outlet, resetting their password, or deleting them, every request that carries an access token issued before the change is refused with a **refreshable 401**. Then:
- a user who still exists (role, permission or outlet change) refreshes silently and continues with the new rights, in the Backoffice and the POS, without losing or parking a single outbox item;
- a deleted user, or a user whose refresh tokens were revoked (password reset), signs out because `/auth/refresh` answers 401.

## Architecture

- **Rights version.** Add `users.perm_version bigint NOT NULL DEFAULT 0`. Every write that changes what a token grants bumps it in the same transaction. The access token carries it as claim `pv`. A missing claim (every token issued before the deploy) reads as 0, which equals the column default, so the rollout logs nobody out.
- **Check.** The checked `RequireAuth`, wired only in `server.go`, compares the token’s `pv` with the user’s current version. **It refuses only when `pv < current` or the user no longer exists.**
  - A token with `pv > cached` proves the DB has reached that version, because tokens are only minted from a DB read. It passes and raises the in-process memo.
  - Never refuse on plain inequality. A failed post-commit Redis SET would then refuse every fresh token and loop refreshes.
- **Lookup chain** (`auth.PermVersions`):
  1. An in-process memo with a TTL of 5 s, bounded at 10 000 entries and cleared when full. Its TTL is the cross-instance "within seconds" bound (Cloud Run runs up to 4 instances, `config.go:64-66`).
  2. Redis key `authpv:<uid>`, TTL 2 min. Its value is the decimal version, or `x` for a deleted user.
     - Readers populate with `SETNX`; writers overwrite with `SET` after commit.
     - The key must NOT start with `rd:` (`cache.ReadKeyPrefix`, `cache.go:31`): every write wipes that prefix (`handlers/handlers.go:64-71`).
  3. Postgres: `SELECT perm_version FROM users WHERE id=$1`, a primary-key lookup. No row means deleted: a definitive 401, cached negatively.
- **Redis down or disabled** (`cache.go:1-5`, `93-114`; breaker `22-23`, `192-208`).
  - Once the breaker is open, `GetE` returns `ErrUnavailable` without touching the network, so the chain falls through to Postgres.
  - The memo caps this at one primary-key read per active user, per instance, per 5 s. There is no DB read per request, and nobody is logged out (A33 default, HANDOFF:850-851).
  - If Postgres also fails, there is no verdict: the middleware answers **503** + `Retry-After: 2` ("auth temporarily unavailable"), never 401.
    - A middleware 503 on a normal request is not a 401, so the client never refreshes and never signs out: `execute` throws a typed `ApiError(503)` (`packages/api/src/client.ts:688-690`).
    - The engine classes 503 as transient and backs off (`packages/sync/src/engine.ts:196`).
    - Every handler needs Postgres anyway, so the 503 costs nothing extra.
- **Wire contract.** HTTP 401 with body `{"data":null,"error":"token revoked"}`.
  - The existing client refreshes on any 401 from a non-`/auth/` path (`client.ts:644-662`).
  - Never answer 403. On `/sync/batch`, a 403 is engine kind `account` (`engine.ts:193-198`, `1636-1638`): it shows the account banner and never refreshes.
  - There is no new error code, header or field. So no OpenAPI change (the Error schema at `backend/api/openapi.yaml:262` is untouched), no generated-type change and no CORS change. CORS exposes no response headers (`server.go:75-81`), so a header marker would be unreadable in the browser anyway.
- **Client retry trap.** Today, a 401 on the retry after a successful refresh calls `onUnauthorized` (`client.ts:659-661`). Two quick admin edits inside the refresh-then-retry window would therefore sign a cashier out.
  - Fix: a 401 on a request sent with a token from a refresh that just succeeded is **never** a verdict on the session.
  - The client refreshes once more and retries. If the retry still returns 401, it throws `ApiError(401)` **without** calling `onUnauthorized`.
  - The engine already keeps everything queued on a 401 (`engine.ts:1644`).
- **`/auth/me`.** `/api/v1/auth/me` contains `/auth/`, so the client never refreshes it (`client.ts:644`), and a stale token there signs out at once. No app calls `api.me()`; it is only defined at `client.ts:760`. Leave it as is, with a code comment.

- **Redis today (what this builds on).**
  - `REDIS_URL` handling (`config.go:105-116`):
    - unset falls back to `redis://localhost:6379/0` (the dev default);
    - set but empty means disabled.
    - In production, unset only logs a warning that the server runs degraded (`config.go:280-284`).
  - Disabled mode makes every op a no-op miss (`cache.go:93-96`).
  - A failed startup ping leaves a degraded cache with the breaker open (`cache.go:103-112`). Startup never fails on Redis.
  - Where it runs: `REDIS_URL=""` is used for real in `scripts/erp-rehearsal-local.sh:101`; the hosted provider is Upstash, per `RUNBOOK.md:12` and Secret Manager.
  - What a Redis outage does today:
    - logs nobody out, because Postgres is the refresh authority (`auth/sessions.go:13-19`);
    - login limiters fall back to a per-instance memory counter (`cache.go:327-340`);
    - the read cache just misses (`handlers/handlers.go:107-117`).
    - Only `Count`/`Incr`/`IncrWindow` have a memory fallback. A plain `GetE` has none, hence the memo below.
- **Only the middleware answers 401 for app routes.** Under `/api/v1`, only `RequireAuth` returns 401 to the apps. Per `git grep -n StatusUnauthorized -- backend/internal`, the only other 401s are:
  - the Cloud Scheduler secret check, which the apps never call (`middleware/scheduler.go:32`);
  - the ERP stub.

  So Task 8’s extra retry can never resend a request that a handler refused for a business reason.

## Tech Stack

- **Go:** Go 1.26.10, chi, pgx v5, go-redis v9 through `internal/cache`, golang-jwt v5, and miniredis in tests.
- **TypeScript:** the `packages/api` client, the Backoffice in React, and Vitest.
- **Postgres gate:** a synthetic PostgreSQL 18.3 gate, `scripts/ci/postgres_gate.py`.

## Global Constraints

- **Keep signatures.**
  - `auth.IssueAccess(secret, ttl, uid, role, outlet, perms)` has about 40 integration-test call sites, and `mw.RequireAuth(cfg)` about 30. Both stay unchanged.
  - Add `auth.IssueAccessV(..., pv int64)`, and make it `mw.RequireAuth(cfg, opts ...mw.AuthOption)` (variadic).
  - Only `server.go:152` passes `mw.WithRevocation(...)`.
- **Off the wire.**
  - `User` gets field `PermVersion int64` with JSON tag `"-"`.
  - `User` is serialized by `authResp` (`auth/handlers.go:62-66`) and `/auth/me` (`auth/handlers.go:294-306`), so the tag keeps the version out of responses.
  - No OpenAPI change and no codegen change. `corepack pnpm gen:check` must stay clean.
- **Codegen gate.**
  - Add no new top-level test in `backend/internal/api` or `backend/internal/codegen`: `scripts/ci/codegen_gate.py:18-19` and `52-53` require exact test sets.
  - New Go tests live in `internal/auth`, `internal/middleware`, `internal/server` and the AU gate in `internal/handlers`.
- **Postgres gate.**
  - New integration cases are **subtests of `TestAuthAuthorityPostgres`** (`handlers/auth_authority_integration_test.go:41-55`, registered at `postgres_gate.py:49`). Add no new top-level gate test.
  - No subtest may skip.
  - Mind the 180 s `--test-timeout` (`postgres_gate.py:538`): use a blackholed cache in one subtest only.
- **Lock order.** Lock order stays users -> refresh_tokens (`auth/sessions.go:13-19`). Bumps are `UPDATE users` statements inside the existing transactions.
- **Migration.**
  - The file is `backend/internal/db/migrations/0087_users_perm_version.sql`. The latest on origin is 0086.
  - Renumber it if the in-flight role-test fixes (HANDOFF:30-38) take 0087.
  - It is additive, and the previous revision ignores both the column and the claim, so a rollback is safe.
- **OTA journal guard** (`scripts/lib/ota-journal-guard.sh:22-33`).
  - No file in `OTA_JOURNAL_PATHSPECS` changes. `client.ts` and the auth providers are not listed.
  - `terminalBinding.ts` and `engine.ts` stay untouched, so no `OTA_JOURNAL_CHANGE_ACK` is needed.
- **Never** weaken a sync/stock/refund guard, and never auto-sign-out on 5xx/429/network (A05).
- **Review tier:** Opus high for Tasks 1-9 (auth, offline outbox behaviour, shared client); Haiku for Task 10 (docs).

## Review Focus (the 5 failure modes most likely to bite)

1. **Old token still passes after a rights change.**
   - Causes: a missed write path, a publish before commit, or a memo or Redis key that stays stale past its bound.
   - Tests:
     - T3 `TestRightsWritesOnlyInAllowedFunctions`.
     - T4 `TestPermVersionsPublishOverridesStalePopulate` and `TestPermVersionsRedisKeyExpiryBoundsStaleness`.
     - T7 subtests `11 revoke perms`, `12 revoke role and outlet` and `16 second instance`.
2. **A legitimate user is signed out, or outbox items get parked.**
   - Causes: a 403 instead of a 401, the version check placed after the outlet check, inequality instead of `<`, or the second-401 trap.
   - Tests:
     - T5 `TestRequireAuthRevokedBeforeOutletCheck` and `TestRequireAuthNewerTokenPasses`.
     - T8 "a 401 on the retry after a successful refresh never signs out".
     - T7 `18 sync batch after revoke`.
3. **Redis down becomes a mass 401/503, a per-request DB storm, or a stall.**
   - Tests:
     - T4 `TestPermVersionsRedisDownUsesDBOncePerTTL` and `TestPermVersionsNoVerdictIsError`.
     - T5 `TestRequireAuthNoVerdictIs503`.
     - T7 `15 revoke with redis down` (refused, blackholed, disabled).
4. **A delete or password reset is not definitive.**
   - Causes: the refresh still mints, or there is no negative cache.
   - Tests:
     - T7 `13 revoke delete` and `14 revoke reset`.
     - T4 `TestPermVersionsDeletedIsDefinitive`.
5. **Rollout or rollback breaks sessions.**
   - Causes: tokens without `pv`, the old revision running on the new schema, or the `scanUser` column order breaking login and refresh.
   - Tests:
     - T2 `TestParseAccessWithoutPVIsZero`.
     - T7 `17 rollout tokens without pv`.
     - The existing subtest `9 old revision compatibility` still passes.

## Write-path inventory (where rights change)

| Path | File:line | Changes token rights? | Action |
|---|---|---|---|
| `PUT /users/{id}` -> `Store.UpdateUser` | `handlers/users.go:72-115`, `auth/store.go:118-168` | role, outlet_id, user_permissions | Bump in the transaction **only when** a role, outlet or perms argument is non-nil and differs; publish after commit |
| `DELETE /users/{id}` -> `Store.DeleteUser` | `handlers/users.go:117-128`, `store.go:236-245` | User gone; the cascade drops refresh rows (`0001_init.sql:55-62`) | Publish a tombstone after commit |
| `POST /users/{id}/reset-password` -> `Store.ResetPassword` | `auth/reset.go:64-134`, `store.go:298-347` | Refresh rows revoked; access tokens must die too | Add `perm_version=perm_version+1` to the UPDATE at `store.go:307`; publish after commit |
| fsmigrate users upsert | `fsmigrate/tables.go:237-270` | role, outlet, perms | Add `perm_version = users.perm_version + 1` to the ON CONFLICT SET. There is no Redis there, so staleness is bounded by the 2 min key TTL plus the 5 s memo |
| `PUT /users/{id}/receive-pin` | `handlers/users.go:130-149`, `store.go:170-212` | No: the PIN is not a claim, and grants die through `receive_pin_set_at` (`store.go:170-173`) | None |
| `POST /users`, `/auth/register`, `cmd/seed` | `store.go:248-283`, `cmd/seed/main.go:45` | A new user has no old tokens | None |
| Custom roles | `write/stockcount.go:53-71` | No: they are templates, not linked to users (role-test finding 7) | None |
| `user_outlets` | `0001_init.sql:35-39` | No code reads or writes it | None |
| Outlet delete (`outlet_id ON DELETE SET NULL`) | No route; `write/outlet.go` only creates and updates | n/a | None; the guard test catches a future delete path |
| ERP and CSV imports | `git grep` finds no writes to `users` | n/a | None |
| `backend/sample_seed.sql:53` | Dev seed only | n/a | None |

**Refresh.**
- `/auth/refresh` already re-reads role, outlet and permissions from `users` FOR SHARE (`auth/sessions.go:132-138`).
- That includes the re-mint path (`sessions.go:205-221`), which returns the freshly scanned `u`.
- A deleted user is `ErrNotFound`, which maps to 401 (`auth/handlers.go:245-247`). So a stale refresh token of a deleted user already cannot mint a token; Task 7 pins this down.

---

## Tasks

### Task 1: Migration (Opus)
- **File:** `backend/internal/db/migrations/0087_users_perm_version.sql`.
  - Header comment: the change is additive, the previous revision ignores it, it is metadata-only on PG >= 11 (constant default), there is no backfill, and it supersedes the A33 "no token_version" note.
  - SQL: `ALTER TABLE users ADD COLUMN IF NOT EXISTS perm_version bigint NOT NULL DEFAULT 0;`
- **Verify:**
  - `cd backend && go build ./... && go test ./internal/db/...` -> `ok`.
  - The AU gate (Task 7) migrates the empty fixture through `db.Migrate` (`handlers/gate_fixture_test.go:52`).

### Task 2: Claim, issuance, scan (Opus)
- **Files:** `backend/internal/auth/jwt.go`, `store.go`, `sessions.go` and `handlers.go`; a new `backend/internal/auth/jwt_test.go`; extend `sessions_handler_test.go`.
- **Changes:**
  - `Claims` (`jwt.go:10-16`) gains `PermVersion int64` with JSON tag `"pv,omitempty"`.
  - Add `func IssueAccessV(secret []byte, ttl time.Duration, uid, role, outletID string, perms []string, pv int64) (string, error)`. `IssueAccess` (`jwt.go:28`) delegates to it with `pv=0`.
  - `User` (`store.go:13-22`) gains `PermVersion int64` with JSON tag `"-"`.
  - `scanUser`’s base dest (`store.go:39`) becomes `id, email, display_name, role, outlet_id, photo_url, perm_version`, then `extra...`.
  - Add `perm_version` right after `photo_url` in all 3 SELECTs:
    - `store.go:64`, before `password_hash`;
    - `store.go:75`;
    - `sessions.go:134`, before `refresh_revoked_before`.
  - `respond()` (`auth/handlers.go:77`) calls `IssueAccessV(..., u.PermVersion)`.
- **Tests (first):**
  - `TestIssueAccessVRoundTripsPermVersion`: `ParseAccess` of an `IssueAccessV(..., 7)` token gives `PermVersion == 7`.
  - `TestParseAccessWithoutPVIsZero`: an `IssueAccess` token’s payload has no `"pv"` key, and it parses to 0.
  - `TestRefreshAccessCarriesPermVersion` (fake backend):
    - `RotateSession` returns a user with `PermVersion: 9`.
    - The access token in the 200 response parses to `pv == 9`.
    - The response JSON has no `pv`/`permVersion` key under `user`.
  - `TestLoginAccessCarriesPermVersion`: the same check through `Authenticate`.
- **Verify:**
  - `cd backend && go test ./internal/auth/...` -> `ok`.
  - The scan order is proven on real Postgres by T7, since every subtest logs in and refreshes.

### Task 3: Bump on every rights write + guard (Opus)
- **Files:** `backend/internal/auth/store.go`; new `backend/internal/auth/rights_guard_test.go`; `backend/internal/fsmigrate/tables.go`.
- **New types and functions:**
  - `type RightsPublisher interface { Publish(ctx context.Context, uid string, v int64); PublishDeleted(ctx context.Context, uid string) }`.
  - `Store` gains `Versions RightsPublisher`; nil means no publish.
  - `func bumpPermVersion(ctx context.Context, tx pgx.Tx, id string) (int64, error)`: `UPDATE users SET perm_version=perm_version+1 WHERE id=$1 RETURNING perm_version`.
- **UpdateUser** (`store.go:118-168`). The signature is unchanged.
  - Replace the EXISTS probe with `SELECT role, outlet_id FROM users WHERE id=$1 FOR NO KEY UPDATE`. No row means `ErrNotFound`.
  - Bump once if any of these changed:
    - the role is non-nil and differs;
    - the outlet is non-nil and differs (`""` = NULL);
    - perms is non-nil and the set differs from `permissionsOf(ctx, tx, id)`, read inside the transaction and compared as sets.
  - After commit, if it bumped, call `Versions.Publish`.
- **DeleteUser:** after a successful delete, call `PublishDeleted`.
- **ResetPassword:** `store.go:307` becomes `UPDATE users SET password_hash=$1, refresh_revoked_before=now(), perm_version=perm_version+1 WHERE id=$2 RETURNING email, role, perm_version`. Publish after commit.
- **fsmigrate:** add `perm_version = users.perm_version + 1` to the ON CONFLICT SET at `tables.go:255-259`.
- **Guard test** `TestRightsWritesOnlyInAllowedFunctions`, in the style of `server/realip_guard_test.go`:
  - It walks the non-test `.go` and `.sql` files under `backend/`, excluding `migrations/`.
  - It fails on any of these statements outside `internal/auth/store.go`, `internal/fsmigrate/tables.go`, `sample_seed.sql` and `cmd/seed`:
    - `UPDATE users SET ...`, or an `INSERT INTO users ... ON CONFLICT ... DO UPDATE SET ...` upsert, that names `role`, `outlet_id` or `password_hash`;
    - `INTO user_permissions`;
    - `DELETE FROM user_permissions`;
    - `DELETE FROM users`.
  - It asserts `scanned > 0`.
- **Tests.** The bump semantics run in T7 subtests 11-14 on real Postgres, using `auth.NewStore(pool)` with a recording publisher:
  - a name-only edit: no bump and no publish;
  - an unchanged role: no bump;
  - a permission change: +1 and exactly one publish;
  - a delete: `PublishDeleted`;
  - a password reset: +1.
- **Verify:** `cd backend && go test ./internal/auth/... ./internal/fsmigrate/...` -> `ok`. If `fsmigrate_test.go` pins the SQL text, update that pin.

### Task 3b: Refuse delete and outlet moves while the user has an open shift (Opus review)
- **Files:** `backend/internal/handlers/users.go`, plus a small read helper (`read` package or `auth/store.go`, whichever already reads `shifts` for users); `apps/backoffice/src/screens/users/*` (show the server message); tests.
- **Rule:** "open shift" = a row in `shifts` with `status='open' AND cashier_id = <user id>` (schema `0001_init.sql:202-210`). This is a proxy: the server cannot see items still queued on a tablet. Document that in the handler comment.
- **DELETE /users/{id}:** if the user has an open shift, return 409 (apperr Conflict, the existing envelope) with exactly: `Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum menghapus.` Nothing is deleted and nothing is published.
- **PUT /users/{id}:** if `outletId` is present and differs from the stored outlet (`""` = NULL, compared case-insensitively) and the user has an open shift, return 409 with exactly: `Pengguna ini masih punya shift yang buka. Tutup shift-nya dulu sebelum memindah outlet.`
  - Other field changes in the same request are not applied; the whole request is refused, so there are no partial updates.
  - Role and permission changes without an outlet change are still allowed mid-shift, and they bump.
- **Atomicity:** do the shift check inside the same transaction as the write (`SELECT 1 FROM shifts WHERE cashier_id=$1 AND status='open' LIMIT 1`, after locking the user row), so a shift opened concurrently cannot slip through between the check and the write.
- **Backoffice:** the delete confirm and the user edit form show the message the server returns, verbatim, as a red error rather than a generic failure. Add a vitest test for each.
- **Tests:** Postgres subtests in the T7 gate:
  - delete refused with an open shift, allowed after close;
  - outlet move refused with an open shift; a permission-only change succeeds and bumps;
  - a refused outlet move applies none of the other fields.
- **Verify:** `cd backend && go test ./internal/handlers/... ./internal/auth/...` -> `ok`; the Backoffice vitest suite passes.

### Task 4: `auth.PermVersions` lookup chain (Opus)
- **Files:** new `backend/internal/auth/permversion.go`, `permversion_test.go`.
- **Signatures:**
  - `type VersionLoader func(ctx context.Context, uid string) (v int64, exists bool, err error)`
  - `func (s *Store) LoadPermVersion(ctx context.Context, uid string) (int64, bool, error)`
  - `type PermVersionOptions struct { MemoTTL, RedisTTL time.Duration; MemoMax int; Now func() time.Time }`. The defaults are 5 s, 2 min and 10 000.
  - `func NewPermVersions(c *cache.Cache, load VersionLoader, opts PermVersionOptions) *PermVersions`
  - `func (p *PermVersions) Current(ctx context.Context, uid string) (v int64, exists bool, err error)`
  - `func (p *PermVersions) Observe(uid string, pv int64)`: it only raises the memo; it never lowers it and never revives a deleted entry.
  - `func (p *PermVersions) Publish(ctx context.Context, uid string, v int64)` and `PublishDeleted(ctx context.Context, uid string)` implement `RightsPublisher`.
    - Each sets the memo, then calls `Cache.SetE(ctx, "authpv:"+uid, ...)` with `RedisTTL`.
    - On a SetE error it logs `slog.Warn("perm_version_publish_failed", "user", uid, "err", err)`.
  - `func Revoked(tokenPV, current int64, exists bool) bool` returns `!exists || tokenPV < current`.
- **Current algorithm** (the signature does not determine it):
  1. A fresh memo entry is returned as is.
  2. Otherwise call `Cache.GetE`. On a hit, parse it: `x` means deleted, and an unparseable value counts as a miss. Memoize and return.
  3. On a miss or a Redis error, call `load`. On a load error, return the error and memoize nothing.
  4. Otherwise memoize, call `Cache.SetNX(ctx, key, value, RedisTTL)` (best effort) and return.
- **Tests** (miniredis, a counting fake loader, a fake clock):
  - `TestPermVersionsMemoHitSkipsRedisAndDB`: 100 calls cost 1 Redis command (`mr.CommandCount()` delta) and 0 loads.
  - `TestPermVersionsRedisMissLoadsAndPopulatesNX`.
  - `TestPermVersionsPublishOverridesStalePopulate`:
    - a populate of 4, then Publish 5 -> Redis holds `5`;
    - Publish 5, then a populate of 4 -> Redis still holds `5`.
  - `TestPermVersionsRedisKeyExpiryBoundsStaleness`: a stale Redis value is reloaded from the loader after `mr.FastForward(2*time.Minute)`.
  - `TestPermVersionsRedisDownUsesDBOncePerTTL`:
    - Run it with a refused cache (`cache.Connect(ctx, "redis://127.0.0.1:1/0", ...)`) and with a disabled one (`cache.Connect(ctx, "", ...)`).
    - 50 calls cost 1 load. Once the clock passes the memo TTL, the total is 2.
  - `TestPermVersionsNoVerdictIsError`: Redis is down and the loader errs. The result is an error with `exists == false`, and nothing is memoized.
  - `TestPermVersionsDeletedIsDefinitive`: the loader returns `exists=false`. The memo is set, Redis holds `x`, and `Revoked` is true.
  - `TestPermVersionsObserveRaisesNeverLowers`.
  - `TestPermVersionsKeyOutsideReadCachePrefix`: `"authpv:"` does not start with `cache.ReadKeyPrefix`.
  - `TestPermVersionsMemoBounded`: with `MemoMax` 3 and 5 users, the memo holds at most 3 entries.
  - `TestRevokedTable`.
- **Verify:** `cd backend && go test -race ./internal/auth/...` -> `ok`.

### Task 5: Middleware check (Opus)
- **Files:** `backend/internal/middleware/middleware.go`; new `backend/internal/middleware/revocation_test.go`.
- **Signatures:**
  - `type RevocationChecker interface { Current(ctx context.Context, uid string) (int64, bool, error); Observe(uid string, pv int64) }`
  - `type AuthOption func(*authOptions)`
  - `func WithRevocation(c RevocationChecker) AuthOption`
  - `func RequireAuth(cfg *config.Config, opts ...AuthOption) func(http.Handler) http.Handler`
- **Order.** The check runs after `ParseAccess` (`middleware.go:21-25`) and **before** the X-Outlet-Id check (`middleware.go:28-37`).
  - On an error: 503, `Retry-After: 2`, "auth temporarily unavailable", and `slog.Warn("auth_version_unavailable", "user", uid, "err", err)`.
  - If `auth.Revoked(...)`: 401 "token revoked", and `slog.Info("access_token_revoked", "user", uid, "pv", claims.PermVersion, "current", v)`.
  - Otherwise: call `Observe(uid, claims.PermVersion)` and continue.
  - Add a comment that `/auth/me` is not refreshed by the client.
- **Tests:**
  - `TestRequireAuthStalePVIs401`: status 401, and the body `error` is `"token revoked"`.
  - `TestRequireAuthCurrentPVPasses`.
  - `TestRequireAuthNewerTokenPasses`: a token with pv 5 against current 4 gets 200 and calls `Observe(uid, 5)`.
  - `TestRequireAuthDeletedUserIs401`.
  - `TestRequireAuthNoVerdictIs503`: 503 with `Retry-After: 2`, never 401.
  - `TestRequireAuthRevokedBeforeOutletCheck`: a cashier with a stale token who sends the old outlet as `X-Outlet-Id` gets **401**, not 403.
  - `TestRequireAuthWithoutCheckerUnchanged`: with no option, a stale pv passes.
- **Verify:** `cd backend && go test ./internal/middleware/...` -> `ok`.

### Task 6: Wiring + guard (Opus)
- **Files:** `backend/internal/server/server.go`; new `backend/internal/server/revocation_guard_test.go`.
- **Change:**
  - After `store := auth.NewStore(...)` (`server.go:90`), add `pv := auth.NewPermVersions(c, store.LoadPermVersion, auth.PermVersionOptions{})`, then `store.Versions = pv`.
  - `server.go:152` becomes `r.Use(mw.RequireAuth(cfg, mw.WithRevocation(pv)))`.
  - The same `store` already reaches the user handlers (`server.go:106`) and `ah` (`server.go:91`).
- **Test:** `TestServerAuthGroupsUseRevocation` scans `server.go` source. There must be at least one `mw.RequireAuth(` call, and every one must contain `WithRevocation(`.
- **Verify:** `cd backend && go test ./internal/server/...` -> `ok`.

### Task 7: Postgres integration in the AU gate (Opus)
- **File:** `backend/internal/handlers/auth_authority_integration_test.go`.
  - Add the subtests after `10 cleanup`.
  - Reuse the existing helpers: `router`, `miniCache`, `refusedCache`, `disabledCache`, `blackholeCache`, `newUser`, `call` and `nextIP`.
- **Subtests:**
  - `11 revoke perms`:
    - A user with `view_reports` logs in (token A1) and gets 200 on `GET /api/v1/reports/summary`.
    - An admin removes the permission with `PUT /users/{id}`. A1 now gets 401 "token revoked".
    - `/auth/refresh` -> 200 (A2). The retry gets 403 "missing permission: view_reports".
    - `GET /api/v1/products` with A2 -> 200.
    - At the store level, neither a name-only edit nor a same-value role changes `perm_version`.
  - `12 revoke role and outlet`:
    - A cashier moved to outlet B: the old token with `X-Outlet-Id: A` gets 401, not 403.
    - After a refresh, the new token with `X-Outlet-Id: B` -> 200.
    - A cashier promoted to manager: the old token gets 401, and the refreshed claims say `manager`.
  - `13 revoke delete`:
    - `DELETE /users/{id}`, then the old access token gets 401 and its refresh gets 401 "user not found".
    - A second router sharing the same miniredis also answers 401.
  - `14 revoke reset`: after an admin password reset, the old access token gets 401 and its refresh gets 401. Logging in with the new password gets 200, and that token passes.
  - `15 revoke with redis down`:
    - Refused and disabled caches: the old token gets 401 within one memo TTL. Refresh, then retry -> 200.
    - An unrelated valid token stays 200.
    - Blackholed cache: one request, within the latency bound that `call` already asserts.
  - `16 second instance`:
    - Routers R1 and R2 share one miniredis. Warm R2 with A1 (200), then revoke through R1.
    - R2 accepts A1 for at most the memo TTL: poll with a 6 s deadline until it answers 401.
    - A2 from a refresh passes on R2 immediately.
  - `17 rollout tokens without pv`: `auth.IssueAccess` (no pv) for a user at 0 -> 200; after one bump -> 401.
  - `18 sync batch after revoke`:
    - A stale token on `POST /api/v1/sync/batch` gets 401, and the `orders` count is unchanged.
    - Refresh, then resend the same idempotency key -> 200, with the item ok.
    - Sending it again is a duplicate (idempotent).
  - `19 remint after bump`: rotate X -> Y, then bump. A replay of X re-mints Y, and the access token carries the current pv and passes.
- **Verify:** run `python3 scripts/ci/postgres_gate.py --runtime native --pg-bin <pg18.3/bin> --no-race --only AU --output "$TMP/au.json"`. Expected: status `pass`, `TestAuthAuthorityPostgres` PASS, 0 skipped, wall time under 180 s.

### Task 8: Client never signs out on a 401 right after a successful refresh (Opus)
- **Files:** `packages/api/src/client.ts` (`execute`, `644-662`); tests in `apps/pos/src/lib/apiClient.errors.test.ts`, whose existing refresh tests sit at `84-205`.
- **Change.** When `refreshed === "ok"` and the retry is again 401, call `trySilentRefresh()` once more and retry.
  - If that refresh is `"rejected"`: call `onUnauthorized`, because the session is over.
  - If it is `"ok"` and the retry is still 401: throw `new ApiError(401, "sesi diperbarui, coba lagi")` WITHOUT calling `onUnauthorized`.
  - If the refresh errors: throw that error, as today.
  - At most 2 refreshes per request. The CSV path (`client.ts:744`) shares `execute`.
- **Tests:**
  - "a 401 on the retry after a successful refresh refreshes once more and succeeds".
  - "a 401 on the retry after a successful refresh never signs out": 401, ok, 401, ok, 401 -> `onUnauthorized` is never called, the error is an ApiError with status 401, and fetch was called 5 times.
  - "a refused second refresh ends the session".
  - The existing test at line 151 ("a refresh the server refuses ends the session with a typed 401") is unchanged.
- **Release.**
  - The Backoffice gets it on deploy.
  - The POS needs an OTA (`make ota-release`).
  - No journal-guard paths change.
- **Verify:** `corepack pnpm --filter @mandalika/pos test -- apiClient.errors` -> all pass.

### Task 9: Backoffice continues with the new rights (Opus)
- **Files:** new `apps/backoffice/src/lib/sessionRefresh.ts` and `sessionRefresh.test.ts`; `apps/backoffice/src/auth.tsx:49-53`.
- **Signature:** `export function applyRefreshedSession(d: AuthData, deps: { store: typeof authStore; persist: (refresh: string) => void; setUser: (u: User) => void; clear: () => void }): "kept" | "signed-out"`.
- **Behaviour:**
  - Move `ALLOWED_ROLES` (`auth.tsx:21`) into this module.
  - Role not allowed: call `clear()` and return `"signed-out"`.
  - Otherwise:
    - store the tokens and the userId;
    - persist the refresh token;
    - call `setUser(d.user)`;
    - if the role is not admin, set `store.outletId = null`. The immediate retry then carries no stale admin X-Outlet-Id. `OutletProvider` resets it too, but only after render (`outlet.tsx:61-66`).
  - `onTokens` delegates to this function. It keeps ignoring a refresh that lands after logout (`authStore.refresh === null`), as the POS does (`apps/pos/src/auth.tsx:116`).
- **Tests:**
  - "keeps the session and replaces the user’s permissions"
  - "a demotion to cashier signs out and persists nothing"
  - "an admin demoted to manager drops the outlet override before the retry"
  - "a refresh landing after logout is ignored"
- **Verify:** `corepack pnpm --filter @mandalika/backoffice test -- sessionRefresh` -> pass.
- **POS:** no code change.
  - `onTokens` already calls `setUser` and `settleTerminal` (`apps/pos/src/auth.tsx:114-125`).
  - The engine keeps items on a 401 (`engine.ts:193`, `1644`), as the existing test `packages/sync/src/engine.review-states.test.ts:105` shows.

### Task 10: Docs (Haiku)
- `RUNBOOK.md:12` (Redis row): add
  - the `authpv:` keys;
  - the Redis-down behaviour: DB fallback, a 5 s memo, and a 503 only when Postgres is down too;
  - the log keys `access_token_revoked`, `perm_version_publish_failed` and `auth_version_unavailable`.
- No new env var, so `ONBOARDING.md:340` is unchanged.
- HANDOFF: update the board, and add a Decisions entry that supersedes A33 D1 / HANDOFF:1061.
- **Verify:** `git diff --stat` shows docs only.

### Final gate
- **Commands:**
  - `corepack pnpm quality:ci`. It includes `gen:check`, which must show no drift.
  - `cd backend && go vet ./... && go test -race ./...`.
  - The AU gate, as in T7.
- **Review:** Opus reviews the whole diff before merge.
- **Deploy:** the backend deploy, the Backoffice deploy and the POS OTA (Task 8) each need the owner’s go-ahead. Order: backend first (old clients already refresh on a 401), then the Backoffice, then the OTA.

## Risk to offline sales

- **The change itself drops or parks nothing.**
  - A 401 on `/sync/batch` keeps everything queued (`engine.ts:1644`), and the client refreshes and retries.
  - Offline selling makes no request, so it runs no check.
- **Existing rules now bite at once** instead of within 15 min:
  - An outlet move parks queued old-outlet items as `mismatchOutlet` (`backend/internal/sync/attribute.go:227`).
  - A refund sent after `process_refund` is removed is judged by the sending token (`handlers/sync.go:73`).
  - A deleted user’s queue is stranded (Q1).

## Decisions (owner, 2026-11-10: "Use your recommendations")

1. **Deleting a user with an open shift is refused** (option a). Task 3b adds the guard. A "nonaktifkan" (disable) state is a later slice, not this one.
2. **A password reset signs the user out at once.** That is the bump in Task 3; the user signs back in with the new password and keeps their queue.
3. **Moving a user to another outlet while they have an open shift is refused** (Task 3b). Outlet moves are allowed again once the shift is closed.
4. **Refund authority is unchanged.** It stays the A06 rule at send time (`sync.go:416-428`): a refund that already committed replays as ok; an uncommitted refund without `process_refund` is Forbidden and stays stored on the tablet, unresolved, until someone allowed sends it.
   - Claude first recommended judging at capture time and corrected that before implementation. Capture time comes from the tablet (it could be backdated) and the server keeps no history of rights, so that would weaken a refund guard (AGENTS.md "Never").
   - No code change for this point.
5. **Bounds accepted as planned:** a 5 s memo, a 2 min Redis TTL, and the extra Upstash GETs. A 429 on refresh stays harmless.
6. **Logout does not bump.**
7. **fsmigrate bumps as planned** (Task 3).

Record decisions 1-4 under HANDOFF "Decisions (owner)", together with the A33 D1 supersession (Task 10).
