SET LOCAL lock_timeout = '5s';
-- Pergerakan splits stock arriving by goods receipt into supply and warranty replacements
-- ("Garansi"). Additive: every existing receipt is 'supply' (constant default, no table rewrite);
-- a rollback just leaves the column unread.
ALTER TABLE goods_receipts
  ADD COLUMN source text NOT NULL DEFAULT 'supply' CHECK (source IN ('supply', 'warranty'));
