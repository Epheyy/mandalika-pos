package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// Limits for POST /error-logs. Old POS bundles send every dead letter in one call, so a
// big report is not dropped for its size: the body may reach 1 MiB (413 beyond) and the
// first maxErrorLogItems items are kept (the rest are ignored, never an error).
const (
	errorLogsBodyLimit = 1 << 20
	maxErrorLogItems   = 50
)

// CreateErrorLogs records a batch of client errors (sync/runtime/print). Outlet
// and user come from the JWT; the rest from the body. Every row is redacted and
// capped inside write.InsertErrorLogs; the batch is stored atomically.
func (h *Handlers) CreateErrorLogs(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, errorLogsBodyLimit)
	var body struct {
		Items []struct {
			DeviceID        string          `json:"deviceId"`
			OutletName      string          `json:"outletName"`
			Source          string          `json:"source"`
			Kind            string          `json:"kind"`
			Action          string          `json:"action"`
			Message         string          `json:"message"`
			Payload         json.RawMessage `json:"payload"`
			Breadcrumbs     json.RawMessage `json:"breadcrumbs"`
			AppVersion      string          `json:"appVersion"`
			ClientCreatedAt *time.Time      `json:"clientCreatedAt"`
		} `json:"items"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.Err(w, http.StatusRequestEntityTooLarge, "error log batch too large")
			return
		}
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(body.Items) > maxErrorLogItems {
		body.Items = body.Items[:maxErrorLogItems]
	}
	c, _ := h.caller(r)
	logs := make([]write.ErrorLog, 0, len(body.Items))
	for _, it := range body.Items {
		if it.Message == "" {
			continue
		}
		src := it.Source
		if src == "" {
			src = "runtime"
		}
		logs = append(logs, write.ErrorLog{
			OutletID: c.outletID, OutletName: it.OutletName, DeviceID: it.DeviceID,
			UserID: c.userID, UserName: c.name, Source: src, Kind: it.Kind,
			Action: it.Action, Message: it.Message, Payload: it.Payload,
			Breadcrumbs: it.Breadcrumbs, AppVersion: it.AppVersion,
			ClientCreatedAt: it.ClientCreatedAt,
		})
	}
	if err := h.Write.InsertErrorLogs(r.Context(), logs); err != nil {
		slog.Error("error log insert failed", "err", err)
		httpx.Err(w, http.StatusInternalServerError, "failed to store error logs")
		return
	}
	h.maybeSweepErrorLogs()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accepted": len(logs)})
}

// Error-log retention: at most one sweep per instance per interval, run inline after the
// insert (a request has CPU; Cloud Run throttles idle instances, so a detached goroutine
// could stall) and bounded by a short context. The startup sweep in cmd/server covers
// quiet periods.
const (
	errorLogSweepInterval = time.Hour
	errorLogSweepBatch    = 1000
	errorLogSweepBatches  = 20
	errorLogSweepBudget   = 3 * time.Second
)

func (h *Handlers) maybeSweepErrorLogs() {
	now := time.Now().UnixNano()
	last := h.lastErrorLogSweep.Load()
	if now-last < int64(errorLogSweepInterval) || !h.lastErrorLogSweep.CompareAndSwap(last, now) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), errorLogSweepBudget)
	defer cancel()
	n, skipped, err := h.Write.SweepErrorLogs(ctx, errorLogSweepBatch, errorLogSweepBatches)
	switch {
	case err != nil:
		slog.Warn("error_log_sweep_failed", "err", err)
	case n > 0:
		slog.Info("error_log_sweep", "deleted", n, "skipped", skipped)
	}
}
