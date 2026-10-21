# syntax=docker/dockerfile:1
# ---- build ----
FROM golang:1.26.10 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static, stripped binary. Migrations are embedded via //go:embed, so the
# final image needs no SQL files on disk.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- run ----
# distroless static + nonroot: no shell, no package manager, minimal CVE
# surface. Runs as uid 65532.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
