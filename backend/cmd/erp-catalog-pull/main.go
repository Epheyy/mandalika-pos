// Command erp-catalog-pull runs one ERP catalog pull (plan §4.4) from a trusted machine,
// e.g. the first full run on deploy day or a manual run with a longer budget than the
// 25 s the HTTP triggers use. It reads DATABASE_URL, ERP_BASE_URL and ERP_API_KEY from the
// environment (config.Load) and prints the RunReport as JSON. It never runs migrations.
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
	"os/signal"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	"github.com/mandalika/pos-backend/internal/integration/erp"
)

const (
	exitOK     = 0
	exitFailed = 1 // failed run or runtime error
	exitUsage  = 2 // bad flags or missing ERP settings

	defaultBudget = 25 * time.Second
)

type options struct {
	Mode   erp.Mode
	Budget time.Duration
}

// parseFlags reads -mode and -budget. Unknown modes and non-positive budgets are errors.
func parseFlags(args []string, errOut io.Writer) (options, error) {
	fs := flag.NewFlagSet("erp-catalog-pull", flag.ContinueOnError)
	fs.SetOutput(errOut)
	mode := fs.String("mode", string(erp.ModeIncremental), "full, incremental or auto")
	budget := fs.Duration("budget", defaultBudget, "wall-clock budget for the whole run (e.g. 5m for a manual full run)")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	m, err := erp.ParseMode(*mode)
	if err != nil {
		return options{}, err
	}
	if *budget <= 0 {
		return options{}, errors.New("-budget must be positive")
	}
	return options{Mode: m, Budget: *budget}, nil
}

// checkConfig refuses to run without the ERP settings (the kill switch does not apply to a
// manual run, but the base URL and key are mandatory).
func checkConfig(cfg *config.Config) error {
	if cfg.ERPBaseURL == "" || cfg.ERPAPIKey == "" {
		return errors.New("ERP_BASE_URL and ERP_API_KEY must be set")
	}
	return nil
}

// exitCode: failed -> 1; completed, partial and skipped_locked -> 0.
func exitCode(status string) int {
	if status == erp.StatusFailed {
		return exitFailed
	}
	return exitOK
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	opts, err := parseFlags(args, stderr)
	if err != nil {
		if !errors.Is(err, flag.ErrHelp) {
			fmt.Fprintln(stderr, "erp-catalog-pull:", err)
		}
		return exitUsage
	}
	cfg := config.Load()
	if err := checkConfig(cfg); err != nil {
		fmt.Fprintln(stderr, "erp-catalog-pull:", err)
		return exitUsage
	}
	client, err := erp.NewClient(erp.ClientOptions{BaseURL: cfg.ERPBaseURL, APIKey: cfg.ERPAPIKey})
	if err != nil {
		fmt.Fprintln(stderr, "erp-catalog-pull: erp client:", err)
		return exitUsage
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	database, err := db.Connect(ctx, cfg.DatabaseURL, 2)
	if err != nil {
		fmt.Fprintln(stderr, "erp-catalog-pull: database connect failed") // the DSN is never printed
		return exitFailed
	}
	defer database.Close()

	syncer := &erp.Syncer{Pool: database.Pool, Source: client, Budget: opts.Budget, Logger: slog.New(slog.NewTextHandler(stderr, nil))}
	rep, err := syncer.Run(ctx, opts.Mode)
	// Any run may have committed pages (failed and errored runs included).
	_, redisSet := os.LookupEnv("REDIS_URL")
	bustReadCache(ctx, cfg, redisSet, stderr)
	if err != nil {
		fmt.Fprintln(stderr, "erp-catalog-pull:", err)
		return exitFailed
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(rep)
	return exitCode(rep.Status)
}

// bustReadCache drops the server's read cache (15 s TTL) so product and outlet lists show
// the pulled rows at once. REDIS_URL may not reach Redis from this machine: the run's
// result stands either way, and the operator is told the lists can lag by up to 15 s.
// redisSet is whether REDIS_URL is in the environment: unset, config falls back to a
// local dev Redis, which is not the server's cache.
func bustReadCache(ctx context.Context, cfg *config.Config, redisSet bool, stderr io.Writer) {
	const lag = "; product and outlet lists may lag up to 15 s"
	if !redisSet {
		fmt.Fprintln(stderr, "erp-catalog-pull: REDIS_URL not set, read cache not cleared"+lag)
		return
	}
	ctx = context.WithoutCancel(ctx) // an interrupted run still clears what it committed
	c, err := cache.Connect(ctx, cfg.RedisURL, cache.Options{DialTimeout: cfg.RedisDialTimeout, OpTimeout: cfg.RedisOpTimeout})
	defer c.Close()
	if err != nil {
		// The parse error quotes the URL, password included: never print it.
		fmt.Fprintln(stderr, "erp-catalog-pull: REDIS_URL unparseable, read cache not cleared"+lag)
		return
	}
	if err := c.DelByPrefixE(ctx, cache.ReadKeyPrefix); err != nil {
		fmt.Fprintf(stderr, "erp-catalog-pull: read cache not cleared (%v)%s\n", err, lag)
	}
}
