// Command erpstub is a stand-alone stub of the ERP Integration API for the
// Mandalika POS backend (see internal/integration/erp/erpstub).
package main

import (
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpstub"
)

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
		log.Fatal("erpstub: no API key; set -key or ERP_STUB_KEY (there is no default key)")
	}
	var seed []byte // nil => embedded seed
	if *seedPath != "" {
		b, err := os.ReadFile(*seedPath)
		if err != nil {
			log.Fatalf("read seed: %v", err)
		}
		seed = b
	}
	s, err := erpstub.New(erpstub.Config{Key: *key, StatePath: *statePath, Seed: seed})
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
