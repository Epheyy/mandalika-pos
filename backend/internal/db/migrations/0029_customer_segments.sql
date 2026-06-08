-- 0029_customer_segments.sql
-- SP-CRM-5a: configurable RFM segment rules. Segment is DERIVED (never stored on
-- customers); these rows are the editable rule set. First-match by sort_order.
CREATE TABLE customer_segments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  color      text NOT NULL,
  sort_order integer NOT NULL,
  r_min      integer,   -- days since last visit, inclusive
  r_max      integer,
  f_min      integer,   -- visit count, inclusive
  f_max      integer,
  m_min      numeric,   -- total spent, inclusive
  m_max      numeric,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_segments_order ON customer_segments(sort_order);

INSERT INTO customer_segments (name, color, sort_order, r_min, r_max, f_min, f_max, m_min, m_max) VALUES
  ('Baru',     'blue',   1, NULL, NULL, NULL, 1,    NULL,    NULL),
  ('Juara',    'purple', 2, NULL, 30,   5,    NULL, 2000000, NULL),
  ('Setia',    'green',  3, NULL, 60,   3,    NULL, NULL,    NULL),
  ('Berisiko', 'amber',  4, 60,   120,  2,    NULL, NULL,    NULL),
  ('Hilang',   'red',    5, 120,  NULL, NULL, NULL, NULL,    NULL),
  ('Biasa',    'gray',   6, NULL, NULL, NULL, NULL, NULL,    NULL);
