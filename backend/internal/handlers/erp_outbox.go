package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/integration/erp"
)

const (
	maxErpPage       = 100000
	erpHTTPTimeout   = 10 * time.Second
	reasonRelayOff   = "ERP_RELAY_ENABLED is off"
	reasonRelayBadCf = "invalid ERP relay config"
)

// ErpOutbox serves the ERP outbox relay trigger and its admin API (plan step 5).
type ErpOutbox struct {
	pool   *pgxpool.Pool
	relay  *erp.Relay
	cfg    config.ERPRelay
	cfgErr error
}

// NewErpOutbox never fails: an invalid config is logged once (no values) and the relay
// stays disabled, so documents accumulate and POS writes are never blocked.
func NewErpOutbox(pool *pgxpool.Pool, cfg config.ERPRelay, prod bool) *ErpOutbox {
	cfgErr := cfg.Validate(prod)
	if cfgErr != nil {
		slog.Error("erp relay disabled: invalid configuration", "problem", cfgErr.Error())
	}
	client := erp.NewStockDocClient(cfg.BaseURL, cfg.APIKey, erpHTTPTimeout)
	relay := erp.NewRelay(pool, client, erp.Config{
		Enabled:     cfg.Enabled && cfgErr == nil,
		Brand:       cfg.Brand,
		MaxAttempts: cfg.MaxAttempts,
	}, slog.Default())
	return &ErpOutbox{pool: pool, relay: relay, cfg: cfg, cfgErr: cfgErr}
}

// SchedulerRelay is POST /api/v1/internal/erp/relay (Cloud Scheduler, no JWT). The shared
// secret is enforced by middleware.RequireSchedulerSecret on the route.
func (e *ErpOutbox) SchedulerRelay(w http.ResponseWriter, r *http.Request) { e.runRelay(w, r) }

// RunRelay is POST /api/v1/admin/erp/relay.
func (e *ErpOutbox) RunRelay(w http.ResponseWriter, r *http.Request) { e.runRelay(w, r) }

// relayWriteDeadline is the response write deadline of a relay run (see runRelay).
const relayWriteDeadline = 55 * time.Second

func (e *ErpOutbox) runRelay(w http.ResponseWriter, r *http.Request) {
	if !e.cfg.Enabled || e.cfgErr != nil {
		reason := reasonRelayOff
		if e.cfgErr != nil {
			reason = reasonRelayBadCf
		}
		writeJSON(w, http.StatusOK, api.ErpRelayReportResponse{Data: api.ErpRelayReport{Disabled: true, Reason: &reason}})
		return
	}
	// A run is bounded by the relay's 20 s budget, but its final state writes and the
	// release use their own short timeouts, so it can pass the server's 30 s
	// WriteTimeout. Extend this response's deadline (stays under the 60 s Cloud
	// Scheduler attempt deadline); best effort, ignored where unsupported.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(relayWriteDeadline))
	rep, err := e.relay.Run(r.Context())
	if err != nil {
		internalError(w, "erp relay run failed", err)
		return
	}
	writeJSON(w, http.StatusOK, api.ErpRelayReportResponse{Data: reportToAPI(rep)})
}

// ListOutbox is GET /api/v1/admin/erp/outbox.
func (e *ErpOutbox) ListOutbox(w http.ResponseWriter, r *http.Request) {
	page, limit := pageLimit(r)
	page = min(max(page, 1), maxErpPage)
	q := r.URL.Query()
	items, total, err := erp.List(r.Context(), e.pool, q.Get("status"), q.Get("kind"), limit, (page-1)*limit)
	if errors.Is(err, erp.ErrInvalidFilter) {
		httpx.Err(w, http.StatusBadRequest, "invalid status or kind filter")
		return
	}
	if err != nil {
		internalError(w, "erp outbox list failed", err)
		return
	}
	counts, err := erp.Counts(r.Context(), e.pool)
	if err != nil {
		internalError(w, "erp outbox counts failed", err)
		return
	}
	data := make([]api.ErpOutboxItem, len(items))
	for i, it := range items {
		data[i] = itemToAPI(it)
	}
	writeJSON(w, http.StatusOK, api.ErpOutboxListResponse{
		Data: data, Meta: *meta(total, page, limit),
		Counts: api.ErpOutboxCounts{
			Pending: counts["pending"], Held: counts["held"], Sending: counts["sending"],
			Delivered: counts["delivered"], Replayed: counts["replayed"], Dead: counts["dead"],
		},
	})
}

// GetOutbox is GET /api/v1/admin/erp/outbox/{id}.
func (e *ErpOutbox) GetOutbox(w http.ResponseWriter, r *http.Request) {
	id, ok := outboxID(w, r)
	if !ok {
		return
	}
	d, err := erp.Get(r.Context(), e.pool, id)
	if errors.Is(err, erp.ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		internalError(w, "erp outbox get failed", err)
		return
	}
	writeJSON(w, http.StatusOK, api.ErpOutboxDetailResponse{Data: detailToAPI(d)})
}

