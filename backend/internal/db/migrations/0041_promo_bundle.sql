-- 0041_promo_bundle.sql — SP-Promo-3b-bundle: multi-product bundle (fixed price).
ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
  CHECK (type IN ('percentage','fixed','bogo','buy_x_get_y','tiered','bundle'));
ALTER TABLE promotions ADD COLUMN bundle_config jsonb;
