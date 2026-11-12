-- 0089: bundle price settings. A bundle (large bottle + 10ml atomizer + 2ml vial of the same ERP
-- line) is derived from the variants; only its PRICE is stored: a standard price per large size
-- (line = '') and an optional price per ERP line and size. New table, no lock on existing ones.
SET LOCAL lock_timeout = '5s';

CREATE TABLE bundle_prices (
  line       text          NOT NULL DEFAULT '',
  size       text          NOT NULL CHECK (size ~ '^[0-9]+ml$'),
  price      numeric(14,2) NOT NULL CHECK (price > 0 AND price = trunc(price)),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (line, size)
);
