-- Rupiah value of the loyalty points an order redeemed, frozen at sale time. points_redeemed alone
-- cannot give it back because loyalty_settings.redemption_rate can change later. NULL = the order
-- redeemed nothing, or predates this column and could not be derived.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redemption_amount numeric(14,2);

-- Backfill: the sale path sets total = (subtotal - discounts + surcharge + tax) - redemption, so the
-- redemption is exactly the gap. Only orders that redeemed points, and only a positive gap.
UPDATE orders
   SET points_redemption_amount = (subtotal - discount_amount + COALESCE(surcharge_amount, 0) + tax_amount) - total
 WHERE points_redeemed > 0
   AND points_redemption_amount IS NULL
   AND (subtotal - discount_amount + COALESCE(surcharge_amount, 0) + tax_amount) - total > 0;
