package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// item is where one run FG lives in the POS (product + variant).
type item struct {
	fg                         fg
	ProductID, VariantID, Size string
}

// rt is the shared state of a rehearsal run.
type rt struct {
	cfg       config
	be, stub  *httpc
	start     time.Time
	fgs       []fg
	items     map[string]*item // by letter
	outletID  string
	outletSlg string // outlet slug on the stub
	outletRow obj    // the POS outlet as GET /outlets returned it
	shiftID   string
	shiftOpen bool // true when this run opened the shift
	db        *pgxpool.Pool
	notes     []string
	vars      map[string]string // facts later steps need (order ids, outbox ids ...)
}

func newRT(c config) *rt {
	return &rt{
		cfg: c, start: time.Now(), fgs: fixtures(c.runID), items: map[string]*item{}, vars: map[string]string{},
		stub: newHTTP(c.stubURL, map[string]string{"Authorization": "Bearer " + c.stubKey}),
	}
}

func (r *rt) close() {
	if r.db != nil {
		r.db.Close()
	}
}

func (r *rt) note(format string, args ...any) {
	r.notes = append(r.notes, fmt.Sprintf(format, args...))
}

type step struct {
	n, name string
	fn      func(*rt) error
}

// runAll runs the steps in order; after the first failure the rest are SKIP, because
// every step builds on the previous ones (except the final agreement check, which still
// runs so a failure leaves the cross-system evidence).
func (r *rt) runAll(steps []step) []result {
	var out []result
	failed := false
	for _, s := range steps {
		if failed && s.n != "14" {
			out = append(out, result{n: s.n, name: s.name, status: "SKIP"})
			continue
		}
		r.notes = nil
		t0 := time.Now()
		err := s.fn(r)
		res := result{n: s.n, name: s.name, status: "PASS", notes: r.notes, err: err, took: time.Since(t0)}
		if err != nil {
			res.status, failed = "FAIL", true
		}
		out = append(out, res)
	}
	return out
}

// beCall adds the active outlet header so the admin token acts as that outlet's cashier.
func (r *rt) beCall(method, path string, h map[string]string, body any) (resp, error) {
	if r.outletID != "" {
		hh := map[string]string{"X-Outlet-Id": r.outletID}
		for k, v := range h {
			hh[k] = v
		}
		h = hh
	}
	return r.be.call(method, path, h, body)
}

func (r *rt) beMust(method, path string, h map[string]string, body any) (resp, error) {
	out, err := r.beCall(method, path, h, body)
	if err != nil {
		return out, fmt.Errorf("%s %s: %w", method, redactQuery(path), err)
	}
	if !out.ok() {
		return out, fmt.Errorf("%s %s: %s", method, redactQuery(path), out.brief())
	}
	return out, nil
}

func (r *rt) stubDocs() ([]obj, error) {
	out, err := r.stub.must("GET", "/_stub/documents", nil, nil)
	if err != nil {
		return nil, err
	}
	return list(out.Body, "data"), nil
}

func (r *rt) stubBal(locType, slug, code string) (int, error) {
	out, err := r.stub.must("GET", "/_stub/balances", nil, nil)
	if err != nil {
		return 0, err
	}
	for _, b := range list(out.Body, "data") {
		if str(b, "location_type") == locType && str(b, "location_slug") == slug && str(b, "fg_code") == code {
			return num(b, "qty"), nil
		}
	}
	return 0, nil
}

// wantBal asserts a stub balance and records it as evidence.
func (r *rt) wantBal(locType, slug string, f fg, want int) error {
	got, err := r.stubBal(locType, slug, f.Code)
	if err != nil {
		return err
	}
	r.note("stub balance %s/%s %s = %d (want %d)", locType, slug, f.Code, got, want)
	if got != want {
		return fmt.Errorf("stub balance %s/%s %s = %d, want %d", locType, slug, f.Code, got, want)
	}
	return nil
}

func (r *rt) openDB() error {
	if r.cfg.dbURL == "" {
		return nil
	}
	pc, err := pgxpool.ParseConfig(r.cfg.dbURL)
	if err != nil {
		return fmt.Errorf("REHEARSAL_DATABASE_URL is not a valid DSN")
	}
	pc.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pc.MaxConns = 2
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return fmt.Errorf("database connect: %w", err)
	}
	if err := p.Ping(ctx); err != nil {
		p.Close()
		return fmt.Errorf("database ping: %w", err)
	}
	r.db = p
	return nil
}
