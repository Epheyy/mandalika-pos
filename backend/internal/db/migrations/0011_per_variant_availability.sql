-- 0011: per-VARIANT availability (was per-product in 0010). Availability now lives
-- on outlet_variant_stock (same grain as stock/price). outlet_product_availability
-- becomes vestigial — migrated below, no longer read/written.

ALTER TABLE outlet_variant_stock
  ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true;

-- Carry forward any product-level hides from 0010: ensure a stock row exists for
-- every variant of a hidden (outlet, product) and mark it unavailable.
INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock, available)
SELECT a.outlet_id, a.product_id, v.size, 0, false
FROM outlet_product_availability a
JOIN product_variants v ON v.product_id = a.product_id
WHERE a.available = false
ON CONFLICT (outlet_id, product_id, variant_size) DO UPDATE SET available = false;
