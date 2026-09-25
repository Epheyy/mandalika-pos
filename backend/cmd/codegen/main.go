// Command codegen is the canonical offline validation and atomic generation tool.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	"github.com/mandalika/pos-backend/internal/codegen"
)

func main() {
	worker := flag.Bool("worker", false, "internal frozen-input worker")
	check := flag.Bool("check", false, "fail on drift without replacing output")
	limit := flag.Duration("timeout", 60*time.Second, "generation deadline (maximum 5 minutes)")
	flag.Parse()
	if *limit <= 0 || *limit > 5*time.Minute {
		fmt.Fprintln(os.Stderr, "invalid generation deadline")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *limit)
	defer cancel()
	var err error
	if *worker {
		err = codegen.Worker(ctx, os.Stdin, os.Stdout)
	} else {
		var exe string
		exe, err = os.Executable()
		if err == nil {
			err = codegen.Run(ctx, ".", "api/openapi.yaml", "api/oapi-codegen.yaml", *check, codegen.ProcessWorker(exe))
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
