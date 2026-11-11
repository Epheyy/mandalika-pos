# syntax=docker/dockerfile:1
# Image for the ERP stand-in (cmd/erpstub) as its own Cloud Run service. Not used by the
# mandalika-pos deploy. Build context = the backend/ directory with THIS file copied over
# backend/Dockerfile and the stub catalog copied to backend/erpstub-seed.json; see
# docs/runbooks/erp-standin-demo.md §2 (the runbook stages a clean `git archive`).
# ---- build ----
FROM golang:1.26.11 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/erpstub ./cmd/erpstub

# ---- run ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/erpstub /erpstub
# The stub keeps its state in memory; this catalog is reloaded on every cold start.
COPY --from=build /src/erpstub-seed.json /erpstub-seed.json
EXPOSE 8080
USER nonroot:nonroot
# Listens on $PORT (Cloud Run sets 8080). The bearer key comes from env ERP_STUB_KEY.
ENTRYPOINT ["/erpstub", "-seed", "/erpstub-seed.json"]
