package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrReceiptKeyConflict is returned when an idempotency key was already used for
// a different operation (type, outlet or payload). Nothing is changed and no
// stored outcome is revealed.
var ErrReceiptKeyConflict = errors.New("kunci idempotensi sudah dipakai untuk operasi lain")

// ReceiptClaim identifies one keyed write. Scope is the authenticated caller's
// outlet, never taken from the payload.
type ReceiptClaim struct {
	Key     string
	OpType  string
	Scope   string
	Payload []byte
}

// ReceiptEffect runs the write inside the claim's transaction and returns the
// outcome to store and replay. It must not commit or roll back tx.
type ReceiptEffect func(tx pgx.Tx) (json.RawMessage, error)

// ReceiptRunner executes an effect exactly once per idempotency key.
type ReceiptRunner func(ctx context.Context, c ReceiptClaim, effect ReceiptEffect) (outcome json.RawMessage, replayed bool, err error)

// PoolReceiptRunner returns the PostgreSQL-backed runner.
func PoolReceiptRunner(pool *pgxpool.Pool) ReceiptRunner {
	return func(ctx context.Context, c ReceiptClaim, effect ReceiptEffect) (json.RawMessage, bool, error) {
		return RunWithReceipt(ctx, pool, c, effect)
	}
}

// RequestFingerprint hashes opType and the canonical form of a JSON payload
// (keys sorted, numbers kept verbatim), so a byte-different but equivalent retry
// still matches while a changed payload does not.
func RequestFingerprint(opType string, payload []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", fmt.Errorf("fingerprint payload: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return "", errors.New("fingerprint payload: trailing data")
	}
	canonical, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	h.Write([]byte(opType))
	h.Write([]byte{0})
	h.Write(canonical)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// RunWithReceipt claims c.Key as the FIRST statement of one transaction, so a
// concurrent request with the same key waits on the unique index. If the claim is
// new the effect runs in the same transaction and its outcome is stored before
// commit; if it already exists the stored outcome is replayed (only when type,
// scope and fingerprint all match). A failing effect rolls everything back, so
// failures are never pinned to a key.
func RunWithReceipt(ctx context.Context, pool *pgxpool.Pool, c ReceiptClaim, effect ReceiptEffect) (json.RawMessage, bool, error) {
	if c.Key == "" {
		// No key to claim (the batch envelope rejects these): keep the plain
		// single-transaction behaviour.
		return runUnkeyed(ctx, pool, effect)
	}
	fp, err := RequestFingerprint(c.OpType, c.Payload)
	if err != nil {
		return nil, false, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		INSERT INTO operation_receipts (idempotency_key, op_type, scope, fingerprint, outcome)
		VALUES ($1,$2,$3,$4,'{}'::jsonb)
		ON CONFLICT (idempotency_key) DO NOTHING`,
		c.Key, c.OpType, c.Scope, fp)
	if err != nil {
		return nil, false, err
	}
	if tag.RowsAffected() == 0 {
		var opType, scope, stored string
		var outcome []byte
		err := tx.QueryRow(ctx, `
			SELECT op_type, scope, fingerprint, outcome
			  FROM operation_receipts WHERE idempotency_key=$1`, c.Key).
			Scan(&opType, &scope, &stored, &outcome)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, errors.New("receipt tidak ditemukan, silakan coba lagi")
		}
		if err != nil {
			return nil, false, err
		}
		if opType != c.OpType || scope != c.Scope || stored != fp {
			return nil, false, ErrReceiptKeyConflict
		}
		return outcome, true, nil
	}

	outcome, err := effect(tx)
	if err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE operation_receipts SET outcome=$2 WHERE idempotency_key=$1`,
		c.Key, []byte(outcome)); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return outcome, false, nil
}

func runUnkeyed(ctx context.Context, pool *pgxpool.Pool, effect ReceiptEffect) (json.RawMessage, bool, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	outcome, err := effect(tx)
	if err != nil {
		return nil, false, err
	}
	return outcome, false, tx.Commit(ctx)
}
