-- Central error log: POS sync dead-letters, POS runtime/print failures, and
-- backend panics — so support/devs see field errors in the Backoffice instead
-- of relying on a cashier pasting a clipboard dump. Captures who/where/what:
-- outlet, device, user, the failing operation payload, an activity breadcrumb
-- trail, and the error. Not reference data — never bumps content_version.
CREATE TABLE IF NOT EXISTS error_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id         uuid,
  outlet_name       text,
  device_id         text,
  user_id           text,
  user_name         text,
  source            text NOT NULL,            -- sync | runtime | print | backend
  kind              text,                      -- op type / error class
  action            text,                      -- short human label
  message           text NOT NULL,             -- the error message
  payload           jsonb,                     -- failing op payload / extra
  breadcrumbs       jsonb,                     -- [{at,label}] activity trail
  app_version       text,
  client_created_at timestamptz,               -- when it happened on the device
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_outlet ON error_logs(outlet_id);
