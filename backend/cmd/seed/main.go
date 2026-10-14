// Seeds the bootstrap admin user (replaces the old hardcoded Firebase email).
package main

import (
	"context"
	"errors"
	"log"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/db"
)

func main() {
	cfg := config.Load()
	ctx := context.Background()

	if cfg.SeedAdminPass == "" {
		log.Fatal("SEED_ADMIN_PASSWORD not set")
	}

	database, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()
	if err := database.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	var existing string
	err = database.Pool.QueryRow(ctx,
		`SELECT id FROM users WHERE email = $1`, cfg.SeedAdminEmail).Scan(&existing)
	if err == nil {
		log.Printf("admin already exists: %s (%s)", cfg.SeedAdminEmail, existing)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		log.Fatalf("check admin: %v", err)
	}

	store := auth.NewStore(database.Pool)
	id, err := store.CreateUser(ctx,
		cfg.SeedAdminEmail, cfg.SeedAdminPass, cfg.SeedAdminName, "admin", "", nil)
	if err != nil {
		log.Fatalf("create admin: %v", err)
	}
	log.Printf("seeded admin %s id=%s", cfg.SeedAdminEmail, id)
}
