# A33 (+ A07 overlap): Postgres is the auth authority, Redis is optional

Date 2026-10-15 · branch `prod-hardening` · status: PLAN (not started) · author: Opus planner

## Goal and owner default

Owner default (HANDOFF "Decisions 2026-10-14 → A33 Redis"): tablets sell offline through at least a full
trading day with no degradation; **a Redis outage must never log anyone out or block server startup —
Postgres is the auth authority, Redis is a cache only.**

Done means: with Redis refused, blackholed or unconfigured, the server starts, login/refresh/sync work with
bounded latency, no valid session is lost, and refresh rotation is atomic and durable in Postgres.

## What the code does today (verified 2026-10-15)

| Where | Behaviour | Problem |
|---|---|---|
| `backend/cmd/server/main.go:48-51` | `cache.Connect` pings; `log.Fatalf` on failure | Redis down = no instance can start |
| `internal/cache/cache.go` | go-redis defaults (5 s dial, 3 s read, 3 retries); errors swallowed to "miss"/0 | Blackholed Redis = multi-second stall on **every** request (global limiter INCR) even though it "fails open" |
| `internal/auth/handlers.go:56-60` `issue()` | Redis `SET refresh:<jti>` then `_, _ = Pool.Exec(INSERT refresh_tokens…)` | Non-durable session can be handed out (A07) |
| `handlers.go:209-214` `refreshUsable` | Requires `refresh:<jti>` in Redis; never reads the DB row | Redis loss/flush/eviction → every refresh 401 → tablets logged out |
| `handlers.go:157-160` `Refresh` | Redis `Del`, then unchecked `UPDATE revoked=true` | Not atomic: two concurrent refreshes both succeed |
| `handlers.go:161-164` | Any `ByID` error → **401** "user not found" | A DB blip logs tablets out (client treats 401 as rejected) |
| `auth/store.go:74-89` `permissions()` | Query error → `[]string{}` silently | DB blip issues an access token with no permissions |
| `handlers.go:216-255`, `reset.go:94-101` | Admin reset writes a Redis marker first; refresh reads it fail-closed (`!= redis.Nil` → revoked) | A Redis error refuses every refresh (fail-closed = mass logout) |
| `handlers.go:73-77,110-118` | Login per-IP+email limit and per-email fail cap via Redis; error → 0 / miss | Login brute-force limits vanish when Redis is down |
| `middleware/ratelimit.go:25-31` | Global/auth/ota per-IP fixed window, raw `c.R.Incr`; fail open | Limits vanish; plus the latency stall above |
| `server/server.go:62-72` | `/healthz` 503 when Redis is down; `/readyz` dependency-free | Deep health says "down" for an optional cache |
| `internal/handlers/handlers.go:88-112` | Read cache-aside (15 s TTL), `DelByPrefix("rd:")` on writes | Already degrades to direct build; only latency matters |
| `internal/handlers/writes.go:974-979,1028-1030` | `idem:<key>` fast path for direct `POST /orders` | Fallback is complete: `service/order.go:146-155` checks `processed_keys` inside the tx, `INSERT processed_keys` + `replayAfterConflict` (`order.go:597-641`) handle races. No change needed beyond the wrapper |
| OTA (`/ota/check`, `/ota/publish`) | Only the `ota` rate-limit bucket touches Redis | Covered by the limiter work |

Schema: `refresh_tokens(jti uuid PK, user_id uuid FK users ON DELETE CASCADE, expires_at, revoked bool, created_at)`,
index on `user_id` only (`0001_init.sql:55-62`). Migrations run at startup inside an advisory-locked tx
(`internal/db/db.go:83`), so no `CREATE INDEX CONCURRENTLY`.

Client (no change needed, but it constrains the server):
- `packages/api/src/client.ts:373-408` `trySilentRefresh` is single-flight, and **any non-OK status that is
  not >=500 or 429 is `rejected` → logout**. `apps/pos/src/authBoot.ts:16-18` treats only HTTP 401 as rejected
  at boot. So: **Contract: `/auth/refresh` may answer only 200, 401 (definitive no), 429, or 5xx.** (400 stays
  only for a malformed body, which our client never sends.)
