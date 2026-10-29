SET LOCAL lock_timeout = '5s';
-- C6a split payment. A sale becomes one or more tender lines (order_tenders); a refund records
-- where its money went (order_refunds.payout_source); the feature ships dark behind
-- app_settings.split_tender_enabled. Additive: an old binary ignores the new table and columns,
-- and orders written without lines are read through the synthetic-line rule (one line per order
-- from orders.payment_method), so there is no backfill.

CREATE TABLE IF NOT EXISTS order_tenders (
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq        smallint NOT NULL CHECK (seq BETWEEN 1 AND 8),      -- wire max is 4 (D-51); headroom only
  method     text NOT NULL CHECK (btrim(method) <> '' AND lower(btrim(method)) <> 'split'),
  amount     numeric(14,2) NOT NULL CHECK (amount >= 0),           -- applied to the bill; sum per order = orders.total
  tendered   numeric(14,2) NOT NULL CHECK (tendered >= 0),         -- captured: cash handed over / amount charged
  change     numeric(14,2) NOT NULL DEFAULT 0 CHECK (change >= 0), -- cash line only
  reference  text CHECK (reference IS NULL OR char_length(reference) <= 64),
  PRIMARY KEY (order_id, seq)
);

ALTER TABLE order_refunds ADD COLUMN IF NOT EXISTS payout_source text
  CHECK (payout_source IS NULL OR payout_source IN ('sale', 'chosen', 'default'));  -- NULL = written before C6a

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS split_tender_enabled boolean NOT NULL DEFAULT false;
-- Set the first time split payment is switched on and never cleared (rollback guard).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS split_tender_enabled_at timestamptz;

-- Mirrors rules.IsCashMethod over app_settings.payment_methods: the first configured entry whose
-- id matches (case-insensitive, trimmed) and carries an explicit boolean isCash decides, even an
-- explicit false; otherwise the id default applies (cash, tunai).
CREATE OR REPLACE FUNCTION order_is_cash_method(p_method text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT (e.elem->>'isCash')::boolean
       FROM (SELECT elem FROM app_settings a,
                  LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(a.payment_methods) = 'array'
                         THEN a.payment_methods ELSE '[]'::jsonb END) WITH ORDINALITY AS t(elem, ord)
              WHERE a.id = 1
                AND lower(btrim(t.elem->>'id')) = lower(btrim(p_method))
              ORDER BY t.ord
              LIMIT 1) e
      WHERE jsonb_typeof(e.elem->'isCash') = 'boolean'),
    lower(btrim(p_method)) IN ('cash', 'tunai'))
$$;

-- The D-56 default payout method of a split order: the cash line's method when the sale had a
-- cash line (lowest seq), otherwise the line with the largest applied amount (ties: lowest seq).
-- An order without tender rows is one synthetic line from orders.payment_method.
CREATE OR REPLACE FUNCTION order_default_payout_method(p_order_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT l.method
    FROM (SELECT t.method, t.amount, t.seq FROM order_tenders t WHERE t.order_id = p_order_id
          UNION ALL
          SELECT o.payment_method, o.total, 1 FROM orders o
           WHERE o.id = p_order_id
             AND NOT EXISTS (SELECT 1 FROM order_tenders t2 WHERE t2.order_id = p_order_id)) l
   ORDER BY order_is_cash_method(l.method) DESC,
            CASE WHEN order_is_cash_method(l.method) THEN 0 ELSE -l.amount END,
            l.seq
   LIMIT 1
$$;

-- 0077 version with one change: a raw status='refunded' write on a split order records the
-- default payout method (payout_source 'default') instead of the sentinel 'split'. Every other
-- behaviour is unchanged; single-method orders record payout_source 'sale'.
CREATE OR REPLACE FUNCTION orders_refunded_legacy_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_refund uuid;
  v_split boolean := lower(btrim(NEW.payment_method)) = 'split';
BEGIN
  IF EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO order_refunds (order_id, outlet_id, seq, scope, amount, computed_amount, payment_method,
                             payout_source, reason, shift_id, refunded_by, refunded_by_name,
                             ledger_document_key, refunded_at, refund_business_date)
  VALUES (NEW.id, NEW.outlet_id, 1, 'legacy_full', NEW.total, NEW.total,
          CASE WHEN v_split THEN order_default_payout_method(NEW.id) ELSE NEW.payment_method END,
          CASE WHEN v_split THEN 'default' ELSE 'sale' END,
          COALESCE(NEW.refund_reason, ''), NEW.refund_shift_id, NEW.refunded_by, NEW.refunded_by_name,
          'refund:' || NEW.id, COALESCE(NEW.refunded_at, now()), NEW.refund_business_date)
  RETURNING id INTO v_refund;
  INSERT INTO order_refund_items (refund_id, order_item_id, quantity, amount, restocked)
  SELECT v_refund, oi.id, oi.quantity, oi.subtotal,
         EXISTS (SELECT 1 FROM stock_movements m WHERE m.dedupe_key = 'refund:' || oi.id)
    FROM order_items oi
   WHERE oi.order_id = NEW.id AND oi.quantity > 0;
  RETURN NULL;
END
$$;
