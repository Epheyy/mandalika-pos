package erpstub

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

type warehouse struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type location struct {
	Type string `json:"type"`
	Slug string `json:"slug"`
}

type docRef struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Number string `json:"number"`
}

type partInfo struct {
	Index int64 `json:"index"`
	Count int64 `json:"count"`
}

// docRecord is one applied stock document, kept in received order.
type docRecord struct {
	Scope       string          `json:"scope"`
	DocumentID  string          `json:"document_id"`
	Kind        string          `json:"kind"`
	Location    location        `json:"location"`
	Ref         docRef          `json:"ref"`
	Part        *partInfo       `json:"part,omitempty"`
	Hash        string          `json:"hash"`
	MovementIDs []string        `json:"movement_ids"`
	ReceivedAt  time.Time       `json:"received_at"`
	Body        json.RawMessage `json:"body"`
}

// balance is the live quantity of one FG at one location.
type balance struct {
	LocationType string    `json:"location_type"`
	LocationSlug string    `json:"location_slug"`
	FgCode       string    `json:"fg_code"`
	Qty          int64     `json:"qty"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// state is the full mutable state of the stub (also the persisted file shape).
type state struct {
	FinishedGoods []erpapi.IntegrationFG     `json:"finished_goods"`
	Outlets       []erpapi.IntegrationOutlet `json:"outlets"`
	Warehouses    []warehouse                `json:"warehouses"`
	Documents     []docRecord                `json:"documents"`
	Movements     map[string]string          `json:"movements"`
	Balances      map[string]*balance        `json:"balances"`
}

func (st *state) ensureMaps() {
	if st.Movements == nil {
		st.Movements = map[string]string{}
	}
	if st.Balances == nil {
		st.Balances = map[string]*balance{}
	}
}

func movementKey(scope, movementID string) string { return scope + "\x00" + movementID }

func balanceKey(locType, locSlug, fgCode string) string {
	return locType + "\x00" + locSlug + "\x00" + fgCode
}

func parseSeed(b []byte) (*state, error) {
	var st state
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("parse seed: %w", err)
	}
	st.ensureMaps()
	return &st, nil
}

// loadStateFile returns (nil, nil) when the file does not exist.
func loadStateFile(path string) (*state, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}
	var st state
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("parse state: %w", err)
	}
	st.ensureMaps()
	return &st, nil
}

// saveStateFile writes atomically: temp file in the same dir, then rename.
func saveStateFile(path string, st *state) error {
	b, err := json.Marshal(st)
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".erpstub-state-*")
	if err != nil {
		return fmt.Errorf("create temp state: %w", err)
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("write temp state: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("sync temp state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("close temp state: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return fmt.Errorf("rename state: %w", err)
	}
	return nil
}

func cloneState(st *state) (*state, error) {
	b, err := json.Marshal(st)
	if err != nil {
		return nil, err
	}
	var c state
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	c.ensureMaps()
	return &c, nil
}

// commitLocked applies a mutation and persists it. When persistence is on and
// saving fails, the in-memory state is restored. Caller holds s.mu.
func (s *Server) commitLocked(apply func()) error {
	if s.statePath == "" {
		apply()
		return nil
	}
	snap, err := cloneState(s.st)
	if err != nil {
		return err
	}
	apply()
	if err := saveStateFile(s.statePath, s.st); err != nil {
		s.st = snap
		log.Printf("erpstub: persist state failed, change rolled back: %v", err)
		return err
	}
	return nil
}

func (st *state) findFGByCode(code string, includeDeleted bool) *erpapi.IntegrationFG {
	for i := range st.FinishedGoods {
		fg := &st.FinishedGoods[i]
		if fg.Code == code && (includeDeleted || fg.DeletedAt == nil) {
			return fg
		}
	}
	return nil
}

func (st *state) findOutlet(match func(*erpapi.IntegrationOutlet) bool) *erpapi.IntegrationOutlet {
	for i := range st.Outlets {
		o := &st.Outlets[i]
		if o.DeletedAt == nil && match(o) {
			return o
		}
	}
	return nil
}

func (st *state) hasWarehouse(slug string) bool {
	for _, w := range st.Warehouses {
		if w.Slug == slug {
			return true
		}
	}
	return false
}

func (st *state) findDoc(scope, documentID string) *docRecord {
	for i := range st.Documents {
		if st.Documents[i].Scope == scope && strings.EqualFold(st.Documents[i].DocumentID, documentID) {
			return &st.Documents[i]
		}
	}
	return nil
}
