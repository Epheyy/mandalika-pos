-- 0024: allow deleting an ingredient even when historical recipe versions
-- reference it. recipe_ingredients already stores frozen name/unit/cost
-- snapshots, so a deleted ingredient's history stays intact via those columns.
-- We change the FK to SET NULL + make ingredient_id nullable. The composite PK
-- (version_id, ingredient_id) is replaced by a surrogate id PK + a partial
-- unique index so a version still can't list the same LIVE ingredient twice.

ALTER TABLE recipe_ingredients DROP CONSTRAINT recipe_ingredients_pkey;
ALTER TABLE recipe_ingredients ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE recipe_ingredients ADD CONSTRAINT recipe_ingredients_pkey PRIMARY KEY (id);

ALTER TABLE recipe_ingredients ALTER COLUMN ingredient_id DROP NOT NULL;
ALTER TABLE recipe_ingredients DROP CONSTRAINT recipe_ingredients_ingredient_id_fkey;
ALTER TABLE recipe_ingredients ADD CONSTRAINT recipe_ingredients_ingredient_id_fkey
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_recipe_ingredients_version_ing
  ON recipe_ingredients (version_id, ingredient_id) WHERE ingredient_id IS NOT NULL;

-- The dropped composite PK used to index version_id lookups (the recipe read
-- filters `WHERE ri.version_id = $1`); restore a plain index for that path.
CREATE INDEX idx_recipe_ingredients_version ON recipe_ingredients (version_id);
