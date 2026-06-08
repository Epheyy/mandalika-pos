-- 0028_customer_tags.sql
-- SP-CRM-4: managed customer tags (many-to-many).
CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  color      text NOT NULL,
  sort_order integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_tags (
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
  PRIMARY KEY (customer_id, tag_id)
);
CREATE INDEX idx_customer_tags_tag ON customer_tags(tag_id);
