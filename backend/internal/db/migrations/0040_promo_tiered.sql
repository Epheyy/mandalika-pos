-- 0040_promo_tiered.sql — SP-Promo-3b-tiered: spend-threshold tiered discount.
ALTER TABLE promotions DROP CONSTRAINT promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
  CHECK (type IN ('percentage','fixed','bogo','buy_x_get_y','tiered'));
ALTER TABLE promotions ADD COLUMN tiered_config jsonb;
