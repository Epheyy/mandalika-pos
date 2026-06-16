-- SP-Promo-3c: a promotion marked code_only is hidden from the POS browse panel
-- and resolves ONLY when unlocked by a linked discount code (discount_codes.promotion_id).
-- Default false = unchanged behavior for every existing promotion.
ALTER TABLE promotions
  ADD COLUMN code_only boolean NOT NULL DEFAULT false;
