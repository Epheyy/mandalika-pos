-- A28: per-outlet timezone and a stored business date. Additive.
--
-- Owner policy: each OUTLET has a timezone (WIB, WITA or WIT); the business day of a sale is
-- the OPENING DATE of its shift. There is no return deadline.
--
-- Rows get their date from triggers (not from Go) so every insert path gets it: the order
-- service, sync, the Firestore migration tool, test fixtures and the previous revision during
-- a rollback. The functions below must NEVER raise: they sit on the sale insert path, so a
-- missing outlet or shift falls back to Asia/Jakarta / the row's own time.
--
-- Dates are frozen at write time. Editing an outlet's timezone later never rewrites them.

ALTER TABLE outlets
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Jakarta';
ALTER TABLE outlets
  ADD CONSTRAINT outlets_timezone_allowed
  CHECK (timezone IN ('Asia/Jakarta','Asia/Makassar','Asia/Jayapura'));

-- Columns first: the SQL function bodies below are validated against them at creation.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS business_date date;

-- The calendar day of an instant in the outlet's zone (Asia/Jakarta for an unknown outlet).
CREATE OR REPLACE FUNCTION business_date_at(p_outlet uuid, p_at timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (p_at AT TIME ZONE COALESCE((SELECT o.timezone FROM outlets o WHERE o.id = p_outlet), 'Asia/Jakarta'))::date
$$;

-- The business date of a sale: its shift's date when it has one, else the day of the capture
-- time in the outlet's zone. The device clock counts only inside [created - 7 days,
-- created + 5 minutes]; outside that the server time wins.
CREATE OR REPLACE FUNCTION order_business_date(p_outlet uuid, p_shift uuid, p_client timestamptz, p_created timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT s.business_date FROM shifts s WHERE s.id = p_shift AND s.outlet_id = p_outlet),
    business_date_at(p_outlet,
      CASE WHEN p_client >= p_created - interval '7 days' AND p_client <= p_created + interval '5 minutes'
           THEN p_client ELSE p_created END))
$$;

UPDATE shifts SET business_date = (opened_at AT TIME ZONE 'Asia/Jakarta')::date WHERE business_date IS NULL;
ALTER TABLE shifts ALTER COLUMN business_date SET NOT NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS business_date date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_business_date date;
UPDATE orders SET business_date = order_business_date(outlet_id, shift_id, client_created_at, created_at)
  WHERE business_date IS NULL;
ALTER TABLE orders ALTER COLUMN business_date SET NOT NULL;
UPDATE orders o SET refund_business_date = COALESCE(
    (SELECT s.business_date FROM shifts s WHERE s.id = o.refund_shift_id),
    business_date_at(o.outlet_id, o.refunded_at))
  WHERE o.status = 'refunded' AND o.refunded_at IS NOT NULL AND o.refund_business_date IS NULL;

CREATE OR REPLACE FUNCTION shifts_set_business_date() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_date IS NULL THEN
    NEW.business_date := business_date_at(NEW.outlet_id, NEW.opened_at);
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_shifts_business_date ON shifts;
CREATE TRIGGER trg_shifts_business_date BEFORE INSERT ON shifts
  FOR EACH ROW EXECUTE FUNCTION shifts_set_business_date();

CREATE OR REPLACE FUNCTION orders_set_business_date() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_date IS NULL THEN
    NEW.business_date := order_business_date(NEW.outlet_id, NEW.shift_id, NEW.client_created_at, NEW.created_at);
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_orders_business_date ON orders;
CREATE TRIGGER trg_orders_business_date BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_set_business_date();

-- A refund stamps its own business date once (A27 reads it later); the sale's date is untouched.
CREATE OR REPLACE FUNCTION orders_set_refund_business_date() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.refund_business_date := COALESCE(
    (SELECT s.business_date FROM shifts s WHERE s.id = NEW.refund_shift_id),
    business_date_at(NEW.outlet_id, COALESCE(NEW.refunded_at, now())));
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_orders_refund_business_date ON orders;
CREATE TRIGGER trg_orders_refund_business_date BEFORE UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (NEW.status = 'refunded' AND OLD.status IS DISTINCT FROM 'refunded' AND NEW.refund_business_date IS NULL)
  EXECUTE FUNCTION orders_set_refund_business_date();

CREATE INDEX IF NOT EXISTS idx_orders_outlet_business_date ON orders(outlet_id, business_date);
CREATE INDEX IF NOT EXISTS idx_orders_business_date ON orders(business_date);
CREATE INDEX IF NOT EXISTS idx_shifts_outlet_business_date ON shifts(outlet_id, business_date);
