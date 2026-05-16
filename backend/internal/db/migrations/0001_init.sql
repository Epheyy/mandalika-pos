-- Mandalika POS — initial schema (Phase A)
-- Mirrors src/types/index.ts. Money = numeric(14,2). Timestamps = timestamptz.
-- Firestore in-doc arrays flattened to child tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Outlets ───────────────────────────────────────────────
CREATE TABLE outlets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  address     text,
  phone       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Users / RBAC ──────────────────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','manager','cashier')),
  outlet_id     uuid REFERENCES outlets(id) ON DELETE SET NULL,
  photo_url     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_permissions (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (user_id, permission)
);

-- users that may serve multiple outlets (admin/manager); empty = single outlet_id
CREATE TABLE user_outlets (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, outlet_id)
);

CREATE TABLE custom_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custom_role_permissions (
  role_id    uuid NOT NULL REFERENCES custom_roles(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- ── Auth sessions (refresh tokens; Redis is primary, this is durable backup) ──
CREATE TABLE refresh_tokens (
  jti        uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

-- ── Catalog ───────────────────────────────────────────────
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  sort_order  integer
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  brand       text NOT NULL DEFAULT '',
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  description text,
  image_url   text,
  is_featured boolean NOT NULL DEFAULT false,
  is_favourite boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_variants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size       text NOT NULL,
  price      numeric(14,2) NOT NULL,
  stock      integer NOT NULL DEFAULT 0,
  sku        text NOT NULL DEFAULT ''
);
CREATE INDEX idx_variants_product ON product_variants(product_id);

CREATE TABLE bundles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  price       numeric(14,2) NOT NULL,
  image_url   text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bundle_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id    uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,
  product_name text NOT NULL,
  variant_size text NOT NULL,
  quantity     integer NOT NULL,
  price        numeric(14,2) NOT NULL
);

-- ── Customers / Loyalty ───────────────────────────────────
CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  phone       text NOT NULL,
  email       text,
  points      integer NOT NULL DEFAULT 0,
  total_spent numeric(14,2) NOT NULL DEFAULT 0,
  visit_count integer NOT NULL DEFAULT 0,
  last_visit  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_phone ON customers(phone);

CREATE TABLE loyalty_settings (
  id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled             boolean NOT NULL DEFAULT false,
  tier_enabled        boolean NOT NULL DEFAULT false,
  points_per_thousand numeric(14,4) NOT NULL DEFAULT 0,
  redemption_rate     numeric(14,4) NOT NULL DEFAULT 0
);

CREATE TABLE loyalty_conditions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  type                   text NOT NULL CHECK (type IN ('always_on','campaign')),
  trigger                text NOT NULL,
  reward_type            text NOT NULL CHECK (reward_type IN ('set_points','multiply_points','product_reward')),
  reward_value           numeric(14,2) NOT NULL DEFAULT 0,
  reward_product_ids     jsonb,
  campaign_start_date    date,
  campaign_end_date      date,
  active_days            jsonb,
  applicable_product_ids jsonb,
  minimum_spend          numeric(14,2),
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ── Promotions ────────────────────────────────────────────
CREATE TABLE promotions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL,
  description             text,
  type                    text NOT NULL CHECK (type IN ('percentage','fixed','bogo')),
  value                   numeric(14,2) NOT NULL,
  min_purchase            numeric(14,2),
  applicable_product_ids  jsonb,
  applicable_variant_keys jsonb,
  applicable_variant_sizes jsonb,
  outlet_ids              jsonb,
  combinable              boolean,
  combinable_with         jsonb,
  active_from_hour        text,
  active_to_hour          text,
  active_days             jsonb,
  is_active               boolean NOT NULL DEFAULT true,
  start_date              date,
  end_date                date,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discount_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  promotion_id uuid REFERENCES promotions(id) ON DELETE SET NULL,
  type         text NOT NULL CHECK (type IN ('percentage','fixed')),
  value        numeric(14,2) NOT NULL,
  min_purchase numeric(14,2),
  usage_limit  integer,
  usage_count  integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  start_date   date,
  end_date     date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_discount_code ON discount_codes(code);

-- ── Devices (offline POS clients) ─────────────────────────
CREATE TABLE devices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id  uuid REFERENCES outlets(id) ON DELETE SET NULL,
  label      text NOT NULL DEFAULT '',
  last_seen  timestamptz
);

