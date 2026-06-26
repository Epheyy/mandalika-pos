-- 0039_promo_reward_grants.sql — SP-Promo-3b reward fulfillment audit.
CREATE TABLE promo_reward_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  promotion_id  uuid NOT NULL REFERENCES promotions(id),
  product_id    uuid NOT NULL,
  product_name  text NOT NULL,
  variant_size  text NOT NULL DEFAULT '',
  full_price    numeric(14,2) NOT NULL,
  reward_price  numeric(14,2) NOT NULL,
  reward_value  numeric(14,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_promo_reward_grants_order ON promo_reward_grants(order_id);
CREATE INDEX idx_promo_reward_grants_promo ON promo_reward_grants(promotion_id);
