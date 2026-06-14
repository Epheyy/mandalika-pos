-- SP-Promo-3a: discount-code stacking gate + multi-code refund bookkeeping.
-- discount_codes.combinable mirrors promotions.combinable (a code may stack with
-- other combinable discounts only when explicitly flagged; default exclusive).
-- orders.applied_discount_codes records EVERY code applied to an order (array of
-- code strings) so a refund can restore each code's usage_count. Nullable: orders
-- with 0 codes (and pre-feature orders) have none; refund falls back to discount_code.
ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS combinable boolean NOT NULL DEFAULT false;
ALTER TABLE orders         ADD COLUMN IF NOT EXISTS applied_discount_codes jsonb;
