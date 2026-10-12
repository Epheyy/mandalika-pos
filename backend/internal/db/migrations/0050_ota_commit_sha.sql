-- Bind each OTA release to the tested commit it was built from (A34).
ALTER TABLE ota_releases ADD COLUMN IF NOT EXISTS commit_sha text;
