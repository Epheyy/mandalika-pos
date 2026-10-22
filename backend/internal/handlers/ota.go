package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strings"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/httpx"
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

// OtaCheck is the PUBLIC Capgo self-hosted update endpoint. The plugin POSTs
// AppInfos; we read only platform + version_name + version_build + version_code (the APK
// versionCode: a bundle is only offered to the build it targets) and reply with the BARE Capgo
// JSON (no {data} envelope — Capgo parses the raw body). Lenient decode: a
// malformed body defaults to android/empty so a bad request just yields
// "no update".
func (h *Handlers) OtaCheck(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Platform     string          `json:"platform"`
		VersionName  string          `json:"version_name"`
		VersionBuild string          `json:"version_build"`
		VersionCode  json.RawMessage `json:"version_code"`
		// Capgo's persisted random install id and the app-set custom id (the bound outlet id
		// once the POS sets it). Opaque, client-asserted, logged only; never trusted or echoed.
		DeviceID string `json:"device_id"`
		CustomID string `json:"custom_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); isBodyTooLarge(err) {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	platform := strings.ToLower(strings.TrimSpace(body.Platform))
	if platform == "" {
		platform = "android"
	}
	versionName := otaOpaqueID(body.VersionName)
	versionBuild := otaOpaqueID(body.VersionBuild)
	deviceID := otaOpaqueID(body.DeviceID)
	customID := otaOpaqueID(body.CustomID)
	code, ok := ota.ParseVersionCode(body.VersionCode)
	if !ok {
		// No usable versionCode: fail safe, never offer a bundle (no DB hit).
		logOtaCheck(platform, versionName, versionBuild, 0, deviceID, customID, false)
		writeJSON(w, http.StatusOK, ota.Decide(nil, body.VersionName, body.VersionBuild))
		return
	}
	latest, err := h.Repo.LatestOtaRelease(r.Context(), platform, code)
	if err != nil {
		// Public endpoint: writeErr logs the real error once and echoes only a generic message.
		writeErr(w, r, http.StatusInternalServerError, fmt.Errorf("ota check: latest release (%s): %w", platform, err))
		return
	}
	resp := ota.Decide(latest, body.VersionName, body.VersionBuild)
	logOtaCheck(platform, versionName, versionBuild, code, deviceID, customID, resp.URL != "")
	writeJSON(w, http.StatusOK, resp)
}

// otaMaxIDLen caps what a public caller can make us log per field.
const otaMaxIDLen = 64

var otaOpaqueIDRe = regexp.MustCompile(`^[A-Za-z0-9._:-]*$`)

// otaOpaqueID returns v trimmed when it is a short token of [A-Za-z0-9._:-], else "". Public,
// unauthenticated input: anything with spaces, control characters or an oversized value is
// dropped so it cannot forge or flood log lines.
func otaOpaqueID(v string) string {
	v = strings.TrimSpace(v)
	if len(v) > otaMaxIDLen || !otaOpaqueIDRe.MatchString(v) {
		return ""
	}
	return v
}

// logOtaCheck is the OTA adoption trail: which install (device_id) / outlet (custom_id) asked
// for what, and whether a bundle was offered. Opaque ids only: no IP, headers or customer data.
func logOtaCheck(platform, versionName, versionBuild string, versionCode int, deviceID, customID string, offered bool) {
	slog.Info("ota check", "platform", otaOpaqueID(platform), "version_name", versionName, "version_build", versionBuild,
		"version_code", versionCode, "device_id", deviceID, "custom_id", customID, "offered", offered)
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
		writeErr(w, r, http.StatusBadRequest, err)
		return
	}
	uid, _ := r.Context().Value(auth.CtxUserID).(string)
	id, err := h.Write.PublishOtaRelease(r.Context(), in, uid)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}
