-- Load-test step 1 seed. Run against the throw-away database mandalika_load ONLY, AFTER the
-- backend (or cmd/seed) has migrated it and seeded the admin:
--   docker exec -i roletest-postgres-1 psql -U mandalika -d mandalika_load -v ON_ERROR_STOP=1 < loadtest/sql/01_seed.sql
-- Respects the NOT NULL / CHECK / FK constraints of backend/internal/db/migrations (through 0086).
-- Everything is generated with generate_series; nothing real, no secrets. All outlets are Asia/Jakarta.
-- Row counts are parameters (psql -v), defaults are the step-1 targets.

\set ON_ERROR_STOP on
\if :{?n_orders}
\else
  \set n_orders 1000000
\endif
\if :{?n_customers}
\else
  \set n_customers 500000
\endif
\if :{?n_days}
\else
  \set n_days 365
\endif

\timing on
SELECT setseed(0.42);
SET synchronous_commit = off;
SET work_mem = '256MB';
SET maintenance_work_mem = '512MB';

-- ── Outlets (30) ────────────────────────────────────────────
INSERT INTO outlets (id, name, code, address, phone, timezone)
SELECT md5('outlet-' || i)::uuid, 'Load Outlet ' || lpad(i::text, 2, '0'), 'L' || lpad(i::text, 2, '0'),
       'Jl. Uji Beban No. ' || i, '0211000' || lpad(i::text, 4, '0'), 'Asia/Jakarta'
FROM generate_series(1, 30) i;

-- ── Catalogue: 4 categories, 40 products x 2 variants, stock per outlet ──
INSERT INTO categories (id, name, sort_order)
SELECT md5('cat-' || i)::uuid, (ARRAY['Eau de Parfum','Eau de Toilette','Body Mist','Extrait'])[i], i
FROM generate_series(1, 4) i;

INSERT INTO products (id, name, brand, category_id, upc)
SELECT md5('prod-' || i)::uuid, 'Parfum Uji ' || lpad(i::text, 2, '0'),
       (ARRAY['Mandalika','Flamboyan','Performance'])[1 + i % 3],
       md5('cat-' || (1 + i % 4))::uuid, 'LTUPC' || lpad(i::text, 5, '0')
FROM generate_series(1, 40) i;

INSERT INTO product_variants (id, product_id, size, price, stock, sku)
SELECT md5('var-' || p || '-' || s.size)::uuid, md5('prod-' || p)::uuid, s.size,
       (CASE WHEN s.size = '30ml' THEN 150000 + (p % 7) * 25000 ELSE 250000 + (p % 9) * 50000 END),
       0, 'LT-P' || lpad(p::text, 2, '0') || '-' || s.size
FROM generate_series(1, 40) p CROSS JOIN (VALUES ('30ml'), ('50ml')) AS s(size);

-- Per-outlet stock is what a sale decrements (outlet_variant_stock). Large on purpose: the step-1
-- run must never go negative, so "stock moved by exactly the sold quantities" is checkable.
INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock, available)
SELECT o.id, v.product_id, v.size, 100000, true FROM outlets o CROSS JOIN product_variants v;

-- ── Users: 60 cashiers (2 per outlet) + 1 manager for outlet L01 ────────────────
-- The password hash is copied from the seeded admin so every test user signs in with the
-- generated SEED_ADMIN_PASSWORD of backend/.env (argon2id cannot be produced in SQL).
INSERT INTO users (id, email, password_hash, display_name, role, outlet_id)
SELECT md5('user-L' || lpad(o::text, 2, '0') || '-' || c)::uuid,
       'cashier-l' || lpad(o::text, 2, '0') || '-' || c || '@load.local',
       (SELECT password_hash FROM users WHERE email = 'admin@mandalika.local'),
       'Kasir L' || lpad(o::text, 2, '0') || '-' || c, 'cashier', md5('outlet-' || o)::uuid
FROM generate_series(1, 30) o CROSS JOIN generate_series(1, 2) c;

INSERT INTO users (id, email, password_hash, display_name, role, outlet_id)
VALUES (md5('user-manager-L01')::uuid, 'manager-l01@load.local',
        (SELECT password_hash FROM users WHERE email = 'admin@mandalika.local'),
        'Manajer L01', 'manager', md5('outlet-1')::uuid);
