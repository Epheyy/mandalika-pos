// Package erpstub is an in-process stub of the ERP Integration API: catalog
// reads, outlet stock reads and stock-document ingestion with idempotency,
// plus /_stub/* hooks for demos and tests. cmd/erpstub wraps it in a binary;
// the Postgres gates mount it behind httptest.
package erpstub

import (
	_ "embed"
	"fmt"
	"net/http"
	"sync"
	"time"
)

//go:embed seed.json
var embeddedSeed []byte

// Config configures a Server. Key is the bearer API key (callers must supply a
// non-empty one; the stub has no default key). Seed nil means the embedded
// seed. StatePath, when set, is loaded at start if present and saved after
// every mutation. Now nil means the wall clock. Envelope picks the success envelope of
// the stock-document answers: EnvelopeLegacy ("", the default) or EnvelopeERP.
type Config struct {
	Key       string
	StatePath string
	Seed      []byte
	Now       func() time.Time
	Envelope  string
	// AssignedOutlets are the outlet codes assigned to the calling client. nil means
	// every live outlet; a non-nil slice (even empty) means only those codes.
	AssignedOutlets []string
}

// Success envelopes of POST stock-documents. The real ERP answers {"status":"success",...}
// (its reply of 2026-10-24); the stub's original form is {"success":true,...}.
const (
	EnvelopeLegacy = "legacy"
	EnvelopeERP    = "erp"
)

// Server is the stub HTTP handler.
type Server struct {
	mu        sync.Mutex // guards st; held across validate+apply+persist
	st        *state
	key       string
	statePath string
	now       func() time.Time
	erpEnv    bool            // stock-document answers use the ERP envelope
	assigned  map[string]bool // nil = every outlet; guarded by mu, in memory only

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
	if cfg.Envelope != "" && cfg.Envelope != EnvelopeLegacy && cfg.Envelope != EnvelopeERP {
		return nil, fmt.Errorf("erpstub: unknown envelope %q (want %q or %q)", cfg.Envelope, EnvelopeLegacy, EnvelopeERP)
	}
	st, err := initialState(cfg)
	if err != nil {
		return nil, err
	}
	s := &Server{st: st, key: cfg.Key, statePath: cfg.StatePath, now: cfg.Now, erpEnv: cfg.Envelope == EnvelopeERP, assigned: assignedSet(cfg.AssignedOutlets)}
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
	s.mux.HandleFunc("POST /_stub/assigned-outlets", s.hook(s.hookAssignedOutlets))
	s.mux.HandleFunc("POST /_stub/fault", s.hook(s.hookFault))
}
