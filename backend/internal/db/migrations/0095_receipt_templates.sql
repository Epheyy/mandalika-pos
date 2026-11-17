-- 0095: receipt templates (receipt designer, phase 2). A template is a named, ordered list of blocks
-- plus a paper width. Standar stays virtual until someone saves it: with no row the tablet prints
-- its built-in layout. At most one row is the default (is_default), used by every outlet without an
-- assignment; an outlet is assigned a template through outlets.receipt_template_id. New table and
-- one nullable column, additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE receipt_templates (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  paper_width smallint    NOT NULL CHECK (paper_width IN (58, 80)),
  blocks      jsonb       NOT NULL,
  is_default  boolean     NOT NULL DEFAULT false,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE UNIQUE INDEX receipt_templates_name_uq ON receipt_templates (lower(btrim(name)));
CREATE UNIQUE INDEX receipt_templates_default_uq ON receipt_templates (is_default) WHERE is_default;

-- Backstop only: the write path refuses to delete an assigned template.
ALTER TABLE outlets
  ADD COLUMN receipt_template_id uuid REFERENCES receipt_templates (id) ON DELETE SET NULL;
