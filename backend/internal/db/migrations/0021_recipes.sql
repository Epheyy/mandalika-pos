-- 0021: per-variant recipes with full version history (SP-Recipe-2).
-- Backoffice-only; gated by app_settings.recipes_enabled. Deletion only via
-- variant cascade (no manual delete). current_version_id is a write-maintained
-- pointer (intentionally NOT a hard FK — avoids a circular create-order
-- dependency inside the first-save transaction).

CREATE TABLE recipes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id         uuid NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE CASCADE,
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id)
);

CREATE TABLE recipe_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id         uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version_no        int  NOT NULL,
  notes             text,
  total_cost_cached numeric(14,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  UNIQUE (recipe_id, version_no)
);
CREATE INDEX idx_recipe_versions_recipe ON recipe_versions(recipe_id);

CREATE TABLE recipe_ingredients (
  version_id    uuid NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  qty           numeric(14,3) NOT NULL CHECK (qty > 0),
  name_at_save  text NOT NULL,
  unit_at_save  text NOT NULL,
  cost_at_save  numeric(14,2),
  sort_order    int  NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, ingredient_id)
);
