.PHONY: tidy run seed up down test gen gen-go gen-ts gen-check vet fmt migrate-fs migrate-fs-dry

up:
	docker compose up -d

down:
	docker compose down

tidy:
	go mod tidy

run:
	go run ./cmd/server

seed:
	go run ./cmd/seed

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

# Regenerate Go DTOs + chi/strict server from the OpenAPI contract.
gen-go:
	go tool oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml

# Regenerate the TypeScript client (requires monorepo + pnpm, Phase B task 15).
gen-ts:
	cd .. && pnpm --filter @mandalika/api gen

# Phase F cutover — Firestore export → Postgres. EXPORT=path to export.json.
migrate-fs-dry:
	go run ./cmd/migrate-firestore --input $(EXPORT) --dry-run

migrate-fs:
	go run ./cmd/migrate-firestore --input $(EXPORT)

gen: gen-go gen-ts

# CI drift gate: regenerate Go from spec; fail if the tree changed
# (handler/spec drift means api.gen.go was not committed in sync).
gen-check: gen-go
	@git diff --exit-code -- internal/api/api.gen.go \
	  || (echo "DRIFT: api.gen.go out of sync with api/openapi.yaml — run 'make gen-go' and commit" && exit 1)
