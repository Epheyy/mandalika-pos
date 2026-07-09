// Package ota implements the self-hosted Capgo update-check decision (pure,
// DB-free) and the release types shared by the read/write repos + handlers.
package ota

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

// Decide returns the Capgo response for a check. latest==nil → no release;
// req version == latest → up-to-date (no url); otherwise → download (url set).
func Decide(latest *Release, reqVersionName string) CheckResponse {
	if latest == nil {
		return CheckResponse{Message: "no release"}
	}
	if reqVersionName == latest.Version {
		return CheckResponse{Version: latest.Version, Message: "up-to-date"}
	}
	return CheckResponse{Version: latest.Version, URL: latest.URL, Checksum: latest.Checksum}
}
