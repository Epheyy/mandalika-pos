-- A08: online step-up approval for POS transfer receive. Additive only (new tables, one
-- version bump); the previous revision ignores them, so rollback is a plain redeploy.
--
-- A grant is minted online after the approver's PIN is verified on the server, and is
-- consumed once inside the receive transaction. It is bound to one receipt key, outlet,
-- requesting user and count fingerprint. The PIN itself is never stored.
CREATE TABLE transfer_receive_approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id    uuid NOT NULL REFERENCES outlets(id),
  transfer_id  uuid NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  receipt_key  text NOT NULL,
  fingerprint  text NOT NULL,
  requested_by uuid NOT NULL,            -- bare: the JWT user; no FK so a deleted user cannot block history
  device_id    text NOT NULL DEFAULT '',  -- advisory only
  approver_id  uuid NOT NULL,            -- bare: a deleted approver means the grant is revoked
  pin_set_at   timestamptz NOT NULL,     -- the approver's receive_pin_set_at when verified
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  consumed_key text,
  UNIQUE (outlet_id, receipt_key)
);
CREATE INDEX transfer_receive_approvals_transfer_idx ON transfer_receive_approvals (transfer_id);

-- Server-side lockout state, independent of client IP. Postgres is the authority.
CREATE TABLE receive_pin_lockouts (
  subject_kind text NOT NULL CHECK (subject_kind IN ('approver','requester')),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  failures     int NOT NULL DEFAULT 0,
  lock_cycles  int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  hard_locked  boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, user_id)
);

-- Append-only audit of approval attempts. No PIN, no hash.
CREATE TABLE receive_pin_attempts (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  outlet_id    uuid,
  requester_id uuid,
  approver_id  uuid,
  transfer_id  uuid,
  device_id    text NOT NULL DEFAULT '',
  outcome      text NOT NULL CHECK (outcome IN ('granted','wrong_pin','ineligible','locked','reset'))
);
CREATE INDEX receive_pin_attempts_approver_at_idx ON receive_pin_attempts (approver_id, at);

-- Old bundles re-pull promptly and overwrite their cached receiveApprovers (hashes).
UPDATE content_versions SET version = version + 1, updated_at = now();
