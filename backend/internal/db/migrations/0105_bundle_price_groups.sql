-- 0105: bundle price groups. A group is a named set of bundle prices; outlets point at one
-- (NULL = the default group, Standar). Existing bundle_prices rows become Standar through the
-- constant column default, so there is no table rewrite and a pre-groups writer that omits
-- group_id keeps landing in Standar. bundle_price_revision is the stale-save counter.
SET LOCAL lock_timeout = '5s';

CREATE TABLE price_groups (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 40),
  is_default boolean     NOT NULL DEFAULT false,
  sort_order int         NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX price_groups_name_lower ON price_groups (lower(name));
CREATE UNIQUE INDEX price_groups_one_default ON price_groups (is_default) WHERE is_default;

INSERT INTO price_groups (id, name, is_default, sort_order) VALUES
  ('5ad7a12d-0000-4000-8000-000000000001', 'Standar', true, 0),
  ('5ad7a12d-0000-4000-8000-000000000002', 'Premium', false, 1);

ALTER TABLE outlets ADD COLUMN price_group_id uuid REFERENCES price_groups(id);

ALTER TABLE bundle_prices
  ADD COLUMN group_id uuid NOT NULL DEFAULT '5ad7a12d-0000-4000-8000-000000000001'
    REFERENCES price_groups(id) ON DELETE CASCADE;
ALTER TABLE bundle_prices DROP CONSTRAINT bundle_prices_pkey;
ALTER TABLE bundle_prices ADD CONSTRAINT bundle_prices_pkey PRIMARY KEY (group_id, line, size);

CREATE TABLE bundle_price_revision (
  id       boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision bigint  NOT NULL
);
INSERT INTO bundle_price_revision (id, revision) VALUES (true, 1);
