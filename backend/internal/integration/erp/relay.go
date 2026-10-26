package erp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config tunes the relay; zero fields take the defaults noted in NewRelay.
type Config struct {
	Enabled     bool
	Brand       string
	MaxAttempts int           // 10
	BatchSize   int           // 50
	Budget      time.Duration // 20s: wall-clock cap of one Run
	Lease       time.Duration // 60s: a claimed row is re-claimable after this
	HoldDelay   time.Duration // 5m: next look at a held row
	AuthBackoff time.Duration // 5m: pause after 401/403
}

// Relay drains erp_outbox to the ERP. Rows are claimed under a lease, so concurrent
// runs never send the same row, and no transaction is held across HTTP.
type Relay struct {
	pool   *pgxpool.Pool
	poster Poster
	cfg    Config
	log    *slog.Logger
}

// NewRelay fills zero config values with defaults.
func NewRelay(pool *pgxpool.Pool, poster Poster, cfg Config, log *slog.Logger) *Relay {
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 10
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 50
	}
	if cfg.Budget <= 0 {
		cfg.Budget = 20 * time.Second
	}
	if cfg.Lease <= 0 {
		cfg.Lease = 60 * time.Second
	}
	if cfg.HoldDelay <= 0 {
		cfg.HoldDelay = 5 * time.Minute
	}
	if cfg.AuthBackoff <= 0 {
		cfg.AuthBackoff = 5 * time.Minute
	}
	if log == nil {
		log = slog.Default()
	}
	if cfg.Lease <= cfg.Budget+15*time.Second {
		log.Warn("erp relay: lease too short for the budget, extended", "lease", cfg.Lease, "budget", cfg.Budget)
		cfg.Lease = cfg.Budget + 45*time.Second
	}
	return &Relay{pool: pool, poster: poster, cfg: cfg, log: log}
}

// RunReport counts what one Run did. Stopped is "" when the batch was fully processed.
type RunReport struct {
	Disabled                                          bool
	Claimed, Delivered, Replayed, Held, Retried, Dead int
	Released                                          int
	Stopped                                           string
}

const (
	storeTimeout   = 5 * time.Second
	maxErrorLen    = 500
	maxDetails     = 3 // ERP error details named in last_error
	maxRawBodyLen  = 2000
	maxBackoffMins = 60
	rateLimitPause = time.Minute // minimum pause after a 429

	stopUnauthorized = "unauthorized"
	stopForbidden    = "forbidden"
	stopRateLimited  = "rate_limited"
	stopBudget       = "budget"
)

// The OR is parenthesised: without it the next_attempt_at filter would only apply to
// the lease-expired branch and backoff would be ignored.
const claimSQL = `
WITH due AS (
  SELECT id FROM erp_outbox
   WHERE (status IN ('pending','held') OR (status = 'sending' AND lease_until < now()))
     AND next_attempt_at <= now()
   ORDER BY (status = 'held'), next_attempt_at, created_at
   LIMIT $1
   FOR UPDATE SKIP LOCKED)
UPDATE erp_outbox o SET status='sending', lease_token=$2, lease_until=now() + make_interval(secs => $3), updated_at=now()
  FROM due WHERE o.id = due.id
RETURNING o.id::text, o.document_id::text, o.kind, o.location_type, o.location_id::text, o.ref_type, o.ref_id::text,
  COALESCE(o.ref_number,''), o.part, o.part_count, o.created_at, o.payload::text, o.attempts,
  o.next_attempt_at, COALESCE(o.payload_sha256,''), o.hold_reason IS NOT NULL`

// freezeSQL stores the built body once and returns the exact text to send.
const freezeSQL = `
UPDATE erp_outbox SET payload=$1::jsonb,
  payload_sha256=encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex'),
  hold_reason=NULL, updated_at=now()
WHERE id=$2 AND lease_token=$3 AND payload IS NULL
RETURNING payload::text, payload_sha256`

const holdSQL = `
UPDATE erp_outbox SET status='held', hold_reason=$1, next_attempt_at=now() + make_interval(secs => $2),
  lease_token=NULL, lease_until=NULL, updated_at=now()
WHERE id=$3 AND lease_token=$4`

