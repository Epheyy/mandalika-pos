package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/ota"
)

var errOtaMissingFields = errors.New("version, url, and checksum are required")

// OtaCheck is the PUBLIC Capgo self-hosted update endpoint. The plugin POSTs
// AppInfos; we read only platform + version_name and reply with the BARE Capgo
// JSON (no {data} envelope — Capgo parses the raw body). Lenient decode: a
// malformed body defaults to android/empty so a bad request just yields
// "no update".
func (h *Handlers) OtaCheck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Platform    string `json:"platform"`
		VersionName string `json:"version_name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	platform := strings.ToLower(strings.TrimSpace(body.Platform))
	if platform == "" {
		platform = "android"
	}
	latest, err := h.Repo.LatestOtaRelease(r.Context(), platform)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, ota.Decide(latest, body.VersionName))
}

// OtaPublish (authed, manage_settings) records a new bundle. Called by the
// ota-release script after uploading the zip to GCS.
func (h *Handlers) OtaPublish(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeWrite[ota.Release](w, r)
	if !ok {
		return
	}
	if in.Platform == "" {
		in.Platform = "android"
	}
	if in.Version == "" || in.URL == "" || in.Checksum == "" {
		writeErr(w, http.StatusBadRequest, errOtaMissingFields)
		return
	}
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	id, err := h.Write.PublishOtaRelease(r.Context(), in, uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}
