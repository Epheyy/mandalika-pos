-- 0030_crm_interactions_reminders.sql
-- SP-CRM-6: per-customer interaction log + birthday/anniversary reminder support.

-- ── Interaction log ───────────────────────────────────────
CREATE TABLE customer_interactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('telepon','kunjungan','pesan','catatan')),
  interaction_date date NOT NULL,
  note             text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Serves the per-customer newest-first timeline read + stable OFFSET pagination.
CREATE INDEX idx_customer_interactions_customer
  ON customer_interactions (customer_id, interaction_date DESC, created_at DESC);

-- ── Birthday / anniversary reminder support ───────────────
-- MMDD = month*100 + day. Exact + leap-safe (no day-of-year shift after Feb 29).
-- NULL source date ⇒ NULL mmdd (excluded by the partial index).
ALTER TABLE customers
  ADD COLUMN birthday_mmdd smallint
    GENERATED ALWAYS AS ((EXTRACT(MONTH FROM birthday)*100 + EXTRACT(DAY FROM birthday))::smallint) STORED,
  ADD COLUMN anniversary_mmdd smallint
    GENERATED ALWAYS AS ((EXTRACT(MONTH FROM anniversary)*100 + EXTRACT(DAY FROM anniversary))::smallint) STORED;

CREATE INDEX idx_customers_birthday_mmdd
  ON customers (birthday_mmdd) WHERE birthday_mmdd IS NOT NULL;
CREATE INDEX idx_customers_anniversary_mmdd
  ON customers (anniversary_mmdd) WHERE anniversary_mmdd IS NOT NULL;
