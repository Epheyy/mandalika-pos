-- 0097: multi-outlet coverage. A manager can be flagged to cover every outlet (users.all_outlets); the
-- flag and a home outlet are mutually exclusive. Additive only: existing rows default to false, so the
-- CHECK holds for every existing row at creation.
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS all_outlets boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_all_outlets_no_home CHECK (NOT all_outlets OR outlet_id IS NULL);
