package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strings"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/ota"
)

var errOtaMissingFields = errors.New("version, url, and checksum are required")
var errOtaNativeVersionCode = errors.New("nativeVersionCode (the target APK versionCode, >= 1) is required")
var errOtaCommitSha = errors.New("commitSha (40-char lowercase hex of the tested commit) is required")

var otaCommitShaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

// validateOtaPublish checks the required fields of a publish request.
func validateOtaPublish(in ota.Release) error {
	if in.Version == "" || in.URL == "" || in.Checksum == "" {
		return errOtaMissingFields
	}
	if in.NativeVersionCode < 1 || in.NativeVersionCode > math.MaxInt32 {
		return errOtaNativeVersionCode
	}
	if !otaCommitShaRe.MatchString(in.CommitSHA) {
		return errOtaCommitSha
	}
	return nil
}

// errOtaUnavailable is the generic error surfaced to the PUBLIC /ota/check on a
// backend fault — the real error is logged, never echoed to an unauth caller.
var errOtaUnavailable = errors.New("ota check unavailable")

// OtaCheck is the PUBLIC Capgo self-hosted update endpoint. The plugin POSTs
// AppInfos; we read only platform + version_name + version_code (the APK
// versionCode: a bundle is only offered to the build it targets) and reply with the BARE Capgo
// JSON (no {data} envelope — Capgo parses the raw body). Lenient decode: a
// malformed body defaults to android/empty so a bad request just yields
// "no update".
func (h *Handlers) OtaCheck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Platform    string          `json:"platform"`
		VersionName string          `json:"version_name"`
		VersionCode json.RawMessage `json:"version_code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	platform := strings.ToLower(strings.TrimSpace(body.Platform))
	if platform == "" {
		platform = "android"
	}
	code, ok := ota.ParseVersionCode(body.VersionCode)
	if !ok {
		// No usable versionCode: fail safe, never offer a bundle (no DB hit).
		writeJSON(w, http.StatusOK, ota.Decide(nil, body.VersionName))
		return
	}
	latest, err := h.Repo.LatestOtaRelease(r.Context(), platform, code)
	if err != nil {
		// Public endpoint: log the real error, echo only a generic message.
		slog.Error("ota check: latest release", "platform", platform, "err", err)
		writeErr(w, http.StatusInternalServerError, errOtaUnavailable)
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
	if err := validateOtaPublish(in); err != nil {
		writeErr(w, http.StatusBadRequest, err)
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
