-- 0099_promotion_versions.sql
-- A10: a version stamp on promotions and discount codes. It starts at 1 and is bumped on every
-- rule/definition edit (never on usage_count changes), so a sale's discountBreakdown can name the exact
-- version it was priced with. Additive only; nothing reads it for pricing.

ALTER TABLE promotions ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE discount_codes ADD COLUMN version integer NOT NULL DEFAULT 1;
