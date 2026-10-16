# Mandalika POS — Backend (Go + PostgreSQL + Redis)

Phase A foundation: config, schema migrations, argon2id+JWT auth, RBAC + outlet
middleware, Redis (refresh store / rate limit / idempotency primitives), health,
seed-admin CLI, OpenAPI skeleton. See `../.claude/plans/so-this-entire-thing-mellow-lake.md`.

## Quick start

```bash
cp .env.example .env          # edit secrets + SEED_ADMIN_PASSWORD
docker compose up -d          # Postgres :5432, Redis :6379
go mod tidy
go run ./cmd/seed             # creates bootstrap admin (runs migrations too)
go run ./cmd/server           # http://localhost:8080
```

## Smoke test

```bash
curl localhost:8080/livez   # /healthz is the same handler but Cloud Run reserves it
curl -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@mandalika.local","password":"<SEED_ADMIN_PASSWORD>"}'
# → {"data":{"access":"...","refresh":"...","user":{...}}}
curl localhost:8080/api/v1/auth/me -H "Authorization: Bearer <access>"
```

## Layout

```
cmd/server   HTTP entrypoint (graceful shutdown, auto-migrate)
cmd/seed     bootstrap admin CLI
internal/
  config     env/.env loader
  db         pgx pool + embedded sequential migration runner
  cache      Redis (get/set/setnx/incr)
  domain     (Phase B) structs mirroring src/types/index.ts
  auth       argon2id, JWT (access+refresh+rotation), user store, handlers
  middleware RequireAuth / RequireRole / RequirePermission (+ X-Outlet-Id)
  httpx      JSON envelope {data,error,meta}
  server     chi router, CORS, health, /api/v1
api/openapi.yaml  contract (source of truth; codegen in Phase B)
internal/db/migrations/0001_init.sql  full schema (tenancy + sync/idempotency)
```

## Migrations

Embedded; applied in lexical filename order, tracked in `schema_migrations`.
Add `0002_*.sql` etc. Re-running is safe (idempotent check per file).

## Status / next (Phase B)

- Generate Go DTOs + TS client from `api/openapi.yaml` (oapi-codegen / openapi-typescript)
- Read endpoints for all resources (outlet-scoped) + reports aggregation
- Redis read-cache; users CRUD; scaffold `apps/pos` (Capacitor) + `apps/backoffice`
