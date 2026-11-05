-- 0083: a promotion marked auto_apply enters the POS cart on its own when it qualifies.
-- Default false = every existing promotion keeps today's manual "+ Tambah" behaviour.
-- A constant default, so the add is metadata-only (no table rewrite). No backfill.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS auto_apply boolean NOT NULL DEFAULT false;
