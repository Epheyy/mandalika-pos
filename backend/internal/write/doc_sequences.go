package write

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// formatDocNo turns a (kind, year, sequence-number) triple into the canonical
// document number string used by surat jalan + tanda terima.
// Examples: formatDocNo("SJ", 2026, 1)  == "SJ-2026-00001"
//
//	formatDocNo("TT", 2026, 42) == "TT-2026-00042"
func formatDocNo(kind string, year int, n int64) string {
	return fmt.Sprintf("%s-%d-%05d", kind, year, n)
}

// nextDocNo atomically allocates and returns the next per-year sequence number
// for `kind` ("SJ" or "TT"), formatted via formatDocNo.
//
// Uses an UPSERT-with-increment so two concurrent callers on the same row
// serialize on a row-level lock — each gets a distinct number with no holes.
//
// next_seq IS the assigned number (not the "next one to use"). On first INSERT
// the row lands with next_seq=1 and returns 1; subsequent UPDATEs increment
// then return the new value.
//
// SQL behavior is verified live at Task A10 (a real Send + Receive trip).
func nextDocNo(ctx context.Context, tx pgx.Tx, kind string, year int) (string, error) {
	var n int64
	err := tx.QueryRow(ctx,
		`INSERT INTO doc_sequences (kind, year, next_seq) VALUES ($1, $2, 1)
		 ON CONFLICT (kind, year) DO UPDATE SET next_seq = doc_sequences.next_seq + 1
		 RETURNING next_seq`,
		kind, year,
	).Scan(&n)
	if err != nil {
		return "", fmt.Errorf("nextDocNo %s/%d: %w", kind, year, err)
	}
	return formatDocNo(kind, year, n), nil
}
