package write

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// validTagColors is the preset palette; writes reject anything else.
var validTagColors = map[string]bool{
	"amber": true, "blue": true, "green": true, "red": true,
	"purple": true, "gray": true, "pink": true, "teal": true,
}

type Tag struct {
	Name      string `json:"name"`
	Color     string `json:"color"`
	SortOrder *int   `json:"sortOrder,omitempty"`
}

func validateTag(in Tag) error {
	if in.Name == "" {
		return fmt.Errorf("nama tag wajib")
	}
	if !validTagColors[in.Color] {
		return fmt.Errorf("warna tag tidak valid")
	}
	return nil
}

func (r *Repo) CreateTag(ctx context.Context, in Tag) (string, error) {
	if err := validateTag(in); err != nil {
		return "", err
	}
	var id string
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO tags (name, color, sort_order) VALUES ($1,$2,$3) RETURNING id`,
		in.Name, in.Color, in.SortOrder).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return "", fmt.Errorf("nama tag sudah dipakai")
		}
		return "", fmt.Errorf("create tag: %w", err)
	}
	return id, nil
}

func (r *Repo) UpdateTag(ctx context.Context, id string, in Tag) error {
	if err := validateTag(in); err != nil {
		return err
	}
	tag, err := r.Pool.Exec(ctx,
		`UPDATE tags SET name=$2, color=$3, sort_order=$4 WHERE id=$1`,
		id, in.Name, in.Color, in.SortOrder)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return fmt.Errorf("nama tag sudah dipakai")
		}
		return fmt.Errorf("update tag: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repo) DeleteTag(ctx context.Context, id string) error {
	// customer_tags FK is ON DELETE CASCADE — assignments are removed with the tag.
	tag, err := r.Pool.Exec(ctx, `DELETE FROM tags WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete tag: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetCustomerTags replaces a customer's entire tag set in one transaction.
func (r *Repo) SetCustomerTags(ctx context.Context, customerID string, tagIDs []string) error {
	return r.tx(ctx, "customers", func(t pgx.Tx) error {
		var exists bool
		if err := t.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id=$1)`, customerID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		if _, err := t.Exec(ctx, `DELETE FROM customer_tags WHERE customer_id=$1`, customerID); err != nil {
			return err
		}
		// tagIDs must reference existing tags (enforced by the FK); the caller
		// (backoffice UI) only sends ids from the /tags list. A non-existent id
		// aborts the tx with a FK violation → surfaced as 400.
		for _, tagID := range tagIDs {
			if _, err := t.Exec(ctx,
				`INSERT INTO customer_tags (customer_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
				customerID, tagID); err != nil {
				return err
			}
		}
		return nil
	})
}
