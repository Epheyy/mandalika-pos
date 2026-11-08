-- Rupiah value of the loyalty points an order redeemed, frozen at sale time. points_redeemed alone
-- cannot give it back because loyalty_settings.redemption_rate can change later. NULL = the order
-- redeemed nothing, or predates this column and could not be derived with certainty.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redemption_amount numeric(14,2);

-- Backfill, conservatively. total = round(subtotal - discounts + surcharge + tax) - redemption, so the
-- gap between the lines and total is the redemption PLUS any rounding. Only trust the gap when it equals
-- points_redeemed x the current redemption_rate (to the sen); anything else stays NULL and the POS shows the
-- old combined "Tukar poin / pembulatan" row for it.
UPDATE orders o
   SET points_redemption_amount = o.points_redeemed * ls.redemption_rate
  FROM loyalty_settings ls
 WHERE o.points_redeemed > 0
   AND o.points_redemption_amount IS NULL
   AND ls.redemption_rate > 0
   AND abs((o.subtotal - o.discount_amount + COALESCE(o.surcharge_amount, 0) + o.tax_amount - o.total)
           - o.points_redeemed * ls.redemption_rate) < 0.01;
