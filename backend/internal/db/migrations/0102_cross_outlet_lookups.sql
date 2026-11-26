-- 0102: A18 cross-outlet lookup log. One row per lookup attempt (rate-limited ones too), so stepping
-- (no foreign keys: the log must outlive a deleted user or outlet; user_name is a snapshot)
-- through other outlets' sequential order numbers shows up. query_value is the order number as typed
-- or the phone masked to its last 4 digits. Rate-limited attempts are capped at 5 rows per user and window by the handler; no retention job. Additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE cross_outlet_lookups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  user_id      uuid NOT NULL,
  user_name    text NOT NULL DEFAULT '',
  outlet_id    uuid NOT NULL,
  device_id    text,
  query_kind   text NOT NULL CHECK (query_kind IN ('order_number', 'phone')),
  query_value  text NOT NULL,
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  rate_limited boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_cross_outlet_lookups_created ON cross_outlet_lookups (created_at);
CREATE INDEX idx_cross_outlet_lookups_user ON cross_outlet_lookups (user_id, created_at);
