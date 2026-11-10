-- Instant permission revocation: a per-user rights version.
--
-- Every write that changes what an access token grants (role, outlet, permissions,
-- password reset) bumps users.perm_version in the same transaction. The access
-- token carries it as claim "pv"; RequireAuth refuses a token whose pv is below
-- the user's current version (401, refreshable), so a revoked right stops working
-- within seconds instead of at token expiry (15 min).
--
-- Additive and safe to roll back: the previous revision ignores both the column
-- and the claim. Metadata-only on PG >= 11 (constant default), no backfill: a
-- token without the claim reads as 0, which equals the default, so the rollout
-- logs nobody out.
--
-- Supersedes the A33 D1 note "token_version is not added".
ALTER TABLE users ADD COLUMN IF NOT EXISTS perm_version bigint NOT NULL DEFAULT 0;

-- Serves the open-shift check on a user delete / outlet move (hasOpenShift).
CREATE INDEX IF NOT EXISTS idx_shifts_open_cashier ON shifts (cashier_id) WHERE status = 'open';
