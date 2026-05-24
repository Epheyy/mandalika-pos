-- 0014: per-variant scan key (barcode), replacing the parent products.upc.
-- Defaults to the SKU; catalog-wide unique on non-empty values.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode text NOT NULL DEFAULT '';

-- existing variants scan immediately: default the scan key to the SKU
UPDATE product_variants SET barcode = sku WHERE barcode = '';

-- prefer any real parent UPC: copy it onto the product's first variant
UPDATE product_variants v SET barcode = p.upc
  FROM products p
 WHERE v.product_id = p.id AND p.upc <> ''
   AND v.id = (SELECT id FROM product_variants v2 WHERE v2.product_id = p.id ORDER BY id LIMIT 1);

-- defensively dedupe before the unique index so the migration cannot fail-to-boot
-- (auto-generated SKUs are uuid-derived and effectively unique; this only fires
--  on a genuine cross-product collision)
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY barcode ORDER BY id) AS rn
    FROM product_variants WHERE barcode <> ''
)
UPDATE product_variants v
   SET barcode = v.barcode || '-' || left(replace(v.id::text, '-', ''), 4)
  FROM d WHERE d.id = v.id AND d.rn > 1;

-- catalog-wide unique on non-empty scan keys (empty never collides)
CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_barcode
  ON product_variants (barcode) WHERE barcode <> '';

-- NOTE: products.upc is intentionally NOT dropped here (expand/contract — the
-- old revision still reads it during the rolling deploy). Drop in a later
-- migration once no running revision references it.
