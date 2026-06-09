package write

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

var validInteractionTypes = map[string]bool{
	"telepon": true, "kunjungan": true, "pesan": true, "catatan": true,
}

type Interaction struct {
	Type            string `json:"type"`
	InteractionDate string `json:"interactionDate"`
	Note            string `json:"note"`
}

// CreateInteraction appends a log entry for a customer. The author (byID/byName)
// is resolved by the handler from the authed identity, never the request body.
// An empty interactionDate defaults to today; a non-empty one must be YYYY-MM-DD.
func (r *Repo) CreateInteraction(ctx context.Context, customerID string, in Interaction, byID, byName string) (string, error) {
	if !validInteractionTypes[in.Type] {
		return "", fmt.Errorf("jenis interaksi tidak valid")
	}
	date := in.InteractionDate
	if date == "" {
		date = time.Now().Format("2006-01-02")
	} else if _, err := time.Parse("2006-01-02", date); err != nil {
		return "", fmt.Errorf("tanggal interaksi tidak valid")
	}
	var id string
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO customer_interactions
		   (customer_id, type, interaction_date, note, created_by, created_by_name)
		 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		customerID, in.Type, date, nullStr(in.Note), nullStr(byID), nullStr(byName)).Scan(&id)
	if err != nil {
		// FK violation (unknown customer) or malformed UUID → treat as 404,
		// so a bad {id} never leaks a raw Postgres message via a 400.
		var pg *pgconn.PgError
		if errors.As(err, &pg) && (pg.Code == "23503" || pg.Code == "22P02") {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("create interaction: %w", err)
	}
	return id, nil
}

// DeleteInteraction removes one entry, scoped to its customer (so a mismatched
// pair 404s rather than deleting another customer's row).
func (r *Repo) DeleteInteraction(ctx context.Context, customerID, interactionID string) error {
	tag, err := r.Pool.Exec(ctx,
		`DELETE FROM customer_interactions WHERE id=$1 AND customer_id=$2`,
		interactionID, customerID)
	if err != nil {
		return fmt.Errorf("delete interaction: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