-- ── Shifts ────────────────────────────────────────────────
CREATE TABLE shifts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id      uuid NOT NULL REFERENCES outlets(id),
  outlet_name    text,
  cashier_id     uuid NOT NULL,
  cashier_name   text NOT NULL,
  status         text NOT NULL CHECK (status IN ('open','closed')),
  opened_at      timestamptz NOT NULL,
  closed_at      timestamptz,
  starting_cash  numeric(14,2) NOT NULL DEFAULT 0,
  closing_cash   numeric(14,2),
  total_sales    numeric(14,2) NOT NULL DEFAULT 0,
  total_orders   integer NOT NULL DEFAULT 0,
  total_refunds  numeric(14,2) NOT NULL DEFAULT 0,
  cash_sales     numeric(14,2) NOT NULL DEFAULT 0,
  card_sales     numeric(14,2) NOT NULL DEFAULT 0,
  transfer_sales numeric(14,2) NOT NULL DEFAULT 0,
  qris_sales     numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_shifts_opened ON shifts(opened_at DESC);
CREATE INDEX idx_shifts_outlet ON shifts(outlet_id);

-- ── Orders ────────────────────────────────────────────────
CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      text NOT NULL UNIQUE,
  order_uuid        uuid NOT NULL UNIQUE,            -- client-generated
  idempotency_key   text NOT NULL UNIQUE,            -- device_id:order_uuid
  device_id         uuid,
  outlet_id         uuid NOT NULL REFERENCES outlets(id),
  cashier_id        uuid NOT NULL,
  cashier_name      text NOT NULL,
  salesman_id       uuid,
  salesman_name     text,
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name     text,
  subtotal          numeric(14,2) NOT NULL,
  discount_amount   numeric(14,2) NOT NULL DEFAULT 0,
  discount_type     text,
  discount_value    numeric(14,2),
  discount_code     text,
  tax_amount        numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL,
  payment_method    text NOT NULL CHECK (payment_method IN ('cash','card','transfer','qris')),
  amount_paid       numeric(14,2) NOT NULL DEFAULT 0,
  change            numeric(14,2) NOT NULL DEFAULT 0,
  status            text NOT NULL CHECK (status IN ('completed','refunded','cancelled')),
  notes             text,
  refund_reason     text,
  refunded_at       timestamptz,
  shift_id          uuid REFERENCES shifts(id) ON DELETE SET NULL,
  client_created_at timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_created ON orders(created_at DESC);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_shift ON orders(shift_id);
CREATE INDEX idx_orders_outlet ON orders(outlet_id);

CREATE TABLE order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,
  product_name text NOT NULL,
  variant_size text NOT NULL,
  price        numeric(14,2) NOT NULL,
  quantity     integer NOT NULL,
  subtotal     numeric(14,2) NOT NULL,
  is_bundle    boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- durable idempotency ledger (Redis is fast-path, this is source of truth)
CREATE TABLE processed_keys (
  idempotency_key text PRIMARY KEY,
  order_id        uuid REFERENCES orders(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Stock counts ──────────────────────────────────────────
CREATE TABLE stock_counts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('planned','in_progress','completed','cancelled')),
  outlet_id    uuid NOT NULL REFERENCES outlets(id),
  planned_date date,
  started_at   timestamptz,
  completed_at timestamptz,
  notes        text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_count_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL,
  product_name   text NOT NULL,
  variant_size   text NOT NULL,
  sku            text NOT NULL DEFAULT '',
  frozen_qty     integer NOT NULL DEFAULT 0,
  actual_qty     integer,
  difference     integer
);

-- ── Cash flow / sync log (confirmed shapes from CashierScreen.tsx:606/:689) ──
CREATE TABLE cash_flows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id    uuid NOT NULL REFERENCES outlets(id),
  shift_id     uuid REFERENCES shifts(id) ON DELETE SET NULL,
  type         text NOT NULL,
  amount       numeric(14,2) NOT NULL,
  description  text NOT NULL,
  cashier_id   uuid,
  cashier_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cashflows_created ON cash_flows(created_at DESC);

CREATE TABLE sync_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id    uuid,
  cashier_id   uuid,
  cashier_name text,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  counts       jsonb
);

-- ── App settings singleton ────────────────────────────────
CREATE TABLE app_settings (
  id                    integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tax_enabled           boolean NOT NULL DEFAULT false,
  tax_rate              numeric(7,4) NOT NULL DEFAULT 0,
  rounding_enabled      boolean NOT NULL DEFAULT false,
  rounding_type         text NOT NULL DEFAULT 'none',
  rounding_amount       numeric(14,2),
  rounding_direction    text,
  rounding_apply_to_tax boolean,
  auto_open_shift       boolean NOT NULL DEFAULT false,
  payment_methods       jsonb NOT NULL DEFAULT '[]'::jsonb,
  receipt               jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ── Content version (Backoffice → POS sync wall, per outlet) ──
CREATE TABLE content_versions (
  outlet_id     uuid PRIMARY KEY,
  version       bigint NOT NULL DEFAULT 1,
  data_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO loyalty_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
