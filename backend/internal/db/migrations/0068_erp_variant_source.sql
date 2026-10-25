-- ERP catalog pull: what each finished good last said about its product (2026-10-25).
-- A POS product groups the sizes of one fragrance; its name and category follow the
-- sizes' ERP values in owner order (active sizes first, then the smallest FG code).
-- Storing every size's own values lets the pull hand the product over to the next size
-- in the same transaction when the owner is discontinued, deleted or reconciled away,
-- instead of waiting until that size is pulled again.
--   product_variants.erp_name      <- IntegrationFG.name minus its size token
--   product_variants.erp_category  <- IntegrationFG.category (collapsed spaces; NULL when blank)
-- Both stay NULL until the next pull applies the FG (rows created before this migration,
-- and variants that are not ERP-linked). Additive and nullable: no backfill, no lock beyond
-- the brief ALTER. Number 0067 is reserved for the global SKU unique index (separate deploy).
-- erp_name is never NULL once stored (an FG always has a name), so erp_name IS NULL on a
-- linked variant means "not stored yet"; the pull keeps the product as it is while such a
-- row outranks the stored ones (catalog_source.go).
SET LOCAL lock_timeout = '5s';
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS erp_name     text,
  ADD COLUMN IF NOT EXISTS erp_category text;
