-- 0017: per-user receive-approval PIN (argon2id hash, reuses auth password format),
-- transfer receive attribution + idempotency, and the org-wide approver-role config.
ALTER TABLE users ADD COLUMN receive_pin_hash   text;        -- NULL = no PIN set
ALTER TABLE users ADD COLUMN receive_pin_set_at timestamptz; -- audit / "PIN set" UI state

ALTER TABLE transfers ADD COLUMN received_by              uuid;  -- approver/admin user id (bare, matches created_by convention)
ALTER TABLE transfers ADD COLUMN received_via             text;  -- 'pos' | 'backoffice'
ALTER TABLE transfers ADD COLUMN received_idempotency_key text;  -- POS offline retry guard (dedup enforced in app logic, not a UNIQUE constraint)

ALTER TABLE app_settings ADD COLUMN receive_approver_roles text[] NOT NULL DEFAULT '{}';