- Rotated tokens are persisted with `kv.set` (`authBoot.ts persistSession`), which on native is
  fire-and-forget (`packages/sync/src/storage.ts:131-134`, `void this.prefs.set`; SharedPreferences
  `apply()` is async). A crash or a silently failed write can leave the tablet holding an **older** token.
  The server must tolerate this.

## Design

### D1. Refresh-token authority in Postgres

One transaction per issue/rotation, lock order **users → refresh_tokens** everywhere (login, rotation, reset).
Logout locks only token rows. That ordering cannot deadlock with `Store.ResetPassword`, which updates `users`
first and then `refresh_tokens`.

**Issue (login).** `Authenticate` returns the user plus the hash it verified. Then, in one tx:
1. `SELECT password_hash, refresh_revoked_before FROM users WHERE id=$1 FOR SHARE`. If the hash differs from
   the verified one, a concurrent admin reset won: answer 401 "invalid email or password". This replaces
   `revokedSince`/`decisionAt`. (`FOR SHARE`, not `FOR KEY SHARE`: it must conflict with reset's
   `UPDATE users SET password_hash`.)
2. Opportunistic cleanup: `DELETE FROM refresh_tokens WHERE user_id=$1 AND expires_at < now() - interval '1 day'`.
3. `INSERT refresh_tokens (jti, user_id, family_id=jti, created_at=$iat, expires_at=$exp)`, where `$iat` and
   `$exp` are the **same second-truncated values** signed into the JWT.
4. Commit. **Only then** sign and return the tokens. An insert or commit error → 500, no tokens. This fixes
   A07's silent insert.

**Rotation (`POST /auth/refresh` with token X).** Parse the JWT (bad signature or expired → 401). Then, in one tx:
1. `SELECT … FROM users WHERE id=$uid FOR SHARE`. Not found → 401. DB error → 503.
2. Claim: `UPDATE refresh_tokens SET revoked=true, revoked_at=now(), revoke_reason='rotated', replaced_by=$Y
   WHERE jti=$X AND user_id=$uid AND NOT revoked AND expires_at>now() RETURNING COALESCE(family_id,jti), created_at`.
   Also refuse if `created_at < users.refresh_revoked_before` (defence in depth).
