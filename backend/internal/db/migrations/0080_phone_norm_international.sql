-- Customer phone rule, Indonesian + international (QA #3/#9, CS-6, P-22).
--
-- normalize_phone() (0061) becomes: '+' or '00' = international; leading '0' = Indonesian
-- local; bare '8...' = Indonesian mobile missing its 0; 62 folds to 0; digits only; key length
-- >= 8 and <= 15 digits counting the country code (E.164). Twins: backend/internal/phone,
-- packages/types/src/phone.ts, shared vectors packages/sync/src/__fixtures__/phone-vectors.json.
--
-- A STORED generated column is not recomputed by CREATE OR REPLACE FUNCTION, so the column
-- is dropped and re-added: one table rewrite of customers plus one index build, set-based and
-- atomic with the function change (the review-queue backfill is the next file, 0081, so this lock is
-- not held through it) (never a half-old, half-new key). This is the accepted
-- trade-off at 500k rows: the rewrite also rebuilds every index on customers (three trigram GIN
-- indexes, birthday/anniversary, phone), so expect tens of seconds on Neon free tier during which
-- customer writes (POS sync) wait; the outbox retries idempotently. Run off-hours. lock_timeout makes it fail fast
-- instead of queueing behind a long customers reader. The migration runs once under an advisory
-- lock; there is no batched alternative that keeps the key consistent during the change.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS idx_customers_phone_norm;
ALTER TABLE customers DROP COLUMN IF EXISTS phone_norm;

CREATE OR REPLACE FUNCTION normalize_phone(raw text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN n = '' OR length(n) < 8 THEN ''
           WHEN n LIKE '0%' THEN CASE WHEN length(n) + 1 <= 15 THEN n ELSE '' END
           ELSE CASE WHEN length(n) <= 15 THEN n ELSE '' END
         END
  FROM (
    SELECT CASE
             WHEN d !~ '^[0-9]+$' THEN ''
             WHEN intl AND d LIKE '0%' THEN ''
             WHEN d LIKE '620%' THEN '0' || substr(d, 4)
             WHEN d LIKE '62%' THEN '0' || substr(d, 3)
             WHEN NOT intl AND d LIKE '0%' THEN d
             WHEN NOT intl AND d LIKE '8%' THEN '0' || d
             ELSE d
           END AS n
    FROM (
      SELECT CASE WHEN s LIKE '+%' THEN substr(s, 2) WHEN s LIKE '00%' THEN substr(s, 3) ELSE s END AS d,
             (s LIKE '+%' OR s LIKE '00%') AS intl
      FROM (
        SELECT regexp_replace(regexp_replace(raw, '^[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\ufeff\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$', '', 'g'), '[-. ()]', '', 'g') AS s
      ) a
    ) b
  ) c
$$;

ALTER TABLE customers ADD COLUMN phone_norm text GENERATED ALWAYS AS (normalize_phone(phone)) STORED;
CREATE INDEX idx_customers_phone_norm ON customers(phone_norm) WHERE merged_into IS NULL;

ANALYZE customers; -- the re-added column has no statistics until autovacuum would run
