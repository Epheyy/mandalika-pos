-- Human-readable source of an order's discount, denormalized at sale time so
-- data analysts can see WHICH promotion/code/manual discount applied even after
-- the promotion is renamed or deleted. promotion name > promo code > "Manual".
-- Nullable: orders with no discount (and pre-feature orders) have none.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_label text;
