// migrate-firestore ports a Firestore JSON export into PostgreSQL (Phase F).
//
//	go run ./cmd/migrate-firestore --input export.json --dry-run
//	go run ./cmd/migrate-firestore --input export.json          # apply
//
// --dry-run runs the full migration in a transaction and rolls it back, so the
// parity report (per-collection counts + orders/shift totals) is verifiable on
// staging without mutating data. The run is idempotent (UUIDv5 ids +
// ON CONFLICT), so re-running after a partial cutover converges.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	"github.com/mandalika/pos-backend/internal/fsmigrate"
)

func main() {
	input := flag.String("input", "", "path to Firestore export JSON (required)")
	dryRun := flag.Bool("dry-run", false, "run + report, then roll back (no writes)")
	flag.Parse()

	if *input == "" {
		fmt.Fprintln(os.Stderr, "usage: migrate-firestore --input export.json [--dry-run]")
		os.Exit(2)
	}

	cfg := config.Load()
	ctx := context.Background()

	export, err := fsmigrate.Load(*input)
	if err != nil {
		log.Fatalf("load: %v", err)
	}

	database, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()
	if err := database.Migrate(ctx); err != nil {
		log.Fatalf("schema migrate: %v", err)
	}

	report, err := fsmigrate.Migrate(ctx, database.Pool, export, *dryRun)
	if err != nil {
		log.Fatalf("migration failed (transaction rolled back): %v", err)
	}

	fmt.Print(report.String())
	if *dryRun {
		fmt.Println("\nDry-run complete. Re-run without --dry-run to apply.")
	} else {
		fmt.Println("\nMigration applied.")
	}
}
