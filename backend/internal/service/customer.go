package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/mandalika/pos-backend/internal/apperr"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// resolveMergedCustomer follows customers.merged_into to the terminal (non-merged)
// keeper id, so an order placed against a stale/tombstoned dup id (e.g. from an
// offline POS cache that synced late) lands on the live keeper. Capped + cycle-safe.
func resolveMergedCustomer(ctx context.Context, tx pgx.Tx, id string) (string, error) {
	cur := id
	for i := 0; i < 10; i++ {
		var mi *string
		err := tx.QueryRow(ctx, `SELECT merged_into FROM customers WHERE id=$1`, cur).Scan(&mi)
		if errors.Is(err, pgx.ErrNoRows) {
			return cur, nil // unknown id: leave as-is, downstream load handles it
		}
		if err != nil {
			return "", fmt.Errorf("resolve merged customer: %w", err)
		}
		if mi == nil || *mi == "" {
			return cur, nil // terminal: not merged
		}
		cur = *mi
	}
	return cur, nil // hop cap reached (defensive); use the furthest resolved id
}

// CreateCustomerInput is an offline-created customer flushed from the POS outbox.
// The client generates the UUID so a queued order can reference it before it
// reaches the server.
type CreateCustomerInput struct {
	ID    string
	Name  string
	Phone string
	Email string
}

// CreateCustomer inserts (or upserts) a customer using the client-provided UUID,
// so offline new-customer creation works and is replay-safe.
func (s *OrderService) CreateCustomer(ctx context.Context, in CreateCustomerInput) (string, error) {
	if in.Name == "" || in.Phone == "" {
		return "", apperr.New(apperr.Rejected, "customer requires name and phone")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	id, err := s.CreateCustomerTx(ctx, tx, in)
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// CreateCustomerTx is CreateCustomer inside a caller-owned transaction.
func (s *OrderService) CreateCustomerTx(ctx context.Context, tx pgx.Tx, in CreateCustomerInput) (string, error) {
	if in.Name == "" || in.Phone == "" {
		return "", apperr.New(apperr.Rejected, "customer requires name and phone")
	}
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO customers (id, name, phone, email)
		VALUES (COALESCE(NULLIF($1,'')::uuid, gen_random_uuid()), $2, $3, $4)
		ON CONFLICT (id) DO UPDATE
		  SET name = EXCLUDED.name, phone = EXCLUDED.phone, email = EXCLUDED.email
		RETURNING id`,
		in.ID, in.Name, in.Phone, nullStr(in.Email)).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create customer: %w", err)
	}
	// SP-CRM-3: if another customer already has this phone, record a duplicate
	// candidate for the future backoffice merge tool. Best-effort — never blocks
	// the create (the in-flight order depends on it). Runs in a savepoint so a
	// failure here cannot abort the surrounding transaction.
	if dupErr := recordDupCandidate(ctx, tx, id, in.Phone); dupErr != nil {
		slog.Warn("dup candidate insert failed (best-effort)", "new_id", id, "err", dupErr)
	}
	return id, nil
}

func recordDupCandidate(ctx context.Context, tx pgx.Tx, id, phone string) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	defer sp.Rollback(ctx)
	var existingID string
	err = sp.QueryRow(ctx,
		`SELECT id FROM customers WHERE phone = $1 AND id <> $2 ORDER BY created_at ASC, id ASC LIMIT 1`,
		phone, id).Scan(&existingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if existingID == "" {
		return nil
	}
	if _, err = sp.Exec(ctx,
		`INSERT INTO customer_dup_candidates (new_customer_id, existing_customer_id, phone)
		 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, id, existingID, phone); err != nil {
		return err
	}
	return sp.Commit(ctx)
}
