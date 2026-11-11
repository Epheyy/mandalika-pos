# Load test, step 1 (local)

Harness for the local load test of the Mandalika POS backend. Everything talks to `http://localhost:8090`
(`lib.mjs` refuses any other host). Results of the last run: `docs/qa/2026-11-10-load-test-local.md`.

Never point this at `*.run.app`, `*.pages.dev` or any real database: the seed writes 1M orders, and the
drivers create sales and shifts.

## What it assumes

- The `roletest` Docker compose project is running (Postgres on `localhost:5433`, user/pass `mandalika`/`mandalika`,
  Redis on `6379`). It is shared with the role-test copy: the load test uses its OWN database `mandalika_load`,
  Redis db `1` and port `8090`, and never touches db `mandalika_pos`, Redis db `0` or port `8080`.
- Go and Node 24 (built-in `fetch`; no npm packages, no k6).

## Rerun

Run from the repo root.

```sh
# 1. database + env (backend/.env is gitignored; secrets are generated, never printed)
docker exec roletest-postgres-1 createdb -U mandalika mandalika_load
node loadtest/gen-env.mjs                    # DATABASE_URL, REDIS_URL=.../1, PORT=8090, JWT secrets, SEED_ADMIN_PASSWORD, raised RATE_LIMIT_*
echo JWT_ACCESS_TTL_MIN=480 >> backend/.env  # a long run must not outlive its tokens

# 2. build, migrate + seed the admin
cd backend
go build -o ../loadtest/.bin/server.exe ./cmd/server && go build -o ../loadtest/.bin/seed ./cmd/seed
../loadtest/.bin/seed
cd ..

# 3. data: 30 outlets, 61 users, 40 products / 80 variants, 500k customers, 1M orders, 365 days of shifts (~10-20 min)
docker exec -i roletest-postgres-1 psql -U mandalika -d mandalika_load -v ON_ERROR_STOP=1 < loadtest/sql/01_seed.sql
docker exec roletest-postgres-1 psql -U mandalika -d mandalika_load -c "ANALYZE"

# 3b. optional: make the heap chronological like production (the seed inserts in random day order; see the results doc)
docker exec roletest-postgres-1 psql -U mandalika -d mandalika_load -c "CLUSTER orders USING idx_orders_created" -c "ANALYZE orders"

# 4. slow-statement log for this database only (applies to new connections: do it BEFORE starting the server)
docker exec roletest-postgres-1 psql -U mandalika -d mandalika_load -c "ALTER DATABASE mandalika_load SET log_min_duration_statement = 300"

# 5. backend on :8090 (from backend/ so .env loads)
cd backend && ../loadtest/.bin/server.exe &   # (Windows binary names)

# 6. scenarios (each writes a JSON file next to where you run it)
node loadtest/run-reads.mjs loadtest/out/reads.json
node loadtest/run-c1.mjs    loadtest/out/c1.json     # not idempotent across runs: it adds 3,000 orders and drains stock
```

`loadtest/.bin/` and `loadtest/out/` are gitignored.

## Rate limits changed for the test (production keeps all of them)

| Limit | Production | Load test | Why |
|---|---|---|---|
| global per-IP `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` | 20 / 40 (1,200 requests per minute per IP) | 100000 / 100000 | all traffic is one IP |
| `/auth/login` bucket, 10 per minute per IP | hard-coded in `server.go`, not configurable | unchanged in code; `lib.mjs` deletes the `rl:auth:*` keys in Redis db 1 before every login | 61 sign-ins from one IP |

The per-email login failure limiter and the `pinstep`/`invapprove` buckets are untouched and not exercised.

## Files

- `gen-env.mjs`: writes `backend/.env`.
- `sql/01_seed.sql`: the data (parameters `-v n_orders=... -v n_customers=... -v n_days=...` for smaller runs).
- `lib.mjs`: login, timed requests, percentile summary, SQL access through `docker exec`.
- `run-reads.mjs`: R1-R7.
- `run-c1.mjs`: C1 (60 tablets x 50 sales through `/sync/batch`, 5 Backoffice clients, idempotency replay, SQL verification).

## Notes on what the data does and does not model

- Order day uniform over 365 days, outlet uniform over 30, 10:00-21:59 Asia/Jakarta, 1-4 lines, 30% with a customer,
  5% refunded (the refund rows come from the production trigger `orders_refunded_legacy_row`, so they are
  `legacy_full`, never partial), every sale paid in cash, no promotions, no loyalty points, no tax.
- `customers.total_spent`/`visit_count` are not derived from the seeded orders.
- Every test user shares the generated `SEED_ADMIN_PASSWORD` (the argon2id hash is copied from the admin row).
