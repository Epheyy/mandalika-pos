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
		{"older patch gets update", rel, "1.1.9", "https://x/1.2.0.zip", "1.2.0"},
		{"older minor gets update", rel, "1.0.5", "https://x/1.2.0.zip", "1.2.0"},
		{"older major gets update", rel, "0.9.9", "https://x/1.2.0.zip", "1.2.0"},
		{"newer patch on device no update", rel, "1.2.1", "", "1.2.0"},
		{"newer minor on device no update", rel, "1.3.0", "", "1.2.0"},
		{"newer major on device no update", rel, "2.0.0", "", "1.2.0"},
		{"numeric not lexical compare", rel, "1.10.0", "", "1.2.0"},
		{"v prefix equal no update", rel, "v1.2.0", "", "1.2.0"},
		{"build metadata ignored equal", rel, "1.2.0+7", "", "1.2.0"},
		{"device prerelease of same core gets update", rel, "1.2.0-beta.1", "https://x/1.2.0.zip", "1.2.0"},
		{"garbage device version no update", rel, "not-a-version", "", "1.2.0"},
		{"empty device version no update", rel, "", "", "1.2.0"},
		{"two-part device version no update", rel, "1.2", "", "1.2.0"},
		{"negative part no update", rel, "1.-2.0", "", "1.2.0"},
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

func TestDecideLatestVersionShapes(t *testing.T) {
	tests := []struct {
		name    string
		latest  string
		device  string
		wantURL bool
	}{
		{"garbage latest never offered", "garbage", "1.0.0", false},
		{"garbage latest vs builtin", "garbage", "builtin", false},
		{"prerelease latest not newer than same-core release", "1.2.0-rc.1", "1.2.0", false},
		{"prerelease latest newer than older release", "1.2.0-rc.1", "1.1.0", true},
		{"later prerelease id is newer", "1.2.0-beta.2", "1.2.0-beta.1", true},
		{"numeric prerelease ids compare numerically", "1.2.0-beta.10", "1.2.0-beta.9", true},
		{"older prerelease id not offered", "1.2.0-beta.1", "1.2.0-beta.2", false},
		{"larger prerelease set is newer", "1.2.0-beta.1.1", "1.2.0-beta.1", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rel := &Release{Platform: "android", Version: tt.latest, URL: "https://x/b.zip", Checksum: "abc"}
			got := Decide(rel, tt.device)
			if (got.URL != "") != tt.wantURL {
				t.Errorf("offered=%v want %v (resp %+v)", got.URL != "", tt.wantURL, got)
			}
		})
	}
}
