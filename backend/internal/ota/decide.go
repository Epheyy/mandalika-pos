// Package ota implements the self-hosted Capgo update-check decision (pure,
// DB-free) and the release types shared by the read/write repos + handlers.
package ota

import (
	"strconv"
	"strings"
)

type Release struct {
	Platform string `json:"platform"`
	Version  string `json:"version"`
	URL      string `json:"url"`
	Checksum string `json:"checksum"`
	Size     int64  `json:"size"`
}

// CheckResponse is the BARE JSON body returned to the Capgo plugin (no {data}
// envelope). Update → {version,url,checksum}; no-update → {version,message}.
type CheckResponse struct {
	Version  string `json:"version,omitempty"`
	URL      string `json:"url,omitempty"`
	Checksum string `json:"checksum,omitempty"`
	Message  string `json:"message,omitempty"`
}

// builtinVersion is what the Capgo plugin reports while the device still runs
// the bundle shipped inside the APK (no OTA bundle installed yet).
const builtinVersion = "builtin"

// Decide returns the Capgo response for a check. latest==nil: no release.
// An update (url set) is offered only when the release is strictly newer
// semver than the device's current version; equal, older, or unparseable
// versions on either side never get an update. "builtin" always counts as
// older than any parseable release.
func Decide(latest *Release, reqVersionName string) CheckResponse {
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
	if reqVersionName != builtinVersion {
		dev, ok := parseSemver(reqVersionName)
		if !ok || compareSemver(rel, dev) <= 0 {
			return CheckResponse{Version: latest.Version, Message: "no update"}
		}
	}
	return CheckResponse{Version: latest.Version, URL: latest.URL, Checksum: latest.Checksum}
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
