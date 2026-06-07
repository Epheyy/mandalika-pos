-- 0026_customer_scale_indexes.sql
-- SP-CRM-2: make the customer list index-backed at 100k-500k rows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Substring search (ILIKE '%q%') across the 3 searched fields. Separate GIN
-- trigram indexes preserve the existing OR semantics (planner BitmapOrs them).
CREATE INDEX idx_customers_name_trgm  ON customers USING gin (name  gin_trgm_ops);
CREATE INDEX idx_customers_phone_trgm ON customers USING gin (phone gin_trgm_ops);
CREATE INDEX idx_customers_email_trgm ON customers USING gin (email gin_trgm_ops);

-- Sort-toggle support (belanja = total_spent, terbaru = created_at).
CREATE INDEX idx_customers_spent   ON customers (total_spent DESC, created_at DESC);
CREATE INDEX idx_customers_created ON customers (created_at DESC);
