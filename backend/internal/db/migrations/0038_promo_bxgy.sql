-- 0038_promo_bxgy.sql — SP-Promo-3b: configurable buy-X-get-Y promotion type.
ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
  CHECK (type IN ('percentage','fixed','bogo','buy_x_get_y'));
ALTER TABLE promotions ADD COLUMN bxgy_config jsonb;
