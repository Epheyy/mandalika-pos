-- 0052: POS devices. The server assigns each POS install a short letter code per outlet
-- (AA, AB, ... ZZ, AAA ...), once, online. Codes are unique fleet-wide because the printed
-- outlet prefix is not unique (outlets.code may be NULL or clipped to 4 chars). Receipt numbers become {OUTLET}-{CODE}{SEQ}, so
-- two tablets (or a reinstalled one) can never produce the same number. Codes are never
-- reused. Additive: no data rewrite. This is the table the full device
-- registration (revocation, device list) will extend.
CREATE TABLE IF NOT EXISTS pos_devices (
  device_id     uuid        NOT NULL,
  outlet_id     uuid        NOT NULL REFERENCES outlets(id),
  code          text        NOT NULL,
  registered_by uuid,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  PRIMARY KEY (device_id, outlet_id),
  UNIQUE (code)
);
