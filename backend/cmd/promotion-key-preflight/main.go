// Read-only release diagnostic. No .env loading, migration or remediation.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/promotionpreflight"
	"os"
	"time"
)

func main() { os.Exit(run()) }
func run() int {
	dsn := os.Getenv("PROMOTION_PREFLIGHT_DSN")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "Set PROMOTION_PREFLIGHT_DSN explicitly to the reviewed target, preferably with a read-only database role.")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	// Do not echo connection errors, which can contain supplied connection details.
	if err != nil {
		fmt.Fprintln(os.Stderr, "Unable to configure preflight connection.")
		return 2
	}
	defer pool.Close()
	report, err := promotionpreflight.Scan(ctx, pool)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Read-only preflight failed; no clean result is available. Check target/access/schema.")
		return 2
	}
	if err = json.NewEncoder(os.Stdout).Encode(report); err != nil {
		return 2
	}
	if len(report.Findings) > 0 {
		return 1
	}
	return 0
}
