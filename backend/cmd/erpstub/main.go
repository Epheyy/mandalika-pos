// Command erpstub is a stand-alone stub of the ERP Integration API for the
// Mandalika POS backend: catalog reads, outlet stock reads and stock-document
// ingestion with idempotency, plus /_stub/* hooks for demos and tests.
package main

import (
	_ "embed"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

//go:embed seed.json
var embeddedSeed []byte

const defaultKey = "erp_stub_localdevkey"

type config struct {
	key       string
	statePath string
	seed      []byte
	now       func() time.Time
}

type server struct {
	mu        sync.Mutex // guards st; held across validate+apply+persist
	st        *state
	key       string
	statePath string
	now       func() time.Time

	fmu         sync.Mutex // guards fault state (not persisted)
	faultStatus int
	faultLeft   int

	mux *http.ServeMux
}

func newServer(cfg config) (*server, error) {
	if cfg.now == nil {
		cfg.now = func() time.Time { return time.Now().UTC() }
	}
	st, err := initialState(cfg)
	if err != nil {
		return nil, err
	}
	s := &server{st: st, key: cfg.key, statePath: cfg.statePath, now: cfg.now}
	s.mux = http.NewServeMux()
	s.routes()
	return s, nil
}

func initialState(cfg config) (*state, error) {
	if cfg.statePath != "" {
		st, err := loadStateFile(cfg.statePath)
		if err != nil {
			return nil, err
		}
		if st != nil {
			return st, nil
		}
	}
	return parseSeed(cfg.seed)
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *server) routes() {
	const v1 = "/api/integration/v1"
	s.mux.HandleFunc("GET "+v1+"/catalog/finished-goods", s.api(s.catalogHandler(fgRecs)))
	s.mux.HandleFunc("GET "+v1+"/catalog/outlets", s.api(s.catalogHandler(outletRecs)))
	s.mux.HandleFunc("GET "+v1+"/outlets/{code}/stock", s.api(s.outletStock))
	s.mux.HandleFunc("POST "+v1+"/stock-documents", s.api(s.postStockDocument))
	s.mux.HandleFunc("GET /_stub/documents", s.hook(s.hookDocuments))
	s.mux.HandleFunc("GET /_stub/balances", s.hook(s.hookBalances))
	s.mux.HandleFunc("POST /_stub/fg", s.hook(s.hookUpsertFG))
	s.mux.HandleFunc("POST /_stub/fault", s.hook(s.hookFault))
}

func main() {
	defAddr := ":8090"
	if p := os.Getenv("PORT"); p != "" {
		defAddr = ":" + p
	}
	addr := flag.String("addr", defAddr, "listen address (env PORT overrides the default)")
	key := flag.String("key", os.Getenv("ERP_STUB_KEY"), "bearer API key (env ERP_STUB_KEY)")
	seedPath := flag.String("seed", "", "seed JSON path (default: embedded seed)")
	statePath := flag.String("state", "", "state file; loaded at start if present, saved after every mutation")
	flag.Parse()

	if *key == "" {
		*key = defaultKey
		log.Printf("WARNING: using the default API key %q; set -key or ERP_STUB_KEY", defaultKey)
	}
	seed := embeddedSeed
	if *seedPath != "" {
		b, err := os.ReadFile(*seedPath)
		if err != nil {
			log.Fatalf("read seed: %v", err)
		}
		seed = b
	}
	s, err := newServer(config{key: *key, statePath: *statePath, seed: seed})
	if err != nil {
		log.Fatalf("init: %v", err)
	}
	log.Printf("erpstub listening on %s (state persistence: %s)", *addr, persistenceLabel(*statePath))
	srv := &http.Server{Addr: *addr, Handler: s, ReadHeaderTimeout: 10 * time.Second}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

func persistenceLabel(path string) string {
	if path == "" {
		return "off"
	}
	return "on (" + path + ")"
}
