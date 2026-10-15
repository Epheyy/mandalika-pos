-- A33/A07: Postgres is the refresh-token authority (Redis becomes an optional cache).
-- Additive only: every new column is nullable and reads use COALESCE(family_id, jti),
-- so existing live rows stay valid and the previous revision's 3-column INSERT and
-- `UPDATE ... SET revoked=true` keep working (rollback safe). No backfill.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS family_id     uuid,
  ADD COLUMN IF NOT EXISTS replaced_by   uuid,
  ADD COLUMN IF NOT EXISTS revoked_at    timestamptz,
  ADD COLUMN IF NOT EXISTS revoke_reason text
    CHECK (revoke_reason IN ('rotated','logout','reset','reconcile'));

-- the rotation chain stays linear: a token has at most one successor
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_replaced_by_uidx
  ON refresh_tokens (replaced_by) WHERE replaced_by IS NOT NULL;
-- at most one live head per family
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_live_head_uidx
  ON refresh_tokens (family_id) WHERE NOT revoked AND family_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- Set by an admin password reset. Only consulted when adopting a legacy
-- (Redis-only) token; the primary effect of a reset is row revocation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_revoked_before timestamptz;
