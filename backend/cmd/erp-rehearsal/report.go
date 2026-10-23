package main

import (
	"fmt"
	"io"
	"strings"
	"time"
)

type result struct {
	n      string
	name   string
	status string // PASS | FAIL | SKIP
	notes  []string
	err    error
	took   time.Duration
}

// printReport writes the step-by-step table (demo evidence) and returns the number of failures.
func printReport(w io.Writer, rs []result) int {
	fails := 0
	fmt.Fprintln(w, "\n=== ERP rehearsal report ===")
	for _, r := range rs {
		fmt.Fprintf(w, "[%s] step %-3s %s (%s)\n", r.status, r.n, r.name, r.took.Round(time.Millisecond))
		for _, n := range r.notes {
			fmt.Fprintf(w, "        - %s\n", n)
		}
		if r.err != nil {
			fails++
			fmt.Fprintf(w, "        ! %v\n", r.err)
		}
	}
	fmt.Fprintln(w, strings.Repeat("-", 60))
	fmt.Fprintf(w, "%-4s %-5s %s\n", "", "step", "result")
	for _, r := range rs {
		fmt.Fprintf(w, "%-4s %-5s %s\n", r.status, r.n, r.name)
	}
	if fails == 0 {
		fmt.Fprintln(w, "\nRESULT: ALL STEPS PASS")
	} else {
		fmt.Fprintf(w, "\nRESULT: %d STEP(S) FAILED\n", fails)
	}
	return fails
}
