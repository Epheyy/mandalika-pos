# Admin reset password (plan, 2026-10-11)

Planned by the Opus planner (read-only) against `prod-hardening` @ `11b4d7a`. Owner decisions:
admin types the new password (same strength rule as user creation); no forced change at next login;
reset revokes all the user's sessions; admins can reset anyone.

## Findings that shape the design

- Hashing: argon2id in `backend/internal/auth/password.go` (reuse `HashPassword`).
- "Same strength rule" is only OpenAPI `minLength: 8` — **not enforced at runtime anywhere** (no
  request validator; `CreateUser`, `AddUserModal`, CSV import default `changeme123`). New
  `ValidatePassword` (≥8 runes).
- Sessions: `issue()` writes Redis `refresh:<jti>` + a `refresh_tokens` row (insert error ignored);
  `Refresh` checks **only Redis**. Deployed `JWT_REFRESH_TTL_HOURS=8760` (1 year). Access JWT 15 min,
  stateless `RequireAuth` → old access tokens live ≤15 min after a reset.
- Admin routes are hand-wired chi under `mw.RequireRole("admin")` (`internal/server/server.go:285-301`);
  REST errors via `httpx.Err` (`apperr` is sync-only). No audit table → structured `slog` line.
- Existing bypass: `PUT /users/{id}` with `password` rehashes without strength check or revocation
  (no UI caller sends it). `UpdateUser` 404 branch is dead (no `RowsAffected` check).
- POS effect: refresh 401 → `clear()` drops token + cached user only; outbox untouched (queued sales
  stay; with A04 open they flush under whoever logs in next).

## Design

`POST /api/v1/users/{id}/reset-password` (`resetUserPassword`), body `{password}` → 204 no body;
400 weak/invalid body/non-UUID id (parse before SQL); 401/403 via middleware; 404 unknown
(`RowsAffected()==0`); 500 DB/Redis. Fail-safe order: validate → hash → Redis marker
`refresh_revoked_before:<uid>` = now+1 (TTL = RefreshTTL; `Refresh` rejects iat < marker) → tx
(update hash RETURNING email; revoke `refresh_tokens` rows) → delete `refresh:<jti>` keys for the
user's unexpired jtis → clear per-account lockout key. Code in `auth/reset.go`
(`AdminResetPassword`). Audit `slog.Info("admin_password_reset", actor, target, role, count,
request_id, ip)`; never log password/hash or echo raw errors. No migration, no APK.

## Tasks (Sonnet; Opus review on T1–T5)

T1 `ValidatePassword` + tests → T2 refresh-marker check + reset core (fake store, miniredis tests,
log-redaction test) → T3 OpenAPI + route + regen + router 401/403 test → T4 close PUT password
bypass (if approved) → T5 `client.ts resetUserPassword` → T6 backoffice `ResetPasswordModal`
(KeyRound button next to Edit, admin-only, pure validator + node test, warning text, inline success
banner — no toast system exists) → T7 verify + hidden-revision deploy (`--no-traffic --tag pwreset`)
+ hosted smoke with a throwaway user, then shift traffic; backoffice via Cloudflare push.

## Risks

≤15 min access-token validity after reset (unless `RequireAuth` checks the marker); Redis eviction
policy unknown (jti deletes still revoke); ~1 s race precision; miniredis adds a test-only Go dep;
PG gate has no Redis, so end-to-end proof is the hosted smoke.

## Owner questions

See the session; answers recorded below when given.

**Owner answers (2026-10-11):** block self-reset (403) AND remove `password` from `PUT /users/{id}`
(T4 in scope); accept ≤15 min access-token validity (no RequireAuth marker check); approve
miniredis (test-only) + throwaway-user hosted smoke on Neon test DB; maxLength 128; clear the
per-account lockout on reset; inline success banner; ≥8 on create/CSV = separate follow-up.
