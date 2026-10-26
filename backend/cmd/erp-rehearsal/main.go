// Command erp-rehearsal is the black-box rehearsal of the ERP stand-in demo
// (docs/runbooks/erp-standin-demo.md, plan 2026-10-22 section 6.1). It drives a RUNNING
// backend and a RUNNING cmd/erpstub over HTTP only (admin API, /sync/batch, the scheduler
// relay and catalog-pull endpoints, the stub's /_stub/* hooks) and asserts the outcome
// step by step. It never seeds through SQL, so it runs unchanged against the live test
// environment. An optional read-only DSN (REHEARSAL_DATABASE_URL) adds the ledger
// invariant check. -print-seed prints the stub seed the run expects (no network).
package main

import (
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

type config struct {
	backendURL, stubURL, stubKey, schedToken string
	adminEmail, adminPass, dbURL             string
	outletCode, outletSlug, warehouseID      string
	runID, firstPull                         string
	faultWait                                time.Duration
}

func main() { os.Exit(run()) }

func run() int {
	var c config
	var live, seed bool
	flag.StringVar(&c.outletCode, "outlet-code", "", "POS outlet code to use (required)")
	flag.StringVar(&c.outletSlug, "outlet-slug", "", "stub outlet slug (default rehearsal-<code>; the POS outlet's erp_slug wins when linked)")
	flag.StringVar(&c.warehouseID, "warehouse-id", "", "POS warehouse id (its documents must stay held: the ERP takes outlets only)")
	flag.StringVar(&c.runID, "run-id", time.Now().UTC().Format("060102t150405"), "makes every FG code/slug unique per run")
	flag.BoolVar(&live, "live", false, "required when the backend or stub host is not loopback")
	flag.BoolVar(&seed, "print-seed", false, "print the stub seed JSON for -run-id/-outlet-code and exit (no network)")
	flag.DurationVar(&c.faultWait, "fault-wait", 4*time.Minute, "bounded wait for the 503 backoff to expire")
	flag.StringVar(&c.firstPull, "first-pull", "", "mode of the step 2 pull: full or incremental (default: full locally, incremental with -live, "+
		"because a full run deactivates linked POS variants missing from the stub catalog)")
	flag.Parse()
	if c.firstPull == "" {
		c.firstPull = "full"
		if live {
			c.firstPull = "incremental"
		}
	}
	if c.firstPull != "full" && c.firstPull != "incremental" {
		fmt.Fprintln(os.Stderr, "erp-rehearsal: -first-pull must be full or incremental")
		return 2
	}

	if seed {
		if err := printSeed(os.Stdout, c.runID, c.outletCode, c.outletSlug); err != nil {
			fmt.Fprintln(os.Stderr, "erp-rehearsal:", err)
			return 2
		}
		return 0
	}
	if err := loadEnv(&c, live); err != nil {
		fmt.Fprintln(os.Stderr, "erp-rehearsal:", err)
		return 2
	}
	rt := newRT(c)
	results := rt.runAll(allSteps())
	rt.close()
	if printReport(os.Stdout, results) > 0 {
		return 1
	}
	return 0
}

func loadEnv(c *config, live bool) error {
	var missing []string
	read := func(dst *string, name string, required bool) {
		*dst = strings.TrimSpace(os.Getenv(name))
		if required && *dst == "" {
			missing = append(missing, name)
		}
	}
	read(&c.backendURL, "REHEARSAL_BACKEND_URL", true)
	read(&c.adminEmail, "REHEARSAL_ADMIN_EMAIL", true)
	read(&c.adminPass, "REHEARSAL_ADMIN_PASSWORD", true)
	read(&c.stubURL, "REHEARSAL_STUB_URL", true)
	read(&c.stubKey, "REHEARSAL_STUB_KEY", true)
	read(&c.schedToken, "REHEARSAL_SCHEDULER_TOKEN", true)
	read(&c.dbURL, "REHEARSAL_DATABASE_URL", false)
	if len(missing) > 0 {
		return fmt.Errorf("missing environment variables: %s", strings.Join(missing, ", "))
	}
	if c.outletCode == "" || c.warehouseID == "" {
		return fmt.Errorf("-outlet-code and -warehouse-id are required")
	}
	if normID(c.runID) == "" {
		return fmt.Errorf("-run-id must contain letters or digits")
	}
	if !live {
		for _, u := range []string{c.backendURL, c.stubURL} {
			if !isLoopback(u) {
				return fmt.Errorf("refusing to run against non-loopback host %q without -live", hostOf(u))
			}
		}
	}
	return nil
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Hostname()
}

func isLoopback(raw string) bool {
	h := hostOf(raw)
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
