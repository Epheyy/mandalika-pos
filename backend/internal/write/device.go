package write

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/mandalika/pos-backend/internal/apperr"
)

// nextDeviceCode returns the code after prev: AA, AB, ... AZ, BA, ... ZZ, AAA, ...
// An empty prev starts the sequence at AA. Codes always have at least two letters, so
// they can never equal a legacy one-character device tag.
func nextDeviceCode(prev string) string {
	if prev == "" {
		return "AA"
	}
	b := []byte(prev)
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] < 'Z' {
			b[i]++
			return string(b)
		}
		b[i] = 'A'
	}
	return "A" + string(b)
}

// RegisterPOSDevice returns the receipt code of deviceID at outletID, assigning the next
// free code on first sight. Idempotent: a known (device, outlet) pair returns its code.
func (r *Repo) RegisterPOSDevice(ctx context.Context, deviceID, outletID, userID string) (string, error) {
	var code string
	err := retryBusy(ctx, func() error {
		var err error
		code, err = r.registerPOSDevice(ctx, deviceID, outletID, userID)
		return err
	})
	return code, err
}

func (r *Repo) registerPOSDevice(ctx context.Context, deviceID, outletID, userID string) (string, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize code assignment per outlet (same lock as shift open; it does not block sales).
	var locked int
	switch err := tx.QueryRow(ctx, `SELECT 1 FROM outlets WHERE id=$1 FOR NO KEY UPDATE`, outletID).Scan(&locked); {
	case errors.Is(err, pgx.ErrNoRows):
		return "", apperr.New(apperr.NotFound, "outlet tidak ditemukan")
	case err != nil:
		return "", err
	}
	var code string
	err = tx.QueryRow(ctx, `UPDATE pos_devices SET last_seen_at=now()
		WHERE device_id=$1 AND outlet_id=$2 RETURNING code`, deviceID, outletID).Scan(&code)
	if err == nil {
		return code, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	var prev string
	switch err := tx.QueryRow(ctx, `SELECT code FROM pos_devices WHERE outlet_id=$1
		ORDER BY length(code) DESC, code DESC LIMIT 1`, outletID).Scan(&prev); {
	case errors.Is(err, pgx.ErrNoRows):
		prev = ""
	case err != nil:
		return "", err
	}
	code = nextDeviceCode(prev)
	var by any
	if userID != "" {
		by = userID
	}
	if _, err := tx.Exec(ctx, `INSERT INTO pos_devices (device_id, outlet_id, code, registered_by, last_seen_at)
		VALUES ($1,$2,$3,$4,now())`, deviceID, outletID, code, by); err != nil {
		return "", err
	}
	return code, tx.Commit(ctx)
}
