package erp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Outlet push (POS to ERP): after the outlets pull has linked every POS outlet it can by
// code, the POS outlets that are still active and unlinked are created in the ERP. The
// pull runs first so an ERP outlet that already exists (a lost reply, a manual create) is
// linked by code and never created twice. The step has no watermark and no erp_sync_runs
// row; its result is in CatalogReport.OutletPush and the run log.

// ResourceOutletPush names the push step in logs and the report.
const ResourceOutletPush = "outlet_push"

const (
	maxOutletPushPerRun = 10 // ERP creates per run; the rest wait for the next run
	// pushReserveShare: the push stops once less than 1/pushReserveShare of the run budget
	// is left, so finished goods always get time (budget/2 with the value 2).
	pushReserveShare = 2

	PushCompleted = "completed"
	PushStopped   = "stopped" // the ERP is down or has no endpoint; the rest waits
)

// PushResult is what the push step did in one run.
type PushResult struct {
	Attempted, Linked int
	Status            string // completed | stopped
	Notes             []string
}

type pushCandidate struct {
	ID, Code, Name string
	Address, Phone *string
}

// outletPushStore is the persistence side of the push. *pgStore implements it.
type outletPushStore interface {
	// pushCandidates returns active, unlinked outlets with a valid code (the POS code rule, also
	// checked in Go), oldest first, at most maxOutletPushPerRun.
	pushCandidates(ctx context.Context) ([]pushCandidate, error)
	// countInvalidCode counts active, unlinked outlets the push can never send (NULL or
	// invalid code), so the run can say so once.
	countInvalidCode(ctx context.Context) (int, error)
	// linkPushed links one outlet to its new ERP outlet and bumps the outlets version in one
	// transaction. linked is false when another run linked the outlet first.
	linkPushed(ctx context.Context, id, slug, code string) (linked bool, err error)
}

var _ outletPushStore = (*pgStore)(nil)

func (p *pgStore) pushCandidates(ctx context.Context) ([]pushCandidate, error) {
	rows, err := p.Pool.Query(ctx, `
		SELECT id::text, upper(code), name, address, phone
		  FROM outlets
		 WHERE is_active AND erp_slug IS NULL
		   AND upper(code) ~ '^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$'
		 ORDER BY created_at, id
		 LIMIT $1`, maxOutletPushPerRun)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pushCandidate
	for rows.Next() {
		var c pushCandidate
		if err := rows.Scan(&c.ID, &c.Code, &c.Name, &c.Address, &c.Phone); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (p *pgStore) countInvalidCode(ctx context.Context) (int, error) {
	var n int
	err := p.Pool.QueryRow(ctx, `
		SELECT count(*) FROM outlets
		 WHERE is_active AND erp_slug IS NULL
		   AND (code IS NULL OR upper(code) !~ '^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$')`).Scan(&n)
	return n, err
}

func (p *pgStore) linkPushed(ctx context.Context, id, slug, code string) (bool, error) {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `UPDATE outlets SET erp_slug=$2, erp_code=$3 WHERE id=$1 AND erp_slug IS NULL`, id, slug, code)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if err := bumpVersion(ctx, tx, "outlets"); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// pushStoreFor picks the push store: the test seam, the run store when it implements the
// push side, else the pgx store over Pool.
func (s *Syncer) pushStoreFor(run runStore) outletPushStore {
	if s.pushStore != nil {
		return s.pushStore
	}
	if ps, ok := run.(outletPushStore); ok {
		return ps
	}
	if s.Pool != nil {
		return &pgStore{Pool: s.Pool}
	}
	return nil
}

// pushOutlets creates the unlinked active outlets in the ERP, at most maxOutletPushPerRun.
// stopAt is when the budget reserved for finished goods begins: no call starts after it.
// It never returns an error: every problem is a note, and an ERP that cannot take the
// call (no endpoint, 5xx, timeout) stops the step. A rejected or code-taken outlet is
// noted and the step moves on to the next one.
func (s *Syncer) pushOutlets(ctx context.Context, ps outletPushStore, stopAt time.Time) *PushResult {
	res := &PushResult{Status: PushCompleted}
	note := func(format string, a ...any) {
		if len(res.Notes) < maxNoteMessages {
			res.Notes = append(res.Notes, fmt.Sprintf(format, a...))
		}
	}
	stop := func(format string, a ...any) *PushResult {
		note(format, a...)
		res.Status = PushStopped
		return res
	}
	cands, err := ps.pushCandidates(ctx)
	if err != nil {
		return stop("outlet push stopped: read candidates: %v", err)
	}
	switch n, cerr := ps.countInvalidCode(ctx); {
	case cerr != nil:
		note("outlet push: could not count outlets with an invalid code: %v", cerr)
	case n > 0:
		note("outlet push: %d active outlets have no valid POS code and were not sent", n)
	}
	for _, c := range cands {
		if res.Attempted >= maxOutletPushPerRun {
			break
		}
		if !s.now().Before(stopAt) {
			return stop("outlet push stopped: run budget")
		}
		code := strings.ToUpper(c.Code)
		if !ValidPOSOutletCode(code) {
			note("outlet %q not created in ERP: code is not a valid outlet code", c.Code)
			continue
		}
		res.Attempted++
		// The call ends at the earlier of stopAt and the client's own timeout. A cut-off call
		// is not a failure: the Idempotency-Key makes the next run's retry safe.
		pctx, cancel := context.WithTimeout(ctx, stopAt.Sub(s.now()))
		r, outcome, detail, err := s.Pusher.CreateOutlet(pctx, OutletCreate{
			ExternalID: c.ID, Code: code, Name: c.Name, Address: c.Address, Phone: c.Phone,
		})
		cancel()
		if err != nil {
			if ctx.Err() == nil { // only the call's own deadline fired, not the run's
				return stop("outlet push stopped: run budget")
			}
			return stop("outlet push stopped: %v", err)
		}
		switch outcome {
		case OutletCreated:
			linkCode := r.Code
			if linkCode == "" {
				linkCode = code
			}
			linked, lerr := ps.linkPushed(ctx, c.ID, r.Slug, linkCode)
			var pgErr *pgconn.PgError
			switch {
			case errors.As(lerr, &pgErr) && pgErr.Code == "23505":
				note("outlet %s created in ERP as %s but not linked: slug already linked to another outlet", code, r.Slug)
			case lerr != nil:
				return stop("outlet %s created in ERP as %s but not linked: %v", code, r.Slug, lerr)
			case linked:
				res.Linked++
			default:
				note("outlet %s created in ERP as %s but was linked by another run first", code, r.Slug)
			}
		case OutletCodeTaken, OutletRejected:
			note("outlet %s not created in ERP: %s", code, detail)
		case OutletUnauthorized:
			return stop("outlet push stopped: the ERP key may not create outlets (%s); needs scope integration:outlet:write", detail)
		case OutletEndpointMissing:
			return stop("outlet push stopped: the ERP has no outlet-create endpoint (%s)", detail)
		default: // OutletUnavailable
			return stop("outlet push stopped: ERP unavailable: %s", detail)
		}
	}
	return res
}
