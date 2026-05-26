-- 0018_transfer_documents.sql
-- SP4: surat jalan + tanda terima.

-- Brand-level document defaults (single-row app_settings table).
ALTER TABLE app_settings ADD COLUMN documents_logo_url      text;
ALTER TABLE app_settings ADD COLUMN documents_brand_name    text;
ALTER TABLE app_settings ADD COLUMN documents_address_lines text;
ALTER TABLE app_settings ADD COLUMN documents_phone         text;
ALTER TABLE app_settings ADD COLUMN documents_npwp          text;

-- Per-location LOGO override (NULL ⇒ fall back to brand). The existing
-- `address` and `phone` columns on outlets (migration 0001) and warehouses
-- (migration 0015) are reused as the per-location override for those two
-- fields — adding new override columns would duplicate data and collide on
-- `phone`. The letterhead resolver in `transferObj` (Task A6) COALESCEs the
-- existing columns through to `app_settings.documents_*` defaults.
ALTER TABLE warehouses ADD COLUMN logo_url text;
ALTER TABLE outlets    ADD COLUMN logo_url text;

-- Doc numbers assigned at status transition. NULL = pre-SP4 transfer;
-- Postgres UNIQUE allows multiple NULLs so the old rows are safe.
ALTER TABLE transfers ADD COLUMN surat_jalan_no  text UNIQUE;
ALTER TABLE transfers ADD COLUMN tanda_terima_no text UNIQUE;

-- Per-year counter rows. UPSERT-with-increment yields the next number atomically.
CREATE TABLE doc_sequences (
  kind     text    NOT NULL,
  year     integer NOT NULL,
  next_seq bigint  NOT NULL DEFAULT 1,
  PRIMARY KEY (kind, year)
);
