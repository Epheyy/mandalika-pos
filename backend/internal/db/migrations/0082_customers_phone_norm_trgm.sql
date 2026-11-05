-- 0082: substring search on the normalized phone (customer list `q` and the reader typeahead).
--
-- A user can type 0812..., 62812..., +62 812... or a bare 812... for the same customer; the raw
-- `phone` ILIKE only finds the spelling that was stored. The search now also matches
-- phone_norm LIKE '%<local digits>%' (phone.SearchKeys), which needs a trigram index to stay off
-- a sequential scan at 500k rows. Same shape as the other customer search indexes (0026): a GIN
-- trigram index, partial on live rows because every search carries `merged_into IS NULL`.
--
-- A plain CREATE INDEX, like 0026 and 0080: the migration runner wraps each file in a
-- transaction, which CREATE INDEX CONCURRENTLY cannot run in. At 500k short digit strings the
-- build takes seconds and blocks customer writes (POS sync retries idempotently) only for that long.
CREATE INDEX IF NOT EXISTS idx_customers_phone_norm_trgm
  ON customers USING gin (phone_norm gin_trgm_ops) WHERE merged_into IS NULL;
