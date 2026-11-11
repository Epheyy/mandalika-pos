-- 0088: trigram indexes for the orders text search (GET /orders?q=, list and keyset export).
--
-- The search ORs three order columns (order_number, cashier_name, customer_name). A BitmapOr only
-- happens when every OR arm has an index, so all three get one. Same shape as the customer search
-- indexes (0026, 0082). pg_trgm already exists (0026).
--
-- fastupdate = off: every sale insert pays a small, steady GIN cost instead of an occasional
-- foreground pending-list flush inside a sync batch.
--
-- LOCK NOTE. The migration runner wraps each file in a transaction, so this is a plain CREATE
-- INDEX (CONCURRENTLY cannot run in a transaction). It takes a SHARE lock on orders: every sale,
-- refund and status write waits for the whole build; reads continue. Measured locally at 1M
-- orders: order_number 3.5-5.2 s, cashier_name 2.6-3.5 s, customer_name 0.3-0.5 s, 6.5-9 s in
-- total (a hosted database may be 2-4x slower). Acceptable while orders is small (test data).
--
-- RUNBOOK for a large orders table (above about 200k rows): before deploying this migration,
-- build each index by hand OUTSIDE a transaction, one statement at a time, with the same names:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_order_number_trgm  ON orders USING gin (order_number  gin_trgm_ops) WITH (fastupdate = off);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_cashier_name_trgm  ON orders USING gin (cashier_name  gin_trgm_ops) WITH (fastupdate = off);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_name_trgm ON orders USING gin (customer_name gin_trgm_ops) WITH (fastupdate = off);
-- then confirm pg_index.indisvalid is true for all three (drop and retry any invalid one). The
-- statements below are then no-ops (IF NOT EXISTS).
--
-- lock_timeout: if a long transaction holds orders, this fails fast instead of queueing behind it
-- (and blocking every later write); the new revision does not become ready and the old one keeps
-- serving. Retry the deploy.
SET LOCAL lock_timeout = '10s';
CREATE INDEX IF NOT EXISTS idx_orders_order_number_trgm  ON orders USING gin (order_number  gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS idx_orders_cashier_name_trgm  ON orders USING gin (cashier_name  gin_trgm_ops) WITH (fastupdate = off);
CREATE INDEX IF NOT EXISTS idx_orders_customer_name_trgm ON orders USING gin (customer_name gin_trgm_ops) WITH (fastupdate = off);
