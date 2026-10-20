-- A15 Phase B: per-outlet stock change counter. Every transaction that changes an
-- outlet's on-hand stock bumps its outlet's row exactly once, as its LAST statement,
-- so the counter is ordered by commit and gapless. Tablets use it to learn that stock
-- changed somewhere else (another tablet's sale, a refund, a backoffice receipt).
--
-- Additive only: a new table, no change to outlet_variant_stock (no lock or rewrite on
-- the hot table); the previous revision ignores it, so rollback is a plain redeploy.
-- Never drop and recreate it: that would reset every counter to 0.
--
-- Numbering note: prod already applied 0058..0063 and the runner tracks files by name,
-- so a fresh database runs this file BEFORE 0058. It depends only on outlets.
SET LOCAL lock_timeout = '5s';

CREATE TABLE outlet_stock_seq (
  outlet_id  uuid PRIMARY KEY REFERENCES outlets(id) ON DELETE CASCADE,
  seq        bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO outlet_stock_seq (outlet_id) SELECT id FROM outlets ON CONFLICT DO NOTHING;