// $9 is the hold reason (NULL unless the row is held); $10 drops the frozen body.
const finishSQL = `
UPDATE erp_outbox SET status=$1, attempts=$2, next_attempt_at=now() + make_interval(secs => $3),
  last_http_status=$4, last_error=$5, erp_response=COALESCE($6::jsonb, erp_response),
  hold_reason=$9,
  payload=CASE WHEN $10 THEN NULL ELSE payload END,
  payload_sha256=CASE WHEN $10 THEN NULL ELSE payload_sha256 END,
  delivered_at=CASE WHEN $1 IN ('delivered','replayed') THEN now() ELSE delivered_at END,
  lease_token=NULL, lease_until=NULL, updated_at=now()
WHERE id=$7 AND lease_token=$8`

const releaseSQL = `
UPDATE erp_outbox SET status='pending', lease_token=NULL, lease_until=NULL, updated_at=now()
WHERE id = ANY($1::uuid[]) AND lease_token=$2 AND status='sending'`

type claimedRow struct {
	header        OutboxHeader
	payload       *string
	attempts      int
	nextAttemptAt time.Time
	payloadSHA    string
	wasHeld       bool // held rows go after new documents
}

// Run claims due rows and sends them one by one until the batch, the budget or a
// run-wide ERP problem (401/403/429) ends the run.
func (r *Relay) Run(ctx context.Context) (RunReport, error) {
	if !r.cfg.Enabled {
		return RunReport{Disabled: true}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, r.cfg.Budget)
	defer cancel()
	token := uuid.NewString()

	rows, err := r.claim(ctx, token)
	if err != nil {
		return RunReport{}, err
	}
	rep := RunReport{Claimed: len(rows)}
	for i, row := range rows {
		stop := stopBudget
		var err error
		if ctx.Err() == nil {
			stop, err = r.process(ctx, token, row, &rep)
		}
		if err != nil {
			rep.Released += r.release(rows[i:], token)
			return rep, err
		}
		if stop == stopBudget { // this row was not finished either
			rep.Stopped = stopBudget
			rep.Released += r.release(rows[i:], token)
			return rep, nil
		}
		if stop != "" {
			rep.Stopped = stop
			rep.Released += r.release(rows[i+1:], token)
			return rep, nil
		}
	}
	return rep, nil
}

func (r *Relay) claim(ctx context.Context, token string) ([]claimedRow, error) {
	dbRows, err := r.pool.Query(ctx, claimSQL, r.cfg.BatchSize, token, r.cfg.Lease.Seconds())
	if err != nil {
		return nil, fmt.Errorf("erp relay: claim: %w", err)
	}
	defer dbRows.Close()
	var out []claimedRow
	for dbRows.Next() {
		var c claimedRow
		h := &c.header
		if err := dbRows.Scan(&h.ID, &h.DocumentID, &h.Kind, &h.LocationType, &h.LocationID, &h.RefType, &h.RefID,
			&h.RefNumber, &h.Part, &h.PartCount, &h.CreatedAt, &c.payload, &c.attempts,
			&c.nextAttemptAt, &c.payloadSHA, &c.wasHeld); err != nil {
			return nil, fmt.Errorf("erp relay: scan claim: %w", err)
		}
		out = append(out, c)
	}
	if err := dbRows.Err(); err != nil {
		return nil, fmt.Errorf("erp relay: read claim: %w", err)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].wasHeld != out[j].wasHeld {
			return !out[i].wasHeld
		}
		if !out[i].nextAttemptAt.Equal(out[j].nextAttemptAt) {
			return out[i].nextAttemptAt.Before(out[j].nextAttemptAt)
		}
		return out[i].header.CreatedAt.Before(out[j].header.CreatedAt)
	})
	return out, nil
}

// process handles one claimed row and returns a non-empty stop reason when the run
// must end. It never logs the payload, the response body or the key.
func (r *Relay) process(ctx context.Context, token string, row claimedRow, rep *RunReport) (string, error) {
	h := row.header
	payload, sha := "", row.payloadSHA
	if row.payload != nil {
		payload = *row.payload
	} else {
		var ok bool
		var err error
		if payload, sha, ok, err = r.buildAndFreeze(ctx, token, row, rep); err != nil || !ok {
			if err != nil && ctx.Err() != nil && isCtxErr(err) {
				return stopBudget, nil
			}
			return "", err
		}
	}
	if ctx.Err() != nil {
		return stopBudget, nil
	}
	resp, postErr := r.poster.PostStockDocument(ctx, h.DocumentID, []byte(payload))
	if postErr != nil && ctx.Err() != nil && isCtxErr(postErr) {
		return stopBudget, nil // the budget ended the call: a release, not a failed attempt
	}
	out := classify(resp, postErr, row.attempts, sha, h.DocumentID, r.cfg)
	applied, err := r.finish(ctx, token, h.ID, out)
	if err != nil {
		return "", err
	}
	r.log.Info("erp relay: document sent", "document_id", h.DocumentID, "kind", h.Kind,
		"outcome", out.status, "http_status", out.httpStatus, "attempts", out.attempts, "lease_kept", applied)
	if applied {
		out.count(rep)
	}
	return out.stop, nil
}

