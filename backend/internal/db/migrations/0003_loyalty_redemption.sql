-- Loyalty points redemption at checkout (P1-E). points_redeemed records how
-- many points the customer spent on this order; the rupiah value is derived
-- server-side from loyalty_settings.redemption_rate and already reflected in
-- orders.total.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_redeemed integer NOT NULL DEFAULT 0;
