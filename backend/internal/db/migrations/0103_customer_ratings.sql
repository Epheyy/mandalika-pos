-- 0103: customer rating of the salesperson via a WhatsApp receipt link. Additive.
-- app_settings first, then the tables that reference orders (lock order of 0079).
-- Tokens are never stored (SHA-256 only); the recipient is stored masked; no raw IPs.
SET LOCAL lock_timeout = '5s';

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS wa_receipt_template text
  CHECK (wa_receipt_template IS NULL OR char_length(wa_receipt_template) BETWEEN 1 AND 1000);

CREATE TABLE receipt_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  outlet_id        uuid NOT NULL,
  token_hash       bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  recipient_masked text NOT NULL,
  recipient_source text NOT NULL CHECK (recipient_source IN ('customer','typed')),
  created_by       uuid NOT NULL,
  created_by_name  text NOT NULL DEFAULT '',
  device_id        text,
  net_salt         bytea NOT NULL CHECK (octet_length(net_salt) = 16),
  net_hash         bytea NOT NULL CHECK (octet_length(net_hash) = 32),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX idx_receipt_links_order ON receipt_links (order_id);

CREATE TABLE order_ratings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  link_id           uuid NOT NULL REFERENCES receipt_links(id) ON DELETE CASCADE,
  outlet_id         uuid NOT NULL,
  salesman_id       uuid,
  salesman_name     text,
  business_date     date NOT NULL,           -- copy of orders.business_date (outlet zone, 0059)
  stars             smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags              text[] NOT NULL DEFAULT '{}'
                    CHECK (tags <@ ARRAY['ramah','membantu','paham_produk','cepat']::text[]),
  comment           text CHECK (comment IS NULL OR char_length(comment) <= 500),
  flag_fast         boolean NOT NULL DEFAULT false,
  flag_same_network boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_ratings_period ON order_ratings (business_date, outlet_id);
CREATE INDEX idx_order_ratings_salesman ON order_ratings (salesman_id, business_date);