// buildAndFreeze builds the body for a row that has none, or parks the row (held/dead).
// ok is false when the row is finished for this run.
func (r *Relay) buildAndFreeze(ctx context.Context, token string, row claimedRow, rep *RunReport) (payload, sha string, ok bool, err error) {
	h := row.header
	in, err := LoadBuildInput(ctx, r.pool, h, r.cfg.Brand)
	if err != nil {
		return "", "", false, err
	}
	doc, hold, err := BuildDocument(in)
	switch {
	case errors.Is(err, ErrNoMovements) || errors.Is(err, ErrUnknownKind):
		dead := outcome{status: statusDead, attempts: row.attempts, lastError: err.Error()}
		applied, ferr := r.finish(ctx, token, h.ID, dead)
		if applied {
			dead.count(rep)
		}
		return "", "", false, ferr
	case err != nil:
		return "", "", false, fmt.Errorf("erp relay: build %s: %w", h.DocumentID, err)
	case hold != "":
		return "", "", false, r.park(ctx, token, h, hold, rep)
	}
	body, err := json.Marshal(doc)
	if err != nil {
		return "", "", false, fmt.Errorf("erp relay: marshal %s: %w", h.DocumentID, err)
	}
	sctx, cancel := storeContext(ctx)
	defer cancel()
	err = r.pool.QueryRow(sctx, freezeSQL, string(body), h.ID, token).Scan(&payload, &sha)
	if errors.Is(err, pgx.ErrNoRows) {
		r.log.Warn("erp relay: lease lost or payload already frozen", "document_id", h.DocumentID)
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, fmt.Errorf("erp relay: freeze %s: %w", h.DocumentID, err)
	}
	return payload, sha, true, nil
}

func (r *Relay) park(ctx context.Context, token string, h OutboxHeader, reason string, rep *RunReport) error {
	sctx, cancel := storeContext(ctx)
	defer cancel()
	tag, err := r.pool.Exec(sctx, holdSQL, reason, r.cfg.HoldDelay.Seconds(), h.ID, token)
	if err != nil {
		return fmt.Errorf("erp relay: hold %s: %w", h.DocumentID, err)
	}
	if tag.RowsAffected() > 0 {
		rep.Held++
		r.log.Info("erp relay: document held", "document_id", h.DocumentID, "kind", h.Kind, "outcome", statusHeld)
	}
	return nil
}

// finish writes the outcome. applied is false when the lease was lost (another run
// owns the row now), in which case nothing is counted. A Postgres data error (class 22)
// on the ERP-derived text is retried once without it so a bad answer never stalls the row.
func (r *Relay) finish(ctx context.Context, token, id string, o outcome) (bool, error) {
	sctx, cancel := storeContext(ctx)
	defer cancel()
	exec := func(o outcome) (int64, error) {
		tag, err := r.pool.Exec(sctx, finishSQL, o.status, o.attempts, o.delay.Seconds(),
			o.httpStatus, nullIfEmpty(o.lastError), o.response, id, token, nullIfEmpty(o.holdReason), o.clearPayload)
		return tag.RowsAffected(), err
	}
	n, err := exec(o)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && strings.HasPrefix(pgErr.Code, "22") {
		o.response, o.lastError = nil, "ERP response could not be stored"
		if o.holdReason != "" {
			o.holdReason = o.lastError
		}
		n, err = exec(o)
	}
	if err != nil {
		return false, fmt.Errorf("erp relay: update %s: %w", id, err)
	}
	return n > 0, nil
}

func isCtxErr(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}

// release puts unprocessed rows back to pending. It uses a fresh context so it still
// runs after the budget expired, and only logs on failure: the lease expiry is the
// fallback that frees the rows.
func (r *Relay) release(rows []claimedRow, token string) int {
	if len(rows) == 0 {
		return 0
	}
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.header.ID
	}
	ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
	defer cancel()
	tag, err := r.pool.Exec(ctx, releaseSQL, ids, token)
	if err != nil {
		r.log.Error("erp relay: release failed", "rows", len(ids), "err", err)
		return 0
	}
	return int(tag.RowsAffected())
}

// storeContext keeps state writes alive after the run budget expired.
func storeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), storeTimeout)
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
