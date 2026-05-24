-- 0012: SKU is the stable CSV-correlation handle → required + unique per product.
-- (Modal identity is the permanent product_variants.id; SKU is the CSV match key
-- and is also enforced unique so correlation is unambiguous.)
UPDATE product_variants
   SET sku = 'SKU-' || left(replace(id::text, '-', ''), 8)
 WHERE sku IS NULL OR sku = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_product_sku
  ON product_variants (product_id, sku);
