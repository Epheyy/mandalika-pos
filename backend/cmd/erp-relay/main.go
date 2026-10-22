// Command erp-relay runs one pass of the ERP outbox relay from the command line
// (plan step 5): the same Run the scheduler endpoint triggers, for an operator who
// wants to drain the outbox now or re-queue one document first. The DSN comes from
// DATABASE_URL only; the ERP settings come from the ERP_* environment keys.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/integration/erp"
)

const (
	exitOK     = 0
	exitFailed = 1 // runtime failure (retry, relay run, report)
	exitUsage  = 2 // bad flags, missing DATABASE_URL, invalid ERP config, connect failure

	erpHTTPTimeout = 10 * time.Second
)

const usage = `Usage: erp-relay [-retry OUTBOX_ID] [-timeout 60s]

Runs one ERP outbox relay pass and prints the report as JSON. DSN comes from
DATABASE_URL only; settings from ERP_RELAY_ENABLED, ERP_BASE_URL, ERP_API_KEY,
ERP_BRAND and ERP_RELAY_MAX_ATTEMPTS (ENV=production requires an https ERP_BASE_URL;
ERP_SCHEDULER_TOKEN is not used by the CLI and is not validated). With the relay disabled it prints
{"disabled": true} and exits 0.

  -retry    re-queue this erp_outbox row first (dead, held, delivered or replayed)
  -timeout  overall time limit (default 60s)

Exit 0 ok, 1 runtime failure, 2 usage, configuration or connect error.
`

// relayer is what one command run needs from the relay and the outbox.
type relayer interface {
	Retry(ctx context.Context, id string) (erp.OutboxItem, error)
	Run(ctx context.Context) (erp.RunReport, error)
}

// Seam for tests: connect builds the relayer (and its cleanup) for a DSN.
var connect = connectRelay

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("erp-relay", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, usage) }
	retryID := fs.String("retry", "", "outbox id to re-queue first")
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
	cfg := config.LoadERPRelayFrom(getenv)
	// The scheduler token is for the HTTP endpoint only; the CLI neither uses nor
	// validates it, so a bad one cannot block an operator run.
	cfg.SchedulerToken = ""
	if err := cfg.Validate(strings.EqualFold(getenv("ENV"), "production")); err != nil {
		fmt.Fprintln(stderr, "invalid ERP configuration:", err)
		return exitUsage
	}

	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	rl, closeFn, err := connect(ctx, dsn, cfg)
	if err != nil {
		// Never echo the error: it can contain connection details.
		fmt.Fprintln(stderr, "unable to connect to the database (check DATABASE_URL).")
		return exitUsage
	}
	defer closeFn()

	if *retryID != "" {
		it, err := rl.Retry(ctx, *retryID)
		if err != nil {
			fmt.Fprintln(stderr, "retry failed:", err)
			return exitFailed
		}
		fmt.Fprintf(stdout, "re-queued %s (kind=%s ref=%s) as pending\n", it.ID, it.Kind, it.RefNumber)
	}
	rep, err := rl.Run(ctx)
	if err != nil {
		fmt.Fprintln(stderr, "relay run failed:", err)
		return exitFailed
	}
	if err := printReport(stdout, rep); err != nil {
		fmt.Fprintln(stderr, "cannot print the report:", err)
		return exitFailed
	}
	return exitOK
}

// report is the JSON shape, camelCase like the admin API.
type report struct {
	Disabled  bool   `json:"disabled"`
	Claimed   int    `json:"claimed"`
	Delivered int    `json:"delivered"`
	Replayed  int    `json:"replayed"`
	Held      int    `json:"held"`
	Retried   int    `json:"retried"`
	Dead      int    `json:"dead"`
	Released  int    `json:"released"`
	Stopped   string `json:"stopped,omitempty"`
}

func printReport(w io.Writer, r erp.RunReport) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(report{
		Disabled: r.Disabled, Claimed: r.Claimed, Delivered: r.Delivered, Replayed: r.Replayed,
		Held: r.Held, Retried: r.Retried, Dead: r.Dead, Released: r.Released, Stopped: r.Stopped,
	})
}

type pooledRelay struct {
	pool  *pgxpool.Pool
	relay *erp.Relay
}

func (p pooledRelay) Retry(ctx context.Context, id string) (erp.OutboxItem, error) {
	return erp.Retry(ctx, p.pool, id)
}

func (p pooledRelay) Run(ctx context.Context) (erp.RunReport, error) { return p.relay.Run(ctx) }

// connectRelay opens a small pool and wires the relay with the validated config.
func connectRelay(ctx context.Context, dsn string, cfg config.ERPRelay) (relayer, func(), error) {
	if _, err := pgx.ParseConfig(dsn); err != nil {
		return nil, nil, errors.New("parse")
	}
	pc, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, nil, errors.New("parse")
	}
	pc.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, nil, errors.New("connect")
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, nil, errors.New("ping")
	}
	client := erp.NewStockDocClient(cfg.BaseURL, cfg.APIKey, erpHTTPTimeout)
	relay := erp.NewRelay(pool, client, erp.Config{Enabled: cfg.Enabled, Brand: cfg.Brand, MaxAttempts: cfg.MaxAttempts}, slog.Default())
	return pooledRelay{pool: pool, relay: relay}, pool.Close, nil
}