3. One row claimed → `INSERT` Y (same family, `created_at`/`expires_at` = Y's signed iat/exp). Commit, sign, respond.
   A failed insert rolls the claim back too, so X is never revoked without a successor.
4. Zero rows → `SELECT` X's row and decide:
   - **Immediate-predecessor replay (lost response or concurrent loser):** X is revoked with
     `replaced_by = Y`, and Y is live (not revoked, not expired, not before the reset marker). Then **re-mint Y**:
     sign a refresh JWT with Y's own jti, `created_at` and `expires_at`, plus a fresh access token from the
     current user row. No DB write. Respond 200. (A concurrent loser blocks on X's row lock until the winner
     commits; under READ COMMITTED its UPDATE then matches 0 rows and it re-mints the winner's Y.)
   - **Deep reuse** (X's successor is revoked, or X was revoked by logout/reset): 401, and log
     `refresh_reuse_detected` with user, family and jti. **Do not revoke the family.** Because of the
     write-behind storage above, a legitimate tablet can present an older token after a crash. Revoking the
     family would add nothing for that tablet, which is refused either way. It would only log out a
     legitimate holder of the head if a thief replayed an old copy.
   - **No row at all:** use the legacy adoption path (D4).
5. Any DB error at any step → 503 "auth temporarily unavailable". The client keeps the session.

Why re-mint and not a timed grace window: a short grace window (Auth0/Okta style, seconds) fails the owner's
case. A tablet whose refresh response was lost, or whose `kv.set` never reached disk, may retry hours later
after a full offline trading day. Re-minting the **same** successor is idempotent:
- concurrent requests and retries all receive the same Y, so the family never forks;
- the window closes by itself the moment Y is presented (about 15 min after the tablet is back online, because
  the access TTL forces a refresh);
- after that, X is deep reuse.

Exactly one claim per token is guaranteed by the row lock on X, plus the partial unique indexes in D3.
Optional hard cap: `AUTH_REFRESH_REPLAY_MAX_AGE` (default **off**). If set, re-mint only while
`X.revoked_at > now() - cap`. Recommend leaving it off: the "successor never presented" condition already
bounds it.

**Logout.** Find X's family, then
`UPDATE refresh_tokens SET revoked=true, revoked_at=now(), revoke_reason='logout' WHERE COALESCE(family_id,jti)=$fam AND NOT revoked`.
This revokes the **whole family**: otherwise a logged-out tablet's predecessor could still re-mint a live
successor. Always 200 (as today); log DB errors.

**Admin reset (`reset.go`).** New order: validate → block self → hash → **PG tx** → best-effort Redis.
- The PG tx (`Store.ResetPassword`) gains `users.refresh_revoked_before = now()`. It also sets
  `revoked_at`/`revoke_reason='reset'` on the rows it revokes.
- Best-effort Redis: SET the marker (rollback compatibility + adoption), DEL the `refresh:<jti>` keys, DEL the
  lockout key. Each failure is logged as a warning, and the request still returns 204.

The fail-closed guarantee is kept and now lives in Postgres:
- the tx is atomic, so a failed tx → 500 with nothing changed;
- a reset racing a rotation is serialized by the `users` row lock: either the claim sees X revoked, or the reset
  revokes Y after the rotation commits;
- a reset racing a login is caught by the hash comparison.

A Redis outage can no longer refuse every refresh. The Redis marker is no longer read on the normal path.

**Role/permission change (A07 overlap).** No forced logout. Refresh reloads role, outlet and permissions from
`users`, so stale authority is capped at the 15-min access TTL. This matches the owner's availability default.
`token_version` is not added.

**Bug fixes in the same slice:**
- `Refresh` maps only `ErrNotFound` → 401; any other error → 503.
- `Store.permissions()` returns `([]string, error)`, and `ByID`/`byEmailRow` propagate the error (→ 503 on
  refresh, 500 on login).

### D2. Redis-optional startup and runtime

The `internal/cache` wrapper becomes the only way to reach Redis.
- **No direct `.R` use anywhere.** Call sites to convert: `auth/handlers.go:223,247`,
  `auth/reset.go:97,123,128`, `middleware/ratelimit.go:25,31`, `server/server.go:67`.
- **Modes.** `REDIS_URL=""` → **disabled** (every op is a miss/no-op, zero network). URL set but ping fails at
  start → **degraded** (client built, breaker open, a warning logged). `Connect` never returns an error for
  reachability. An unparseable URL is still a config bug and is logged, but `main.go` then continues as
  disabled instead of `log.Fatalf`.
- **Timeouts.** `DialTimeout` 1 s, `ReadTimeout`/`WriteTimeout` 500 ms, `PoolTimeout` 1 s, configurable via
  `REDIS_DIAL_TIMEOUT_MS` / `REDIS_OP_TIMEOUT_MS`. **`MaxRetries: -1`**: in go-redis v9, `0` means the default
  3 retries, and only `-1` disables retries.
- **Circuit breaker** (in-process, no background goroutine, because Cloud Run throttles CPU between requests):
  - 3 consecutive transport errors → open for 30 s;
  - while open, ops return `ErrUnavailable` immediately;
  - after 30 s the first caller runs a single-flight probe (CAS), and success closes the breaker;
  - `redis.Nil` is not a failure.
  - Log `redis_breaker_open` / `redis_breaker_closed`.
- API: lookups return `(value, found, err)`, so callers can tell a miss from unavailability. Callers that only
  want a cache keep today's "miss on any error" helper. The same applies to `Set`, `Del`, `Incr`,
  `DelByPrefix` and `Ping`, plus `Available() bool`.
- **Rate limiting: in-memory fallback, not fail-open.**
  - Limiter store `Incr(key, window) (int64, error)`: Redis first; on `ErrUnavailable` or any error, use a
    bounded per-instance fixed-window map (at most 50k keys, entries dropped when their window ends, oldest
    dropped on overflow).
  - Used by the global `api`/`auth`/`ota` buckets and by login's IP+email limit and per-email fail cap
    (`handlers.go:73-77,110-118`).
  - Justification: fail-open would remove brute-force limits on `/auth/login` during an outage, which the brief
    forbids.
  - Known weaker property: with `--max-instances 4` the effective limit can be up to 4x. Accepted and documented.
  - Client IP still comes only from `internal/clientip` (A34 rule unchanged).
- **Read cache.** `cached()` bypasses when the breaker is open; `invalidate` skips. Staleness is bounded by the
  15 s `readTTL`: entries written before an outage expire before Redis returns.
- **Idempotency fast path.** Logic unchanged; it goes through the wrapper, and `processed_keys` stays authoritative.
- **Health.**
  - `/healthz`: DB down → 503. DB up and Redis down/disabled → **200**
    `{"status":"degraded","db":"ok","redis":"down|disabled"}`. All up → 200 `{"status":"ok",...}`.
  - `/readyz` stays dependency-free (promotion uses it).
  - Update the OpenAPI `/healthz` summary ("DB required; Redis reported, optional") and regenerate.

### D3. Migration `0054_refresh_token_authority.sql` (additive only)

```sql
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS family_id     uuid,
  ADD COLUMN IF NOT EXISTS replaced_by   uuid,
  ADD COLUMN IF NOT EXISTS revoked_at    timestamptz,
  ADD COLUMN IF NOT EXISTS revoke_reason text
    CHECK (revoke_reason IN ('rotated','logout','reset','reconcile'));
-- the chain stays linear
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_replaced_by_uidx
  ON refresh_tokens (replaced_by) WHERE replaced_by IS NOT NULL;
-- at most one live head per family
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_live_head_uidx
  ON refresh_tokens (family_id) WHERE NOT revoked AND family_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_revoked_before timestamptz;
```
- **No backfill UPDATE.** Every new column is nullable and reads use `COALESCE(family_id, jti)`. Existing
  unrevoked, unexpired rows, including the ~149 admin rows, stay valid as they are, so tablets are **not**
  re-logged-in by the deploy.
- The old revision's 3-column INSERT and `UPDATE ... SET revoked=true` keep working against this schema.
- Rows the old revision writes during the overlap have `family_id NULL` and are treated as their own family root.
- `replaced_by` has no FK, so cleanup can delete old rows freely.
- **Cleanup:**
  - per user inside the login tx (D1 step 2);
  - a bounded sweep after `Migrate` at startup, non-fatal:
    `DELETE FROM refresh_tokens WHERE jti IN (SELECT jti FROM refresh_tokens WHERE expires_at < now() - interval '1 day' LIMIT 5000)`.
  - No ticker: Cloud Run throttles idle CPU.
  - Revoked-but-unexpired rows are **kept**, because predecessor and reuse decisions need them.
  - Expected size: ~56 rotations/device/day x 30-day TTL, about 85k rows for 50 devices, which is trivial with
    PK lookups.
- **Clock note:** new rows store the app-clock iat/exp, so a re-mint is deterministic. `refresh_revoked_before`
  uses DB `now()`. It is defence in depth only; the reset's row revocation is the primary effect.

### D4. Legacy tokens without a PG row (adoption)

Some live sessions may have a Redis key but no row, because `issue()` swallowed insert errors (the Neon
stale-connection transient made that plausible). Handling when no row exists for X:
- Redis has `refresh:<X>` with value = uid, the user exists, `users.refresh_revoked_before` is NULL or older
  than the token iat, **and** the Redis reset marker is clear → INSERT X (family = X), then continue with the
  normal claim in the same tx. Redis is only *read* here, as a migration source.
- No row and Redis unavailable → **503**: the server has no verdict, and the tablet keeps its session and retries.
- No row and no Redis key → 401.

Remove adoption in the cleanup release (Task 9) once the Task 0 count is 0 or the remaining tokens have expired.

### D5. Rollback compatibility (one release minimum)

The old revision accepts a refresh only if `refresh:<jti>` exists in Redis. So the new code keeps, best effort
and after commit:
- SET `refresh:<Y>` on issue, rotation and re-mint;
- DEL `refresh:<X>` on claim and logout;
- the Redis reset marker and key deletes.

Then a rollback logs nobody out as long as Redis is up, which the old revision needs anyway. These writes are
never read by the new code on the normal path. Task 9 removes them after the rollback window.

## Tasks (tests first)

Reviewer tier: every task except Task 7 touches auth, rate limiting / client-IP, or generated types, so each
gets an **Opus** review even if the diff is small. Implementer: Sonnet.

**Task 0: Measure (read-only; owner go-ahead for Neon/Upstash reads).** 0.25 d. Opus.
- Counts:
  - live PG rows;
  - Redis `refresh:*` keys;
  - Redis keys with no row (this decides whether adoption is needed);
  - live rows with no Redis key (the old revision already refuses these: rotated or logged out with a failed PG
    UPDATE, or an evicted key);
  - the Upstash region (for the timeouts).
- Throwaway `backend/cmd/authaudit/main.go`, dry-run only, deleted after; secrets via Secret Manager, never pasted.
- Record the numbers in HANDOFF.

**Task 1: Cache wrapper, breaker and modes.** 1 d.
- Files: `internal/cache/cache.go`, new `internal/cache/cache_test.go`, `internal/config/config.go` (timeouts,
  empty `REDIS_URL` allowed), `cmd/server/main.go` (no Fatalf on Redis; startup expired-row sweep after
  `Migrate`, non-fatal), env docs.
- Tests first:
  - disabled mode makes no network calls;
  - with a refused port (`redis://127.0.0.1:1/0`), `Connect` returns a degraded cache in < 2 s with no error;
  - against a blackhole listener (a `net.Listener` that accepts and never replies), each op returns within the
    op timeout + 100 ms, and the breaker opens after 3 failures;
  - the half-open probe closes the breaker on recovery (miniredis restarted);
  - `redis.Nil` does not trip the breaker;
  - the options carry `MaxRetries == -1`.
- Verify: `cd backend && go test -race ./internal/cache/...`

**Task 2: Rate limiter fallback.** 0.75 d.
- Files: `internal/middleware/ratelimit.go` (+ a new in-memory store), `internal/auth/handlers.go`
  (`rateLimited`, email cap), tests.
- Tests:
  - with Redis down, the `auth` bucket still answers 429 on request 11 within a minute per IP;
  - the login IP+email limit and the email fail cap are enforced from memory;
  - the map stays bounded;
  - with Redis up, behaviour is unchanged (miniredis).
- Verify: `go test -race ./internal/middleware/... ./internal/auth/...`

**Task 3: Health and the remaining `.R` sites.** 0.25 d.
- Files: `internal/server/server.go`, `backend/api/openapi.yaml` (`/healthz` summary), regenerated
  `internal/api/api.gen.go` and `packages/api/src/schema.d.ts`.
- Tests: `/healthz` returns 200 degraded when Redis is down, 503 when the DB is down; `/readyz` returns 200.
- Verify:
  - `go test ./internal/server/...`;
  - `corepack pnpm gen:check`;
  - `grep -rnE '[.]R[.]' backend/internal --include=*.go` shows nothing outside `internal/cache`.

**Task 4: Migration 0054** (D3). 0.25 d.
- File: `internal/db/migrations/0054_refresh_token_authority.sql`.
- Verify: the AU gate migrates an empty DB, and gate case 9 (the old-revision INSERT) passes.

**Task 5: Session store in PG** (D1, D4, D5). 2 d.
- Files: new `internal/auth/sessions.go`, plus `internal/auth/handlers.go`, `store.go`, `reset.go` and tests.
- New `sessions.go` sits behind a small interface (issue tx, rotate, logout), so the handler's status mapping
  can be unit-tested with a fake.
- Rewrite `issue`, `Refresh` and `Logout`. `Authenticate` returns the verified hash; `permissions()` returns an
  error; `Store.ResetPassword` sets `refresh_revoked_before` and the revoke reasons; `reset.go` is reordered (PG
  first, Redis best-effort).
- Delete `refreshUsable`, `revokedSince` and `revokedDuringRotation`. Keep `refreshRevoked`/`markerRevokesAt` only
  for adoption.
- Unit tests first:
  - an insert failure → login 500 with no tokens in the body;
  - every DB error → refresh 503; `ErrNotFound` → 401; a permissions query error → 503;
  - the **status contract table**: refresh answers are always one of 200, 400 (bad body only), 401, 429, 5xx;
  - Redis disabled → refresh 200 via PG;
  - after rotation, Redis has `refresh:<new>` and not `refresh:<old>` (miniredis, D5);
  - reset with a failing PG tx → 500 and no Redis writes;
  - reset with Redis failing after commit → 204 plus a warning log.
- Verify: `go test -race ./internal/auth/... ./internal/server/...`

**Task 5a: Rewrite (do not weaken) the Redis-authority tests.** Included in Task 5.
These tests in `internal/auth/reset_test.go` encode Redis as the authority. Each moves to an equivalent PG
guarantee, proven by a unit test or the AU gate:
- `TestAdminResetPasswordMarkerFailureChangesNothing` → "a failed PG tx changes nothing; a Redis failure after
  commit is harmless".
- `TestRefreshUsableAroundReset` and `TestRefreshHandlerRejectsPreResetToken` → gate case 5.
- `TestRefreshHandlerFailsClosedOnMarkerError` → "the normal refresh path never reads Redis; adoption with Redis
  down → 503 (fail-closed without logout)".
- `TestRevokedDuringRotationKillsNewPair` and `TestRevokedSinceLoginDecision` → gate case 5 (race and login race).
- `TestRefreshRevoked`, `TestRevokeMarkerTTLNeverShorterThanLegacyRefresh` and the reset rejection/canonicalize
  tests stay.

State this in the commit message: the guard moved, it was not weakened (AGENTS.md "Never").

**Task 6: AU PG gate** `TestAuthAuthorityPostgres`, prefix `AU`, port **56455**, slug `au`. 1.25 d.
- Files:
  - new `internal/handlers/auth_authority_integration_test.go` in **`package handlers_test`** (an external test
    package, so it can import `internal/server`; an internal test would create an import cycle);
  - new `internal/handlers/export_test.go`: `var GatePool = gatePool`;
  - `scripts/ci/postgres_gate.py`: add `("AU", "TestAuthAuthorityPostgres", 56455, "au")`. `PACKAGE` stays
    `internal/handlers`.
- The test builds the full router with `server.New(cfg, &db.DB{Pool: pool}, cache, nil)`.
- Verify: `python3 scripts/ci/postgres_gate.py` (hosted CI); locally `--runtime native --pg-bin <pg18/bin> --no-race`.

**Task 7: Docs.** 0.25 d. **Haiku** (no logic).
- `RUNBOOK.md`: health semantics, new env vars, Redis-optional behaviour, rollback note, PG gate count 16 → 17.
- `HANDOFF.md` progress board, and the A33/A07 status lines in `docs/audits/2026-10-14-audit-status-sweep.md`.

**Task 8: Release** (see Rollout). 0.5 d. Opus.

**Task 9: Cleanup release** (at least 14 days later). 0.5 d.
- Drop the Redis dual-write and the Redis reset marker.
- Drop adoption once a Task 0 re-run shows 0 Redis-only live tokens.
- Verify: unit tests + the AU gate.

### AU gate cases (every request also asserts latency < 2 s)

1. **Redis down**, run twice: refused (`redis://127.0.0.1:1/0`) and blackholed (a test listener that accepts
   and never replies):
   - login → 200; refresh → 200;
   - authenticated `GET /api/v1/sync/pull` and a `/sync/batch` sale → 200, and the order is persisted;
   - `/healthz` → 200 `degraded`; `/readyz` → 200;
   - repeated failed logins still hit 429 from the in-memory limiter.
2. **Concurrent refresh:** 20 goroutines present X behind a barrier.
   - Exactly one claim: X revoked, the family has exactly 2 rows, and one live head.
   - Every response is 200 with the **same** refresh jti Y (the losers get the re-mint).
   - No 5xx.
3. **Lost response:**
   - refresh X → Y, and discard the response;
   - present X again → 200 with jti Y, and Y's row is unchanged;
   - present Y → Z;
   - present Y again → 200 with Z (immediate predecessor);
   - present X → 401 (deep reuse), and Z is still live (no family revoke);
   - refreshing with Z works.
4. **Logout:** logout with Y → every row in the family is revoked; replays of X and Y → 401.
5. **Reset:**
   - after `POST /api/v1/users/{id}/reset-password`, every family token → 401, and a new login works;
   - **race:** 30 iterations of rotation running concurrently with reset. Invariant: once both finish, the user
     has 0 live rows, and any refresh token that was returned is refused on its next use;
   - **login race:** authenticate with the old hash, then reset, then issue → 401.
6. **Adoption** (miniredis):
   - `refresh:<J>` in Redis with no row → refresh 200, and the row is created with family J;
   - the same, but with a Redis reset marker newer than iat → 401;
   - no row and Redis down → 503.
7. **Expired / foreign:** an expired JWT → 401; a row whose user_id differs from the claim uid → 401; a deleted
   user (cascade) → 401.
8. **Startup without Redis:** `cache.Connect` with a refused URL returns in < 2 s with no error, and
   `server.New` serves (exercised by case 1). Disabled mode (`REDIS_URL=""`) is the same.
9. **Old-revision compatibility:**
   - a row inserted with the old 3-column INSERT (NULL family) refreshes fine;
   - after an old-style `UPDATE ... SET revoked=true` (no `replaced_by`), a replay → 401.
10. **Cleanup:** a login deletes the user's rows that expired more than 1 day ago; live and revoked-but-unexpired
    rows remain.

## Rollout and rollback

- **One release** (Tasks 1-6 together). This is one migrating deploy and one zero-pending window. Tasks 1-3
  can ship alone first if preferred: they are low-risk and fix startup and latency, but not logouts.
- **Before:**
  - Task 0 numbers;
  - if Task 0 finds **live rows without a Redis key**, those tokens are refused today and would come back to life
    after the cutover. Revoke exactly that list (revoke_reason reconcile; a Neon write that needs the owner's
    per-request go-ahead) immediately before deploying. This preserves today's effective state;
  - a Neon snapshot (A36 rule: a snapshot before every migrating deploy);
  - **all tablets at 0 pending** (owner rule).
- **Deploy:** `scripts/deploy-backend.sh` (tagged, no traffic).
  - Smoke the tag URL:
    - `/readyz` 200 and `/healthz` 200 `ok`;
    - login → refresh → re-present the old refresh token (expect the same new jti) → logout → a replay gets 401;
    - `/sync/pull`.
  - Then `scripts/promote-backend.sh`.
- **Optional prod drill** (owner go-ahead, GCP): deploy one extra **tagged, zero-traffic** revision with
  `REDIS_URL` pointing at an unreachable host, and run the same smoke against its tag URL. This proves
  Redis-optional in the real config with no customer traffic.
- **POS/backoffice impact: none.** No APK and no OTA. Refresh status codes only move toward the client's transient
  set (401 → 503 on DB errors), which keeps more sessions.
  - Confirmed: `packages/api/src/client.ts:389-394` (5xx/429 → transient; other non-OK → rejected) and
    `apps/pos/src/authBoot.ts:16-18` (only 401 rejects at boot).
- **Rollback:** the RUNBOOK traffic switch back to the previous revision at 100%.
  - The schema is additive, so the old revision starts, and its INSERT/UPDATE still work.
  - The dual-written Redis keys (D5) keep tokens issued by the new revision valid on the old one.
  - A rollback *while Redis is down* has today's behaviour (the old revision needs Redis); that is acceptable.
  - Do not roll back past Task 9.

## Risks

1. **Re-mint widens the stolen-old-token window.** A thief holding X before the tablet ever presents Y can obtain
   Y. The exposure is bounded to "successor not yet presented", about 15 min once the tablet is online. On a
   shared-device threat model this is the same exposure as stealing Y. Accepted for availability; there is an
   optional age cap.
2. **Deep reuse is reject-only.** It detects but does not contain a thief who got ahead of the legitimate device.
   This was chosen because the native token write is not durable. Follow-up: persist the refresh token with
   `setDurable` in POS (needs an APK); after that, family revocation could be reconsidered.
3. **The in-memory limiter is per instance** (up to 4x with 4 instances), and its state is lost on cold start.
4. **`users FOR SHARE`** briefly blocks `UpdateUser`/reset behind an in-flight refresh. That is sub-second and benign.
5. **App clock vs DB clock** in `refresh_revoked_before` comparisons. This is defence in depth only.
6. **Rows the old revision already refuses could come back to life** if the Task 0 reconciliation is skipped.
7. **The Upstash TLS round trip may exceed a 500 ms op timeout** if Redis is far from asia-southeast2. That would
   make the breaker flap. Mitigation: env-tunable timeouts; check the Upstash region in Task 0.
8. **The 10/min/IP `auth` bucket also covers `/auth/refresh`.** Many tablets behind one NAT cold-booting together
   can hit 429. This is unchanged by this plan; 429 is transient, so nobody is logged out.
9. **Implementer trap:** go-redis `MaxRetries: 0` silently means 3 retries; the Task 1 test pins `-1`.

## Sizing

| Phase | Tasks | Days |
|---|---|---|
| Measure | 0 | 0.25 |
| Redis-optional infra | 1-3 | 2 |
| PG authority | 4-5 | 2.25 |
| Gate | 6 | 1.25 |
| Docs + release | 7-8 | 0.75 |
| Later cleanup | 9 | 0.5 |

**About 6.5-7 days.** Opus review on everything except Task 7 (Haiku).

## Out of scope / follow-ups

- **A05 offline authority window.** The client currently restores the cached user offline with no expiry. That
  already meets "at least a full trading day". Capping it is a separate POS slice and needs an APK.
- **Upstash usage measurement and thresholds** (rest of A33). The breaker logs open/close events, which gives a
  first signal. `DelByPrefix` SCAN-on-every-write is the main command amplifier; a generation-key invalidation is a
  separate small slice.
- Backoffice polling amplification.
- POS: persist the rotated refresh token with `setDurable` (narrows risk 2).

## Owner confirmations (none change the design; defaults recommended)

- Deep reuse = reject only, no family logout (recommended; see risk 2).
- Role/permission change = no forced re-login; 15-min bound (recommended; matches the availability default).
- Task 0 reads and the possible pre-deploy revoke touch Neon/Upstash: per-request go-ahead.

## Implementation notes from review (these override the sections above where they differ)

1. **The AU gate must not trip the rate limiters, and the limiter must not be loosened to make it pass.**
   - `server.New` puts `/auth/*` behind the 10/min/IP `auth` bucket, and the global `api` bucket is
     `cfg.RateLimitRPS*60`, so a zero-value config rejects everything.
   - The gate builds a real config: strong test secrets, TTLs, `RateLimitRPS`, and `TrustedProxyHops=1`.
   - Each simulated tablet / goroutine sends a distinct `X-Forwarded-For` from TEST-NET (198.51.100.0/24,
     203.0.113.0/24). Check the bucketing against `internal/clientip` tests first.
   - Only case 1's limiter check deliberately reuses one IP, to prove the in-memory 429.
2. **Drop the `refresh_revoked_before` comparison from the claim and re-mint paths.**
   - Reason: `created_at` is the second-truncated JWT iat, while the marker is microsecond DB `now()`. A login in
     the same second after a reset would otherwise be refused on its next refresh, which would flake gate case 5
     and could hit a real cashier.
   - The real guarantee is row revocation in the reset tx under the users row lock.
   - Keep the marker only for **adoption** (D4). Treat a legacy token as revoked when
     `iat <= floor(marker in seconds)`, fail closed. Adoption only ever sees pre-deploy tokens, so this cannot
     refuse a post-reset login.
3. **Adoption race.**
   - Insert the legacy row with `INSERT ... ON CONFLICT (jti) DO NOTHING`, then run the normal claim or re-mint
     logic in the same tx, so two concurrent refreshes of the same legacy token behave like gate case 2.
   - Add that as a sub-case of gate case 6.
4. **Login-race test seam.** Task 5 exports the issue-session entry point that takes the verified password hash
   (for example `(*auth.Store).IssueSession(ctx, user, verifiedHash, ...)`). The external `handlers_test` gate can
   then drive "authenticate → reset → issue → 401" (gate case 5).
5. **Logout racing a rotation.**
   - Logout first takes `SELECT 1 FROM users WHERE id=$uid FOR NO KEY UPDATE`. That conflicts with rotation's
     `FOR SHARE` and keeps the users → tokens lock order.
   - Then it revokes the family.
   - Without this, a successor inserted after logout's snapshot could stay live.
   - Add a race sub-case to gate case 4 (logout running concurrently with refresh, 30 iterations; invariant:
     0 live rows in the family afterwards).
6. **Dual-write TTL (D5):** set `refresh:<jti>` with the token's **remaining** lifetime (`expires_at - now`),
   not the full `RefreshTTL`.

## Owner decisions (2026-10-15)

- Old-token replay: refuse that request only (logged); the rest of the session chain keeps working.
- Role/permission change: no forced re-login; takes effect within the 15-minute access-token lifetime.
- Neon: read-only token count approved; the pre-deploy revoke of rows the current server already refuses is approved (show the count first, run once right before the deploy).