INSERT INTO user_outlets (user_id, outlet_id) VALUES (md5('user-manager-L01')::uuid, md5('outlet-1')::uuid);
INSERT INTO user_permissions (user_id, permission)
SELECT md5('user-manager-L01')::uuid, p FROM unnest(ARRAY['view_reports','manage_customers','view_dashboard']) p;

-- ── Customers ────────────────────────────────────────────────
-- Ids are md5('cust-'||i)::uuid so orders can reference a random customer without a join.
-- Unique phones 0812 + 8 digits. Names: 50 first x 100 last x suffix, so a name prefix hits many rows.
INSERT INTO customers (id, name, phone, email, points, created_at)
SELECT md5('cust-' || i)::uuid,
       (ARRAY['Budi','Siti','Agus','Dewi','Eko','Rina','Joko','Wati','Andi','Sari',
              'Hadi','Lestari','Putra','Putri','Bayu','Ayu','Dian','Fajar','Gita','Hendra',
              'Indra','Jaya','Kartika','Lukman','Maya','Nanda','Oki','Pratama','Rizky','Susi',
              'Tono','Umar','Vina','Wahyu','Yani','Zainal','Anton','Bella','Citra','Doni',
              'Elok','Ferry','Galih','Heni','Irfan','Joni','Kiki','Lina','Mira','Nurul'])[1 + i % 50]
         || ' ' ||
       (ARRAY['Santoso','Wijaya','Kusuma','Pratama','Hidayat','Saputra','Nugroho','Setiawan','Lim','Tan'])[1 + (i / 50) % 10]
         || ' ' || i,
       '0812' || lpad(i::text, 8, '0'),
       CASE WHEN i % 4 = 0 THEN 'cust' || i || '@load.local' END,
       0, now() - (random() * 700 || ' days')::interval
FROM generate_series(1, :n_customers) i;

-- ── Shifts: one per outlet per day, closed ───────────────────
-- day offset 0 = today (Jakarta). Cashier alternates A/B by day.
CREATE TEMP TABLE days AS
SELECT d AS off, ((now() AT TIME ZONE 'Asia/Jakarta')::date - d) AS day FROM generate_series(0, :n_days - 1) d;

INSERT INTO shifts (id, outlet_id, outlet_name, cashier_id, cashier_name, status, opened_at, closed_at,
                    starting_cash, closing_cash, business_date)
SELECT md5('shift-' || o || '-' || dd.off)::uuid, md5('outlet-' || o)::uuid, 'Load Outlet ' || lpad(o::text, 2, '0'),
       md5('user-L' || lpad(o::text, 2, '0') || '-' || (1 + (dd.off % 2)))::uuid,
       'Kasir L' || lpad(o::text, 2, '0') || '-' || (1 + (dd.off % 2)), 'closed',
       (dd.day + time '09:00') AT TIME ZONE 'Asia/Jakarta', (dd.day + time '22:00') AT TIME ZONE 'Asia/Jakarta',
       500000, 500000, dd.day
FROM generate_series(1, 30) o CROSS JOIN days dd;

-- ── Orders: staged in temp tables, then loaded ───────────────
-- Order day is uniform over the window (about n_orders/n_days a day); outlet uniform; time 10:00-21:59 local.
CREATE TEMP TABLE t_ord AS
SELECT n, gen_random_uuid() AS id, gen_random_uuid() AS order_uuid, o AS outlet_idx, dd.off, dd.day,
       ((dd.day + make_time(10 + floor(random() * 12)::int, floor(random() * 60)::int, floor(random() * 60)::int))
          AT TIME ZONE 'Asia/Jakarta') AS ts,
       (random() < 0.30) AS has_cust,
       (random() < 0.05) AS is_refund,
       1 + floor(random() * 4)::int AS n_items
FROM (SELECT n, 1 + floor(random() * 30)::int AS o, floor(random() * :n_days)::int AS d0
        FROM generate_series(1, :n_orders) n) g
JOIN days dd ON dd.off = g.d0;

