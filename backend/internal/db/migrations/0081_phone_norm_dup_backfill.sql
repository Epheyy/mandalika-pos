-- One-off Duplikat review-queue backfill for the phone rule of 0080 (separate file = separate
-- transaction, so the customers table is not locked ACCESS EXCLUSIVE while it runs).
--
-- Live customers that now share a normalized phone (for example
-- 0812... vs 62812... vs +62 812...) were invisible to the old raw phone = $1 match. Flag each
-- later customer against the oldest live one, exactly like the POS path (recordDupCandidate).
-- Groups of more than 10 live customers on one normalized phone are skipped: that is a shared
-- placeholder number (a store line, 0812-1111-1111), not a duplicate person, and would flood the
-- queue. NEVER merges: rows land as 'pending' for a human in Pelanggan > Duplikat. A pair that is
-- already known, in either direction and in any status (dismissed/merged included), is skipped.
INSERT INTO customer_dup_candidates (new_customer_id, existing_customer_id, phone)
SELECT r.id, r.first_id, r.phone
FROM (
  SELECT id, phone,
         first_value(id) OVER w AS first_id,
         row_number()   OVER w AS rn,
         count(*)       OVER (PARTITION BY phone_norm) AS grp_size
  FROM customers
  WHERE merged_into IS NULL AND phone_norm <> ''
  WINDOW w AS (PARTITION BY phone_norm ORDER BY created_at, id)
) r
WHERE r.rn > 1
  AND r.grp_size <= 10
  AND NOT EXISTS (SELECT 1 FROM customer_dup_candidates d
                   WHERE d.new_customer_id = r.first_id AND d.existing_customer_id = r.id)
ON CONFLICT DO NOTHING;
