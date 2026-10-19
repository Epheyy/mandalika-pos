-- A30: exact, format-insensitive phone lookup for the cashier (phone-only customer access).
-- Additive. Adding the stored column rewrites customers under a lock (fine on test data).
-- 0057 stays reserved for A15 B.
--
-- Canonical key: trim; strip space - . ( ); drop one leading +; digits only; a leading 62
-- folds to 0; fewer than 8 digits = '' (not a usable phone). Twins: backend/internal/phone
-- and packages/sync/src/phone.ts (shared vectors, asserted in the CP gate).
CREATE OR REPLACE FUNCTION normalize_phone(raw text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN length(n) >= 8 THEN n ELSE '' END
  FROM (
    SELECT CASE WHEN s ~ '^[0-9]+$'
                THEN CASE WHEN s LIKE '62%' THEN '0' || substr(s, 3) ELSE s END
                ELSE '' END AS n
    FROM (
      SELECT regexp_replace(regexp_replace(regexp_replace(raw, '^[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$', '', 'g'), '[-. ()]', '', 'g'), '^\+', '') AS s
    ) a
  ) b
$$;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_norm text GENERATED ALWAYS AS (normalize_phone(phone)) STORED;

-- Cashier lookup is an exact phone_norm match over live (not merged-away) customers.
CREATE INDEX IF NOT EXISTS idx_customers_phone_norm ON customers(phone_norm) WHERE merged_into IS NULL;

-- Force every tablet to re-pull so a bundle that still carries the old customer list is
-- replaced by one with none (raises the sync wall once per outlet).
UPDATE content_versions SET version = version + 1, updated_at = now();