CREATE TEMP TABLE t_item AS
SELECT t.n, l AS line_no, v.product_id, p.name AS product_name, v.size, v.price,
       (CASE WHEN random() < 0.8 THEN 1 WHEN random() < 0.7 THEN 2 ELSE 3 END) AS qty
FROM t_ord t
CROSS JOIN LATERAL generate_series(1, t.n_items) l
-- Distinct products inside one order is not required by the schema; random variant per line.
JOIN LATERAL (SELECT 1 + floor(random() * 80 + (t.n * 0) + (l * 0))::int AS k) r ON true
JOIN (SELECT row_number() OVER (ORDER BY id) AS k, product_id, size, price FROM product_variants) v ON v.k = r.k
JOIN products p ON p.id = v.product_id;

CREATE TEMP TABLE t_tot AS
SELECT n, sum(price * qty) AS subtotal FROM t_item GROUP BY n;

-- NOTE: order_no_seq continues after the seeded numbers (see the end of this file).
INSERT INTO orders (id, order_number, order_uuid, idempotency_key, device_id, outlet_id, cashier_id, cashier_name,
                    customer_id, subtotal, total, payment_method, amount_paid, status, shift_id,
                    client_created_at, synced_at, created_at, quoted_total, business_date)
SELECT t.id, 'MND-' || lpad(t.n::text, 7, '0'), t.order_uuid,
       md5('device-' || t.outlet_idx)::uuid || ':' || t.order_uuid,
       md5('device-' || t.outlet_idx)::uuid, md5('outlet-' || t.outlet_idx)::uuid,
       md5('user-L' || lpad(t.outlet_idx::text, 2, '0') || '-' || (1 + (t.off % 2)))::uuid,
       'Kasir L' || lpad(t.outlet_idx::text, 2, '0') || '-' || (1 + (t.off % 2)),
       CASE WHEN t.has_cust THEN md5('cust-' || (1 + floor(random() * :n_customers)::int))::uuid END,
       tt.subtotal, tt.subtotal, 'cash', tt.subtotal, 'completed',
       md5('shift-' || t.outlet_idx || '-' || t.off)::uuid,
       t.ts - (floor(random() * 120) || ' seconds')::interval,   -- client clock a little earlier than the server row
       t.ts + (floor(random() * 5) || ' seconds')::interval, t.ts, tt.subtotal, t.day
FROM t_ord t JOIN t_tot tt USING (n);

INSERT INTO order_items (order_id, product_id, product_name, variant_size, price, quantity, subtotal, line_no, net_amount)
SELECT t.id, i.product_id, i.product_name, i.size, i.price, i.qty, i.price * i.qty, i.line_no, i.price * i.qty
FROM t_item i JOIN t_ord t USING (n);

INSERT INTO order_tenders (order_id, seq, method, amount, tendered, change)
SELECT o.id, 1, 'cash', o.total, o.total, 0 FROM orders o;

INSERT INTO processed_keys (idempotency_key, order_id, created_at)
SELECT o.idempotency_key, o.id, o.created_at FROM orders o;

-- ── Refunds: ~5% of orders become 'refunded'. The AFTER trigger orders_refunded_legacy_row then writes the
-- order_refunds ('legacy_full') and order_refund_items rows, exactly as a status change would in production.
UPDATE orders o
   SET status = 'refunded', refund_reason = 'Uji beban', refunded_at = o.created_at + interval '90 minutes',
       refund_shift_id = o.shift_id, refunded_by = o.cashier_id, refunded_by_name = o.cashier_name
  FROM t_ord t WHERE t.id = o.id AND t.is_refund;

-- ── Shift totals from the orders they own ───────────────────
UPDATE shifts s
   SET total_sales = a.sales, total_orders = a.cnt, cash_sales = a.sales
  FROM (SELECT shift_id, sum(total) AS sales, count(*) AS cnt FROM orders GROUP BY shift_id) a
 WHERE a.shift_id = s.id;

-- Server-assigned numbers (MND-nnnnnn) continue after the seeded ones.
SELECT setval('order_no_seq', GREATEST((SELECT last_value FROM order_no_seq), :n_orders));

DROP TABLE t_item; DROP TABLE t_tot; DROP TABLE t_ord; DROP TABLE days;
RESET synchronous_commit;
