// Command erp-joint-preview prints, for every erp_outbox row of the database in DATABASE_URL,
// the exact ERP stock document the real BuildDocument path would send. It only READS the
// local database and never contacts the ERP (joint test with the staging ERP, Part 1).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/integration/erp"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "erp-joint-preview:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	rows, err := pool.Query(ctx, `SELECT id::text, document_id::text, kind, location_type, location_id::text,
		ref_type, ref_id::text, COALESCE(ref_number,''), part, part_count, created_at
		FROM erp_outbox ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	var hs []erp.OutboxHeader
	for rows.Next() {
		var h erp.OutboxHeader
		if err := rows.Scan(&h.ID, &h.DocumentID, &h.Kind, &h.LocationType, &h.LocationID,
			&h.RefType, &h.RefID, &h.RefNumber, &h.Part, &h.PartCount, &h.CreatedAt); err != nil {
			return err
		}
		hs = append(hs, h)
	}
	rows.Close()
	for _, h := range hs {
		in, err := erp.LoadBuildInput(ctx, pool, h, "mandalika")
		if err != nil {
			return err
		}
		doc, hold, err := erp.BuildDocument(in)
		out := map[string]any{"outbox_id": h.ID, "local_kind": h.Kind, "hold": hold}
		if err != nil {
			out["error"] = err.Error()
		} else if hold == "" {
			out["document"] = doc
		}
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(b))
	}
	return nil
}
