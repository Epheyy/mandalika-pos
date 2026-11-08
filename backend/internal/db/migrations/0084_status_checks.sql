-- Closed status sets for two columns that had no CHECK (sweep leftovers). Every runtime writer
-- (write/transfer.go, write/merge.go, the customer-create paths) only uses these values; the
-- Firestore import does not touch either table. Named so a later migration can replace them.
ALTER TABLE transfers
  ADD CONSTRAINT transfers_status_check
  CHECK (status IN ('draft', 'in_transit', 'completed', 'cancelled'));

ALTER TABLE customer_dup_candidates
  ADD CONSTRAINT customer_dup_candidates_status_check
  CHECK (status IN ('pending', 'merged', 'dismissed'));
