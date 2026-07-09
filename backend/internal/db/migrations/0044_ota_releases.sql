CREATE TABLE ota_releases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform   text NOT NULL,
  version    text NOT NULL,
  url        text NOT NULL,
  checksum   text NOT NULL,
  size       bigint NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ota_releases_platform_created ON ota_releases (platform, created_at DESC);
