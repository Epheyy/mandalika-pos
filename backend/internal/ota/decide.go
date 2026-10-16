// Package ota implements the self-hosted Capgo update-check decision (pure,
// DB-free) and the release types shared by the read/write repos + handlers.
package ota

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

type Release struct {
	Platform string `json:"platform"`
	Version  string `json:"version"`
	URL      string `json:"url"`
	Checksum string `json:"checksum"`
	Size     int64  `json:"size"`
	// NativeVersionCode is the Android versionCode of the one APK build this
	// bundle targets; /ota/check only offers it to devices on that build.
	NativeVersionCode int `json:"nativeVersionCode"`
	// CommitSHA binds the release to the tested commit it was built from (A34);
	// recorded at publish, never returned by the public /ota/check.
	CommitSHA string `json:"commitSha"`
}

// ParseVersionCode reads the Capgo plugin's version_code, sent as a JSON string
// ("9") or number (9). It returns (n, true) only for an integer 1..MaxInt32;
// anything else (absent, null, empty, non-numeric, fractional, <=0, huge) is
// (0, false) so the caller fails safe to "no release".
func ParseVersionCode(raw json.RawMessage) (int, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return 0, false
	}
	var s string
	if raw[0] == '"' {
		if err := json.Unmarshal(raw, &s); err != nil {
			return 0, false
		}
	} else {
		s = string(raw)
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n < 1 || n > math.MaxInt32 {
		return 0, false
	}
	return int(n), true
}

// CheckResponse is the BARE JSON body returned to the Capgo plugin (no {data}
// envelope). Update → {version,url,checksum}; no-update → {version,message}.
type CheckResponse struct {
	Version  string `json:"version,omitempty"`
	URL      string `json:"url,omitempty"`
	Checksum string `json:"checksum,omitempty"`
	Message  string `json:"message,omitempty"`
}

// builtinVersion is the literal some plugin versions report while the device still runs the
// bundle shipped inside the APK. Capgo 8.50.2 instead reports the APK's own versionName in
// BOTH version_name and version_build (e.g. "2.1"/"2.1"), so isBuiltin accepts either shape.
const builtinVersion = "builtin"

// isBuiltin reports whether the device runs the APK's baked-in bundle: the literal "builtin",
// or version_name equal to a non-empty version_build that itself parses as a version (so
// garbage echoed in both fields, e.g. "abc"/"abc", still fails safe to "no update").
func isBuiltin(reqVersionName, reqVersionBuild string) bool {
	if reqVersionName == builtinVersion {
		return true
	}
	if reqVersionName == "" || reqVersionName != reqVersionBuild {
		return false
	}
	_, ok := parseDeviceVersion(reqVersionName)
	return ok
}

// Decide returns the Capgo response for a check. latest==nil: no release.
// An update (url set) is offered only when the release is strictly newer
// semver than the device's current version; equal, older, or unparseable
// versions on either side never get an update. A built-in bundle (see isBuiltin)
// always counts as older than any parseable release.
func Decide(latest *Release, reqVersionName, reqVersionBuild string) CheckResponse {
	if latest == nil {
		return CheckResponse{Message: "no release"}
	}
	if reqVersionName == latest.Version {
		return CheckResponse{Version: latest.Version, Message: "up-to-date"}
	}
	rel, ok := parseSemver(latest.Version)
	if !ok {
		return CheckResponse{Version: latest.Version, Message: "no update"}
	}
	if !isBuiltin(reqVersionName, reqVersionBuild) {
		dev, ok := parseDeviceVersion(reqVersionName)
		if !ok || compareSemver(rel, dev) <= 0 {
			return CheckResponse{Version: latest.Version, Message: "no update"}
		}
	}
	return CheckResponse{Version: latest.Version, URL: latest.URL, Checksum: latest.Checksum}
}

// parseDeviceVersion is parseSemver plus the one leniency a plain APK versionName needs: a
// 2-part MAJOR.MINOR ("2.1") compares as MAJOR.MINOR.0. Release versions stay strict.
func parseDeviceVersion(v string) (semver, bool) {
	if out, ok := parseSemver(v); ok {
		return out, true
	}
	v = strings.TrimSpace(v)
	if strings.ContainsAny(v, "-+") || strings.Count(v, ".") != 1 {
		return semver{}, false
	}
	return parseSemver(v + ".0")
}

type semver struct {
	core [3]uint64
	pre  []string // empty = a release, which outranks any pre-release of the same core
}

// parseSemver accepts MAJOR.MINOR.PATCH with an optional leading "v",
// "-prerelease" and "+build" (ignored). Anything else is unparseable.
func parseSemver(v string) (semver, bool) {
	var out semver
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i]
	}
	if i := strings.IndexByte(v, '-'); i >= 0 {
		pre := v[i+1:]
		v = v[:i]
		if pre == "" {
			return out, false
		}
		out.pre = strings.Split(pre, ".")
		for _, id := range out.pre {
			if id == "" {
				return out, false
			}
		}
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return out, false
		}
		out.core[i] = n
	}
	return out, true
}

func compareSemver(a, b semver) int {
	for i := range a.core {
		if a.core[i] != b.core[i] {
			if a.core[i] < b.core[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return 0
	case len(a.pre) == 0:
		return 1
	case len(b.pre) == 0:
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		if c := comparePreID(a.pre[i], b.pre[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(a.pre) < len(b.pre):
		return -1
	case len(a.pre) > len(b.pre):
		return 1
	}
	return 0
}

func comparePreID(a, b string) int {
	an, aErr := strconv.ParseUint(a, 10, 64)
	bn, bErr := strconv.ParseUint(b, 10, 64)
	switch {
	case aErr == nil && bErr == nil:
		if an < bn {
			return -1
		}
		if an > bn {
			return 1
		}
		return 0
	case aErr == nil:
		return -1 // numeric ids rank below alphanumeric ones
	case bErr == nil:
		return 1
	}
	return strings.Compare(a, b)
}
