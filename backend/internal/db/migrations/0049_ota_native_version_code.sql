-- OTA min-version guard: each bundle targets exactly one APK build (Android versionCode).
-- Legacy rows stay NULL and are never offered by /ota/check.
ALTER TABLE ota_releases ADD COLUMN IF NOT EXISTS native_version_code integer;
CREATE INDEX IF NOT EXISTS idx_ota_releases_platform_native_created
  ON ota_releases (platform, native_version_code, created_at DESC);
