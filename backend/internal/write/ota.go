package write

import (
	"context"

	"github.com/mandalika/pos-backend/internal/ota"
)

// PublishOtaRelease records a newly published OTA release and returns its id.
func (r *Repo) PublishOtaRelease(ctx context.Context, in ota.Release, createdBy string) (string, error) {
	var id string
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO ota_releases (platform, version, url, checksum, size, native_version_code, commit_sha, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		in.Platform, in.Version, in.URL, in.Checksum, in.Size, in.NativeVersionCode, in.CommitSHA, nullUUID(createdBy)).Scan(&id)
	return id, err
}
