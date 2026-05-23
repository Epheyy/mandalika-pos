-- 0010: per-outlet inventory & pricing. product_variants.stock/.price stay as
-- legacy mirror / base default; these tables are the per-outlet source of truth.
-- Natural key (outlet_id, product_id, variant_size) matches order_items and the
-- order stock-decrement path so nothing orphans when variants are re-inserted.

CREATE TABLE IF NOT EXISTS outlet_variant_stock (
  outlet_id    uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  stock        integer NOT NULL DEFAULT 0,
  par_level    integer,
  PRIMARY KEY (outlet_id, product_id, variant_size)
);

CREATE TABLE IF NOT EXISTS outlet_variant_price (
  outlet_id    uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_size text NOT NULL,
  price        numeric(14,2) NOT NULL,
  PRIMARY KEY (outlet_id, product_id, variant_size)
);

CREATE TABLE IF NOT EXISTS outlet_product_availability (
  outlet_id  uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  available  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (outlet_id, product_id)
);

-- Backfill current global stock into the PRIMARY outlet (most completed orders,
-- tie-break oldest active outlet). Other outlets start at 0; no price overrides;
-- everything available. Idempotent via ON CONFLICT (re-run safe).
WITH primary_outlet AS (
  SELECT o.id
  FROM outlets o
  LEFT JOIN (
    SELECT outlet_id, count(*) AS n FROM orders
    WHERE status = 'completed' GROUP BY outlet_id
  ) oc ON oc.outlet_id = o.id
  WHERE o.is_active
  ORDER BY COALESCE(oc.n, 0) DESC, o.created_at ASC
  LIMIT 1
)
INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
SELECT (SELECT id FROM primary_outlet), v.product_id, v.size, v.stock
FROM product_variants v
WHERE (SELECT id FROM primary_outlet) IS NOT NULL
ON CONFLICT (outlet_id, product_id, variant_size) DO NOTHING;