// RetryOutbox is POST /api/v1/admin/erp/outbox/{id}/retry.
func (e *ErpOutbox) RetryOutbox(w http.ResponseWriter, r *http.Request) {
	id, ok := outboxID(w, r)
	if !ok {
		return
	}
	it, err := erp.Retry(r.Context(), e.pool, id)
	switch {
	case errors.Is(err, erp.ErrNotFound):
		httpx.Err(w, http.StatusNotFound, "not found")
	case errors.Is(err, erp.ErrNotRetryable):
		httpx.Err(w, http.StatusConflict, "dokumen sedang antre atau dikirim")
	case err != nil:
		internalError(w, "erp outbox retry failed", err)
	default:
		writeJSON(w, http.StatusOK, api.ErpOutboxItemResponse{Data: itemToAPI(it)})
	}
}

func outboxID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid id")
		return "", false
	}
	return id.String(), true
}

// internalError logs the cause and answers a generic 500: a DB error text can carry
// values and must not reach the client.
func internalError(w http.ResponseWriter, msg string, err error) {
	slog.Error(msg, "err", err)
	httpx.Err(w, http.StatusInternalServerError, "internal error")
}

func reportToAPI(r erp.RunReport) api.ErpRelayReport {
	out := api.ErpRelayReport{
		Disabled: r.Disabled, Claimed: r.Claimed, Delivered: r.Delivered, Replayed: r.Replayed,
		Held: r.Held, Retried: r.Retried, Dead: r.Dead, Released: r.Released,
	}
	if r.Stopped != "" {
		s := api.ErpRelayReportStopped(r.Stopped)
		out.Stopped = &s
	}
	return out
}

func itemToAPI(it erp.OutboxItem) api.ErpOutboxItem {
	out := api.ErpOutboxItem{
		Id: uuid.MustParse(it.ID), DocumentId: uuid.MustParse(it.DocumentID),
		Kind: api.ErpOutboxItemKind(it.Kind), LocationType: api.ErpOutboxItemLocationType(it.LocationType), LocationId: uuid.MustParse(it.LocationID),
		RefType: it.RefType, RefId: uuid.MustParse(it.RefID), Part: it.Part, PartCount: it.PartCount,
		Status: api.ErpOutboxItemStatus(it.Status), Attempts: it.Attempts,
		NextAttemptAt: it.NextAttemptAt, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt,
	}
	if it.RefNumber != "" {
		out.RefNumber = nullable.NewNullableWithValue(it.RefNumber)
	}
	if it.LastHTTPStatus != nil {
		out.LastHttpStatus = nullable.NewNullableWithValue(*it.LastHTTPStatus)
	}
	if it.LastError != nil {
		out.LastError = nullable.NewNullableWithValue(*it.LastError)
	}
	if it.HoldReason != nil {
		out.HoldReason = nullable.NewNullableWithValue(*it.HoldReason)
	}
	if it.DeliveredAt != nil {
		out.DeliveredAt = nullable.NewNullableWithValue(*it.DeliveredAt)
	}
	if it.LocationName != nil {
		out.LocationName = nullable.NewNullableWithValue(*it.LocationName)
	}
	return out
}

// detailToAPI copies the item fields into the flat generated detail type; payload and
// erpResponse are null when absent.
func detailToAPI(d erp.OutboxDetail) api.ErpOutboxDetail {
	it := itemToAPI(d.OutboxItem)
	out := api.ErpOutboxDetail{
		Id: it.Id, DocumentId: it.DocumentId, Kind: api.ErpOutboxDetailKind(it.Kind),
		LocationType: api.ErpOutboxDetailLocationType(it.LocationType), LocationId: it.LocationId, RefType: it.RefType, RefId: it.RefId,
		RefNumber: it.RefNumber, Part: it.Part, PartCount: it.PartCount, Status: api.ErpOutboxDetailStatus(it.Status),
		Attempts: it.Attempts, NextAttemptAt: it.NextAttemptAt, LastHttpStatus: it.LastHttpStatus,
		LastError: it.LastError, HoldReason: it.HoldReason, CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt,
		DeliveredAt: it.DeliveredAt, LocationName: it.LocationName,
		Payload: jsonObject(d.Payload), ErpResponse: jsonObject(d.ERPResponse),
	}
	if d.PayloadSHA256 != nil {
		out.PayloadSha256 = nullable.NewNullableWithValue(*d.PayloadSHA256)
	}
	return out
}

// jsonObject decodes a stored JSON object, or null when absent or not an object.
func jsonObject(raw json.RawMessage) nullable.Nullable[map[string]interface{}] {
	var m map[string]interface{}
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil || m == nil {
		n := nullable.Nullable[map[string]interface{}]{}
		n.SetNull()
		return n
	}
	return nullable.NewNullableWithValue(m)
}
