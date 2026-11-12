-- 0091_promo_bundle_discount.sql — "Diskon Bundle": a percent or rupiah discount per automatic bundle.
SET LOCAL lock_timeout = '5s';
ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
  CHECK (type IN ('percentage','fixed','bogo','buy_x_get_y','tiered','bundle','bundle_discount'));
ALTER TABLE promotions ADD COLUMN bundle_discount_config jsonb;
