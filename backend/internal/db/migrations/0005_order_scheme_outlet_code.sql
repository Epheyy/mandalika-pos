-- Client-authoritative order numbers: {OUTLET}-{DEV}{SEQ} generated on-device.
-- The printed order_number is now a DISPLAY label; order_uuid is the unique key
-- (idempotency_key = deviceId:orderUuid). Drop the global UNIQUE on
-- order_number so an offline device's number can never fail a flush.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_number_key;

-- Per-outlet short code used as the order-number prefix (e.g. JKT, SBY).
-- Assigned in Backoffice; case-insensitive unique. Backfill existing outlets
-- from their name (de-duplicated) so live outlets get a sensible default that
-- admins can refine.
ALTER TABLE outlets ADD COLUMN IF NOT EXISTS code text;

WITH ranked AS (
  SELECT id,
         COALESCE(
           NULLIF(upper(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 3)), ''),
           'OUT'
         ) AS base,
         row_number() OVER (
           PARTITION BY COALESCE(
             NULLIF(upper(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 3)), ''),
             'OUT'
           )
           ORDER BY created_at
         ) AS rn
  FROM outlets
  WHERE code IS NULL OR code = ''
)
UPDATE outlets o
SET code = CASE WHEN r.rn = 1 THEN r.base ELSE r.base || r.rn::text END
FROM ranked r
WHERE o.id = r.id;

CREATE UNIQUE INDEX IF NOT EXISTS outlets_code_unique ON outlets (upper(code));
