package read

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/ota"
)

// LatestOtaRelease returns the most recently published release for platform
// that targets exactly the given APK versionCode, or (nil, nil) when none
// exists. Legacy rows (NULL native_version_code) never match.
func (r *Repo) LatestOtaRelease(ctx context.Context, platform string, nativeVersionCode int) (*ota.Release, error) {
	var rel ota.Release
	err := r.Pool.QueryRow(ctx,
		`SELECT platform, version, url, checksum, size, native_version_code
		   FROM ota_releases WHERE platform=$1 AND native_version_code=$2
		  ORDER BY created_at DESC LIMIT 1`, platform, nativeVersionCode).
		Scan(&rel.Platform, &rel.Version, &rel.URL, &rel.Checksum, &rel.Size, &rel.NativeVersionCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rel, nil
}
