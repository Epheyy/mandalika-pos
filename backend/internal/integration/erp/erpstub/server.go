// Package erpstub is an in-process stub of the ERP Integration API: catalog
// reads, outlet stock reads and stock-document ingestion with idempotency,
// plus /_stub/* hooks for demos and tests. cmd/erpstub wraps it in a binary;
// the Postgres gates mount it behind httptest.
package erpstub

import (
	_ "embed"
	"net/http"
	"sync"
	"time"
)

//go:embed seed.json
var embeddedSeed []byte

// Config configures a Server. Key is the bearer API key (callers must supply a
// non-empty one; the stub has no default key). Seed nil means the embedded
// seed. StatePath, when set, is loaded at start if present and saved after
// every mutation. Now nil means the wall clock.
type Config struct {
	Key       string
	StatePath string
	Seed      []byte
	Now       func() time.Time
}

// Server is the stub HTTP handler.
type Server struct {
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

// New builds a Server from cfg.
func New(cfg Config) (*Server, error) {
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return time.Now().UTC() }
	}
	if cfg.Seed == nil {
		cfg.Seed = embeddedSeed
	}
	st, err := initialState(cfg)
	if err != nil {
		return nil, err
	}
	s := &Server{st: st, key: cfg.Key, statePath: cfg.StatePath, now: cfg.Now}
	s.mux = http.NewServeMux()
	s.routes()
	return s, nil
}

func initialState(cfg Config) (*state, error) {
	if cfg.StatePath != "" {
		st, err := loadStateFile(cfg.StatePath)
		if err != nil {
			return nil, err
		}
		if st != nil {
			return st, nil
		}
	}
	return parseSeed(cfg.Seed)
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) routes() {
	const v1 = "/api/integration/v1"
	s.mux.HandleFunc("GET "+v1+"/catalog/finished-goods", s.api(s.catalogHandler(fgRecs)))
	s.mux.HandleFunc("GET "+v1+"/catalog/outlets", s.api(s.catalogHandler(outletRecs)))
	s.mux.HandleFunc("GET "+v1+"/outlets/{code}/stock", s.api(s.outletStock))
	s.mux.HandleFunc("POST "+v1+"/stock-documents", s.api(s.postStockDocument))
	s.mux.HandleFunc("GET /_stub/documents", s.hook(s.hookDocuments))
	s.mux.HandleFunc("GET /_stub/balances", s.hook(s.hookBalances))
	s.mux.HandleFunc("POST /_stub/fg", s.hook(s.hookUpsertFG))
	s.mux.HandleFunc("POST /_stub/outlet", s.hook(s.hookUpsertOutlet))
	s.mux.HandleFunc("POST /_stub/fault", s.hook(s.hookFault))
}
