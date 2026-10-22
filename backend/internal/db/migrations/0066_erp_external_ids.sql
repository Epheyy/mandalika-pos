-- Step 4 (plan §4.1): ERP external ids, catalog-pull bookkeeping. The ERP (erp-flamboyan)
-- is the catalog master; the POS keys its rows on the ERP's stable slug.
--   product_variants.erp_slug  <- IntegrationFG.slug (one finished good = one variant)
--   products.erp_group_key     <- K1 product_slug when the ERP adds it, else the POS
--                                 rule (normalised name minus size, within category; D19)
--   outlets.erp_slug/erp_code  <- IntegrationOutlet.slug/code. outlets.code stays
--                                 POS-owned (receipt numbers, mig 0052) and is never
--                                 written from the ERP; erp_code feeds /outlets/{code}/stock.
--   warehouses.erp_slug        <- mapped by hand (the ERP API has no warehouse endpoint).
--
-- Two additions beyond the plan's §4.1 SQL, both additive:
--   * product_variants.is_active: the ERP status/tombstone needs a variant-level flag
--     (DISCONTINUE or deleted_at -> inactive). Per-outlet outlet_variant_stock.available
--     is admin-owned and per outlet, so it is not reused for this. Default true keeps
--     every existing variant as it is.
--   * import_runs.kind gains 'sku_mapping' (the one-time SKU mapping import, plan §4.2,
--     reuses the import_runs idempotency/replay record).
--
-- The GLOBAL sku unique index (plan §4.2, 0067) is NOT here: it ships in a separate,
-- later deploy once the read-only Neon duplicate count is 0 (migrations run at boot and
-- a duplicate would crash-loop the revision). See docs/runbooks/erp-catalog-sync.md.
--
-- Deliberately not here: no unique index on outlets.erp_code (the ERP may swap codes
-- between two outlets inside one run; the POS keys on erp_slug and reads erp_code per
-- outlet), and no cross-request resume columns (a pull run completes inside one request
-- or is restarted from scratch, per the ERP README; the full-run reconcile uses the
-- slugs seen in that run).
--
-- Additive only; the previous revision ignores every new column and table, so rollback
-- is a plain redeploy. Never renumber this file.
SET LOCAL lock_timeout = '5s';

-- Lock order products -> product_variants matches the app (write/catalog.go locks the
-- product row, then its variants), so a save on the old revision cannot deadlock this.
ALTER TABLE products ADD COLUMN erp_group_key text;  -- the POS rule embeds the category
CREATE UNIQUE INDEX products_erp_group_key ON products (erp_group_key) WHERE erp_group_key IS NOT NULL;

ALTER TABLE product_variants
  ADD COLUMN erp_slug      text,
  ADD COLUMN erp_synced_at timestamptz,
  ADD COLUMN is_active     boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX product_variants_erp_slug ON product_variants (erp_slug) WHERE erp_slug IS NOT NULL;

ALTER TABLE outlets ADD COLUMN erp_slug text, ADD COLUMN erp_code text;
CREATE UNIQUE INDEX outlets_erp_slug ON outlets (erp_slug) WHERE erp_slug IS NOT NULL;

ALTER TABLE warehouses ADD COLUMN erp_slug text;
CREATE UNIQUE INDEX warehouses_erp_slug ON warehouses (erp_slug) WHERE erp_slug IS NOT NULL;

-- One row per pulled resource ('finished_goods', 'outlets'). watermark is the
-- server_time of the FIRST page of the last COMPLETED run (never max(updated_at));
-- the next incremental run asks for updated_since = watermark - 5 min.
CREATE TABLE integration_watermarks (
  resource          text PRIMARY KEY,
  watermark         timestamptz,
  last_full_sync_at timestamptz,
  last_run_at       timestamptz,
  last_status       text,
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per pull run, written even when the run fails or stops early.
CREATE TABLE erp_sync_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource    text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('full','incremental')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  pages       int,
  upserted    int,
  tombstoned  int,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial','failed')),
  error       text
);
CREATE INDEX erp_sync_runs_resource_started ON erp_sync_runs (resource, started_at DESC);

ALTER TABLE import_runs DROP CONSTRAINT import_runs_kind_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_kind_check
  CHECK (kind IN ('customers','products','ingredients','sku_mapping'));
