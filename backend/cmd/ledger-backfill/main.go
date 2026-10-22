// Command ledger-backfill writes the stock-ledger opening balances (plan §2.4). It is
// an admin command, not a migration: migrations run at boot while the old Cloud Run
// revision may still be writing stock without movements.
//
// Run it only AFTER the old revision has drained, and on the test Neon DB only with
// the owner's OK (D13). It is idempotent: a re-run with a new run id inserts only keys
// that have no opening row yet; -reanchor fixes drift (adjust rows) after a rollback
// window. Each opening/reanchor document is queued in erp_outbox by ledger.Record in
// the same transaction (plan §2.4 last bullet, §5.1); the relay sends it to the ERP.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/ledger"
)

const (
	exitOK       = 0
	exitFailed   = 1 // invariant left violated, lock timeout, or any runtime failure
	exitUsage    = 2 // bad flags, missing or unusable DATABASE_URL
	maxShownRows = 20
	lockTimeout  = "55P03"
)

const usage = `Usage: ledger-backfill [-dry-run] [-reanchor] [-run-id ID] [-timeout 60s]

Writes opening stock-ledger movements for every stock row (one transaction, SHARE
lock on both stock tables). DSN comes from DATABASE_URL only.

  -dry-run    compute and report, insert nothing, roll back
  -reanchor   write adjust rows for drift instead of opening rows
  -run-id     id for this run (default bf-<UTC time>-<random>); never reuse one
  -timeout    overall time limit (default 60s)

Run only after the old Cloud Run revision has drained; on the test Neon DB only with
the owner's OK (D13). Idempotent: a re-run with a new run id inserts only keys that
have no opening yet. Exit 0 ok, 1 failed / invariant left violated / lock timeout
(re-run), 2 usage. Every document written is also queued for the ERP (erp_outbox).
`

// Seams for tests.
var (
	connect     = connectPool
	runBackfill = func(ctx context.Context, db ledger.TxBeginner, o ledger.BackfillOptions) (ledger.BackfillReport, []ledger.Violation, error) {
		return ledger.RunBackfill(ctx, db, o)
	}
	now = func() time.Time { return time.Now().UTC() }
)

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("ledger-backfill", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, usage) }
	dry := fs.Bool("dry-run", false, "compute and report, insert nothing")
	reanchor := fs.Bool("reanchor", false, "adjust rows for drift")
	runID := fs.String("run-id", "", "run id (default generated)")
	timeout := fs.Duration("timeout", 60*time.Second, "overall time limit")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if fs.NArg() > 0 || *timeout <= 0 {
		fs.Usage()
		return exitUsage
	}
	dsn := getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(stderr, "DATABASE_URL is not set; refusing to start.")
		return exitUsage
	}
	if *runID == "" {
		id, err := newRunID(now())
		if err != nil {
			fmt.Fprintln(stderr, "cannot generate a run id:", err)
			return exitUsage
		}
		*runID = id
	}

	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	pool, target, closeFn, err := connect(ctx, dsn)
	if err != nil {
		// Never echo the error: it can contain connection details.
		fmt.Fprintln(stderr, "unable to connect to the database (check DATABASE_URL).")
		return exitUsage
	}
	defer closeFn()
	mode := "opening"
	if *reanchor {
		mode = "reanchor"
	}
	fmt.Fprintf(stdout, "target=%s mode=%s dry-run=%t run-id=%s\n", target, mode, *dry, *runID)

	rep, viol, err := runBackfill(ctx, pool, ledger.BackfillOptions{DryRun: *dry, Reanchor: *reanchor, RunID: *runID})
	if err != nil {
		return reportFailure(err, viol, stdout, stderr)
	}
	fmt.Fprintf(stdout, "keys scanned=%d candidates=%d documents=%d parts=%d\n", rep.KeysScanned, rep.Candidates, rep.Documents, rep.Parts)
	if *dry {
		fmt.Fprintf(stdout, "dry run: would insert %d rows, nothing written (rolled back)\n", rep.WouldInsert)
		fmt.Fprintf(stdout, "invariant violations now: %d\n", len(viol))
		printViolations(stdout, viol)
		return exitOK
	}
	fmt.Fprintf(stdout, "inserted %d rows, committed; invariant violations: %d\n", rep.Inserted, len(viol))
	return exitOK
}

// reportFailure prints why a run failed. A lock timeout is not retried automatically:
// the operator re-runs, which is safe because every failed run rolled back.
func reportFailure(err error, viol []ledger.Violation, stdout, stderr io.Writer) int {
	var pgErr *pgconn.PgError
	switch {
	case errors.Is(err, ledger.ErrInvariantViolated):
		fmt.Fprintf(stderr, "invariant violated after backfill (%d keys); rolled back, nothing written.\n", len(viol))
		printViolations(stdout, viol)
	case errors.As(err, &pgErr) && pgErr.Code == lockTimeout:
		fmt.Fprintln(stderr, "lock timeout: re-run; writers held the stock tables. Nothing was written.")
	case errors.Is(err, context.DeadlineExceeded):
		fmt.Fprintln(stderr, "timed out; nothing was written (transaction rolled back). Re-run.")
	default:
		fmt.Fprintln(stderr, "backfill failed, nothing written:", err)
	}
	return exitFailed
}

func printViolations(w io.Writer, viol []ledger.Violation) {
	for i, v := range viol {
		if i == maxShownRows {
			fmt.Fprintf(w, "  ... and %d more\n", len(viol)-maxShownRows)
			return
		}
		fmt.Fprintf(w, "  %s %s product=%s size=%s live=%d ledger=%d\n", v.LocationType, v.LocationID, v.ProductID, v.VariantSize, v.Live, v.Ledger)
	}
}

// newRunID returns bf-<UTC yyyymmddThhmmssZ>-<6 hex>.
func newRunID(t time.Time) (string, error) {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "bf-" + t.UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b), nil
}

// connectPool opens a small pool and returns a host/dbname label (never the password).
func connectPool(ctx context.Context, dsn string) (ledger.TxBeginner, string, func(), error) {
	cc, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, "", nil, errors.New("parse")
	}
	pc, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, "", nil, errors.New("parse")
	}
	pc.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, "", nil, errors.New("connect")
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, "", nil, errors.New("ping")
	}
	return pool, cc.Host + "/" + cc.Database, pool.Close, nil
}
