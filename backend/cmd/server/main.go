package main

import (
	"context"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
	"github.com/mandalika/pos-backend/internal/observability"
	"github.com/mandalika/pos-backend/internal/server"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()

	observability.InitLogger(cfg.Env)
	if err := cfg.Validate(); err != nil {
		log.Fatalf("config: %v", err)
	}
	if cfg.TrustedProxyHops > 2 {
		slog.Warn("TRUSTED_PROXY_HOPS is unusually high; verify the proxy chain",
			"hops", cfg.TrustedProxyHops)
	}
	sentry, err := observability.NewSentry(cfg.SentryDSN, cfg.Env, "mandalika-pos")
	if err != nil {
		log.Fatalf("sentry: %v", err)
	}

	database, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()

	if err := database.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	log.Println("migrations applied")

	// Expired refresh-token rows: bounded, non-fatal. No ticker (Cloud Run
	// throttles idle CPU); logins also clean their own user's rows.
	// A stuck database must not hold the instance up: the sweep gets 30 s.
	sweepCtx, cancelSweep := context.WithTimeout(ctx, 30*time.Second)
	n, err := auth.NewStore(database.Pool).SweepExpiredRefresh(sweepCtx, 5000)
	cancelSweep()
	if err != nil {
		slog.Warn("refresh_sweep_failed", "err", err)
	} else if n > 0 {
		slog.Info("refresh_sweep", "deleted", n)
	}

	// Redis is an optional cache: never fatal. An unparseable URL runs disabled.
	c, err := cache.Connect(ctx, cfg.RedisURL, cache.Options{
		DialTimeout: cfg.RedisDialTimeout, OpTimeout: cfg.RedisOpTimeout})
	if err != nil {
		slog.Error("redis_url_invalid_running_without_cache", "err", err)
	}
	defer c.Close()

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      server.New(cfg, database, c, sentry),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	go func() {
		log.Printf("listening on :%s (env=%s)", cfg.Port, cfg.Env)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}
