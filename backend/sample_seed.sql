-- Sample data for local dev (Mandalika POS). Safe to re-run: clears sample
-- catalog rows first. Does NOT touch users/orders/shifts.
BEGIN;

-- Catalog only. Do NOT TRUNCATE outlets — it cascades to users/orders/shifts.
TRUNCATE product_variants, products, categories RESTART IDENTITY CASCADE;
DELETE FROM outlets WHERE id = '11111111-1111-1111-1111-111111111111';

INSERT INTO outlets (id, name, address, phone)
VALUES ('11111111-1111-1111-1111-111111111111',
        'Mandalika Coffee — Pusat', 'Jl. Raya Kuta No. 1, Lombok', '0370-123456');

WITH cat AS (
  INSERT INTO categories (name, description, sort_order) VALUES
    ('Kopi',     'Minuman berbasis espresso', 1),
    ('Non-Kopi', 'Teh, coklat, dan lainnya',  2),
    ('Makanan',  'Pastry & snack',            3)
  RETURNING id, name
),
prod AS (
  INSERT INTO products (name, brand, category_id, is_active, is_featured)
  SELECT p.name, 'Mandalika', c.id, true, p.featured
  FROM (VALUES
    ('Espresso',           'Kopi',     true),
    ('Caffè Latte',        'Kopi',     true),
    ('Cappuccino',         'Kopi',     false),
    ('Americano',          'Kopi',     false),
    ('Matcha Latte',       'Non-Kopi', true),
    ('Coklat Panas',       'Non-Kopi', false),
    ('Croissant Butter',   'Makanan',  false),
    ('Pisang Goreng',      'Makanan',  true)
  ) AS p(name, cat, featured)
  JOIN cat c ON c.name = p.cat
  RETURNING id, name
)
INSERT INTO product_variants (product_id, size, price, stock, sku)
SELECT pr.id, v.size, v.price, v.stock, v.sku
FROM prod pr
JOIN (VALUES
  ('Espresso',         'Reguler', 18000, 100, 'ESP-R'),
  ('Caffè Latte',      'Reguler', 28000,  80, 'LAT-R'),
  ('Caffè Latte',      'Large',   33000,  80, 'LAT-L'),
  ('Cappuccino',       'Reguler', 28000,  80, 'CAP-R'),
  ('Americano',        'Reguler', 22000,  90, 'AME-R'),
  ('Matcha Latte',     'Reguler', 30000,  60, 'MAT-R'),
  ('Coklat Panas',     'Reguler', 25000,  70, 'CHO-R'),
  ('Croissant Butter', 'Satuan',  20000,  40, 'CRO-1'),
  ('Pisang Goreng',    'Porsi',   15000,  50, 'PIS-1')
) AS v(pname, size, price, stock, sku) ON v.pname = pr.name;

-- Bind any outlet-less users (e.g. seeded admin) to the sample outlet so
-- /sync/pull has a valid outlet scope. Without this the POS snapshot is empty.
UPDATE users
SET outlet_id = '11111111-1111-1111-1111-111111111111'
WHERE outlet_id IS NULL;

COMMIT;
