package ota

import "testing"

func TestDecide(t *testing.T) {
	rel := &Release{Platform: "android", Version: "1.2.0", URL: "https://x/1.2.0.zip", Checksum: "abc"}
	tests := []struct {
		name       string
		latest     *Release
		reqVersion string
		wantURL    string // "" means no-url (up-to-date / no release)
		wantVer    string
	}{
		{"no release", nil, "builtin", "", ""},
		{"builtin gets update", rel, "builtin", "https://x/1.2.0.zip", "1.2.0"},
		{"older gets update", rel, "1.1.0", "https://x/1.2.0.zip", "1.2.0"},
		{"same version no update", rel, "1.2.0", "", "1.2.0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Decide(tt.latest, tt.reqVersion)
			if got.URL != tt.wantURL {
				t.Errorf("URL got %q want %q", got.URL, tt.wantURL)
			}
			if got.Version != tt.wantVer {
				t.Errorf("Version got %q want %q", got.Version, tt.wantVer)
			}
			if tt.wantURL != "" && got.Checksum != "abc" {
				t.Errorf("expected checksum on update")
			}
		})
	}
}
