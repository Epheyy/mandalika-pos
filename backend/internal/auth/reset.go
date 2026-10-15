package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/clientip"
	"github.com/mandalika/pos-backend/internal/httpx"
)

// resetStore is the Postgres surface AdminResetPassword needs (faked in tests).
type resetStore interface {
	ResetPassword(ctx context.Context, id, hash string) (ResetResult, error)
}

const jtiDeleteBatch = 100

func refreshRevokedKey(userID string) string { return "refresh_revoked_before:" + userID }

// revokeMarkerMinTTL is the longest refresh-token TTL ever issued (8760 h until the
// 2026-10 cut to 720 h). A reset marker must outlive every refresh token still in
// circulation, so it never expires sooner than this.
const revokeMarkerMinTTL = 8760 * time.Hour

func revokeMarkerTTL(refreshTTL time.Duration) time.Duration {
	if refreshTTL > revokeMarkerMinTTL {
		return refreshTTL
	}
	return revokeMarkerMinTTL
}

type resetPasswordReq struct {
	Password string `json:"password"`
}

func (h *Handler) resetStore() resetStore {
	if h.reset != nil {
		return h.reset
	}
	return h.Store
}

func (h *Handler) clock() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now()
}

// AdminResetPassword handles POST /users/{id}/reset-password (admin only).
//
// Fail-safe order: validate -> block self -> hash -> Redis marker (sessions
// die first; failure aborts with nothing changed) -> DB tx (hash + revoke
// rows) -> delete live refresh keys -> clear the per-account login lockout.
func (h *Handler) AdminResetPassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req resetPasswordReq
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := ValidatePassword(req.Password); err != nil {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	// Canonicalize (lowercase, hyphenated) so the self-check, the marker key and
	// the SQL all agree with the uid claim and the key Refresh reads.
	pid, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, "invalid user id")
		return
	}
	targetID := pid.String()
	actorID, _ := ctx.Value(CtxUserID).(string)
	if actorID == targetID {
		httpx.Err(w, http.StatusForbidden, "cannot reset your own password here")
		return
	}
	hash, err := HashPassword(req.Password)
	if err != nil {
		slog.Error("admin_password_reset_failed", "stage", "hash", "actor", actorID, "target", targetID)
		httpx.Err(w, http.StatusInternalServerError, "reset failed")
		return
	}

	// Marker first: refresh tokens issued before it are dead from here. +2 (not
	// +1) absorbs the gap between reading the clock and the SET landing.
	marker := strconv.FormatInt(h.clock().Unix()+2, 10)
	if err := h.Cache.SetE(ctx, refreshRevokedKey(targetID), marker, revokeMarkerTTL(h.Cfg.RefreshTTL)); err != nil {
		slog.Error("admin_password_reset_failed", "stage", "marker", "err", err, "actor", actorID, "target", targetID)
		httpx.Err(w, http.StatusInternalServerError, "reset failed")
		return
	}

	st := h.resetStore()
	res, err := st.ResetPassword(ctx, targetID, hash)
	if errors.Is(err, ErrNotFound) {
		httpx.Err(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		slog.Error("admin_password_reset_failed", "stage", "tx", "err", err, "actor", actorID, "target", targetID)
		httpx.Err(w, http.StatusInternalServerError, "reset failed")
		return
	}

	jtis := res.JTIs
	for start := 0; start < len(jtis); start += jtiDeleteBatch {
		end := min(start+jtiDeleteBatch, len(jtis))
		keys := make([]string, 0, end-start)
		for _, j := range jtis[start:end] {
			keys = append(keys, "refresh:"+j)
		}
		// Best effort: the marker already invalidates these tokens.
		if err := h.Cache.DelE(ctx, keys...); err != nil {
			slog.Warn("admin_password_reset_key_delete_failed", "err", err, "target", targetID, "keys", len(keys))
		}
	}
	// Per-account lockout only; the per-IP bucket is deliberately left alone.
	h.Cache.ResetCounter(ctx, loginEmailKey(res.Email))

	slog.Info("admin_password_reset",
		"actor", actorID, "target", targetID, "target_role", res.Role,
		"sessions_revoked", len(jtis),
		"request_id", chimw.GetReqID(ctx), "ip", clientip.ClientIPBucket(r))
	w.WriteHeader(http.StatusNoContent)
}
