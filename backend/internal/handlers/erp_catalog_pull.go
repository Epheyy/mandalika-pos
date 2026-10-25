package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/read"
)

// ErpCatalogRunner runs one ERP catalog pull. *erp.Syncer satisfies it; tests inject fakes.
type ErpCatalogRunner interface {
	Run(ctx context.Context, mode erp.Mode) (erp.CatalogReport, error)
}

// NewErpCatalogRunner builds the pull job once at server construction. It returns nil
// (the endpoints then answer 503) when the integration is disabled, so no client is built
// and nothing touches the network. Config validation already requires the base URL and key.
func NewErpCatalogRunner(cfg *config.Config, pool *pgxpool.Pool, logger *slog.Logger) ErpCatalogRunner {
	if !cfg.ERPIntegrationEnabled {
		return nil
	}
	client, err := erp.NewClient(erp.ClientOptions{BaseURL: cfg.ERPBaseURL, APIKey: cfg.ERPAPIKey})
	if err != nil {
		slog.Error("erp catalog pull disabled: client", "err", err) // the error never carries the key
		return nil
	}
	// 20 s budget (+5 s run grace) keeps an HTTP-triggered run inside the server's 30 s
	// write timeout; long first runs use cmd/erp-catalog-pull with -budget.
	return &erp.Syncer{Pool: pool, Source: client, Logger: logger, Budget: httpPullBudget}
}

const (
	httpPullBudget = 20 * time.Second
	// httpPullWriteWindow outlives the run (budget, grace, lock release and abort
	// bookkeeping) and stays under the scheduler's 60 s attempt deadline.
	httpPullWriteWindow = 55 * time.Second
)

// SetErpCatalogRunner installs the pull job (nil disables the endpoints).
func (h *Handlers) SetErpCatalogRunner(r ErpCatalogRunner) { h.erpPull = r }

// SetErpIntegrationEnabled records the configured ERP_INTEGRATION_ENABLED flag.
func (h *Handlers) SetErpIntegrationEnabled(on bool) { h.erpEnabled = on }

// erpDBErrorText replaces relayed or stored error text that carries database output.
const erpDBErrorText = "database error (see server log)"

func sanitizeErpText(s string) string {
	if hasDBMarker(s) {
		return erpDBErrorText
	}
	return s
}

func sanitizeErpPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := sanitizeErpText(*p)
	return &v
}

// sanitizeErpRuns returns copies of the run and watermark rows with database text
// removed from their error fields at output only; stored and logged text is unchanged.
func sanitizeErpRuns(runs []read.ErpSyncRun, marks []read.ErpWatermark) ([]read.ErpSyncRun, []read.ErpWatermark) {
	outRuns := make([]read.ErpSyncRun, len(runs))
	for i, x := range runs {
		x.Error = sanitizeErpPtr(x.Error)
		outRuns[i] = x
	}
	outMarks := make([]read.ErpWatermark, len(marks))
	for i, x := range marks {
		x.LastError = sanitizeErpPtr(x.LastError)
		outMarks[i] = x
	}
	return outRuns, outMarks
}

type erpPullResource struct {
	Resource    string     `json:"resource"`
	Mode        string     `json:"mode"`
	RunID       string     `json:"runId"`
	Status      string     `json:"status"`
	Pages       int        `json:"pages"`
	Upserted    int        `json:"upserted"`
	Tombstoned  int        `json:"tombstoned"`
	Deactivated int        `json:"deactivated"`
	ItemErrors  int        `json:"itemErrors"`
	Error       string     `json:"error"`
	Watermark   *time.Time `json:"watermark"`
}

type erpPullReport struct {
	Status    string            `json:"status"`
	Resources []erpPullResource `json:"resources"`
}

func newErpPullReport(rep erp.CatalogReport) erpPullReport {
	out := erpPullReport{Status: rep.Status, Resources: make([]erpPullResource, 0, len(rep.Resources))}
	for _, x := range rep.Resources {
		out.Resources = append(out.Resources, erpPullResource{
			Resource: x.Resource, Mode: string(x.Mode), RunID: x.RunID, Status: x.Status, Pages: x.Pages,
			Upserted: x.Upserted, Tombstoned: x.Tombstoned, Deactivated: x.Deactivated,
			ItemErrors: x.ItemErrors, Error: sanitizeErpText(x.Error), Watermark: x.Watermark,
		})
	}
	return out
}

// erpCatalogPull serves both trigger routes; defaultMode applies when ?mode is absent.
func (h *Handlers) erpCatalogPull(w http.ResponseWriter, r *http.Request, defaultMode erp.Mode) {
	if h.erpPull == nil {
		httpx.Err(w, http.StatusServiceUnavailable, "ERP integration disabled")
		return
	}
	mode := defaultMode
	if q := r.URL.Query().Get("mode"); q != "" {
		m, err := erp.ParseMode(q)
		if err != nil {
			httpx.Err(w, http.StatusBadRequest, "mode must be full, incremental or auto")
			return
		}
		mode = m
	}
	// A writer without deadline support (httptest) is expected; anything else is worth a log.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(httpPullWriteWindow)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		slog.Warn("erp catalog pull: could not extend the write deadline", "err", err)
	}
	rep, err := h.erpPull.Run(r.Context(), mode)
	// Drop the read cache after every run: completed, partial and failed runs (and a run
	// that returns an error) may all have committed pages, and product and outlet lists
	// must show them now rather than after the 15 s TTL.
	h.invalidate(r)
	if err != nil {
		slog.Error("erp catalog pull", "err", err, "mode", mode)
		httpx.Err(w, http.StatusInternalServerError, "erp catalog pull failed")
		return
	}
	// 200 even for a failed or partial run: the outcome is in the body and the run rows. A
	// non-2xx would make Cloud Scheduler retry a run that already failed; the next tick is
	// the retry. skipped_locked is also 200 (a concurrent call is safe and idempotent).
	httpx.JSON(w, http.StatusOK, newErpPullReport(rep))
}

// ErpCatalogPullScheduler is the Cloud Scheduler trigger (X-Scheduler-Secret). Default
// mode when ?mode is absent: incremental.
func (h *Handlers) ErpCatalogPullScheduler(w http.ResponseWriter, r *http.Request) {
	h.erpCatalogPull(w, r, erp.ModeIncremental)
}

// ErpCatalogPullAdmin is the manual admin trigger. Default mode when ?mode is absent: full
// (an admin pressing the button wants a complete reconcile).
func (h *Handlers) ErpCatalogPullAdmin(w http.ResponseWriter, r *http.Request) {
	h.erpCatalogPull(w, r, erp.ModeFull)
}

const (
	erpSyncRunsDefaultLimit = 20
	erpSyncRunsMaxLimit     = 100
)

// ErpSyncRuns (admin) lists the latest pull runs plus the watermark rows. Read-only.
func (h *Handlers) ErpSyncRuns(w http.ResponseWriter, r *http.Request) {
	limit := erpSyncRunsDefaultLimit
	if q := r.URL.Query().Get("limit"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n < 1 {
			httpx.Err(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(n, erpSyncRunsMaxLimit)
	}
	runs, marks, err := h.Repo.ErpSyncRuns(r.Context(), limit)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	runs, marks = sanitizeErpRuns(runs, marks)
	httpx.JSON(w, http.StatusOK, map[string]any{"runs": runs, "watermarks": marks})
}
