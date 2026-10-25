-- Inventory controls S2: the per-outlet, per-sale giveaway item (the canvas bag). One row per
-- outlet; no row = no giveaway, so the deploy is inert until an admin configures it.
--
-- product_id has no FK on purpose: a product delete must not hit a raw 23503 here. A vanished
-- variant is handled at sale time (the hook skips and logs) and shown as "tidak valid" on the
-- setting screen.
--
-- Additive only: a new table the previous revision ignores, so rollback is a plain redeploy.
SET LOCAL lock_timeout = '5s';
CREATE TABLE outlet_giveaways (
  outlet_id    uuid PRIMARY KEY REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,
  variant_size text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
