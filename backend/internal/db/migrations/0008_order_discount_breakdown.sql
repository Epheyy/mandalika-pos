-- Itemized discount components for an order, denormalized at sale time so the
-- POS history, backoffice, and analyst exports can show EACH applied discount
-- (manual + promo code + promotion can stack) with its own nominal — instead of
-- collapsing them into a single "Diskon" line. Array of
-- {label, kind, value, amount}. Nullable: orders with 0/1 simple discount and
-- pre-feature orders have none (fall back to discount_label/discount_amount).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_breakdown jsonb;
