-- 0020: ingredient SKU + categories.
-- SKU is catalog-wide unique via partial index (empty strings excluded — mirrors
-- product_variants.barcode pattern from SP1.5 migration 0014).
-- Categories: separate table from products.categories to keep the ingredient
-- subsystem fully decoupled; FK on ingredients with ON DELETE SET NULL so
-- deleting a category doesn't orphan ingredients.

CREATE TABLE ingredient_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  sort_order integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ingredients ADD COLUMN sku text NOT NULL DEFAULT '';
ALTER TABLE ingredients ADD COLUMN category_id uuid REFERENCES ingredient_categories(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_ingredient_sku ON ingredients(sku) WHERE sku <> '';
CREATE INDEX idx_ingredients_category ON ingredients(category_id);
