package ota

import (
	"encoding/json"
	"testing"
)

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
		{"two-part device version equal to release no update", rel, "1.2", "", "1.2.0"},
		{"two-part older device version gets update", rel, "1.1", "https://x/1.2.0.zip", "1.2.0"},
		{"two-part newer device version no update", rel, "1.3", "", "1.2.0"},
		{"four-part device version no update", rel, "1.1.0.0", "", "1.2.0"},
		{"underscore garbage no update", rel, "__none__", "", "1.2.0"},
		{"letters no update", rel, "abc", "", "1.2.0"},
		{"negative part no update", rel, "1.-2.0", "", "1.2.0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Decide(tt.latest, tt.reqVersion, "")
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
		{"builtin is offered a prerelease latest (release rule: bundles come from the newest APK)", "1.2.0-rc.1", "builtin", true},
		{"larger prerelease set is newer", "1.2.0-beta.1.1", "1.2.0-beta.1", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rel := &Release{Platform: "android", Version: tt.latest, URL: "https://x/b.zip", Checksum: "abc"}
			got := Decide(rel, tt.device, "")
			if (got.URL != "") != tt.wantURL {
				t.Errorf("offered=%v want %v (resp %+v)", got.URL != "", tt.wantURL, got)
			}
		})
	}
}

func TestParseVersionCode(t *testing.T) {
	tests := []struct {
		name   string
		raw    string // "" means a nil/absent RawMessage
		want   int
		wantOK bool
	}{
		{"string 9", `"9"`, 9, true},
		{"number 9", `9`, 9, true},
		{"padded string", `" 12 "`, 12, true},
		{"max int32", `2147483647`, 2147483647, true},
		{"null", `null`, 0, false},
		{"absent", ``, 0, false},
		{"empty string", `""`, 0, false},
		{"non-numeric string", `"abc"`, 0, false},
		{"fractional string", `"9.5"`, 0, false},
		{"fractional number", `9.5`, 0, false},
		{"zero", `0`, 0, false},
		{"negative", `-3`, 0, false},
		{"huge string", `"99999999999"`, 0, false},
		{"over int32", `2147483648`, 0, false},
		{"exponent number", `9e0`, 0, false}, // not a plain integer literal: fail safe
		{"plus-signed string", `"+9"`, 9, true},
		{"leading-zero string", `"09"`, 9, true},
		{"bool", `true`, 0, false},
		{"object", `{}`, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var raw json.RawMessage
			if tt.raw != "" {
				raw = json.RawMessage(tt.raw)
			}
			got, ok := ParseVersionCode(raw)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("got (%d,%v) want (%d,%v)", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

// Real device body (Capgo 8.50.2, APK 2.1 versionCode 12): the built-in bundle reports
// version_name == version_build == the APK versionName, not "builtin".
func TestDecideBuiltinReportedAsApkVersionName(t *testing.T) {
	rel := &Release{Platform: "android", Version: "2.1.2", URL: "https://x/2.1.2.zip", Checksum: "abc"}
	tests := []struct {
		name         string
		name_, build string
		wantURL      string
	}{
		{"built-in 2.1 build 2.1 offered", "2.1", "2.1", "https://x/2.1.2.zip"},
		{"built-in with three-part apk name offered", "2.1.0", "2.1.0", "https://x/2.1.2.zip"},
		{"installed 2.1.1 offered 2.1.2", "2.1.1", "2.1", "https://x/2.1.2.zip"},
		{"installed 2.1.2 up to date", "2.1.2", "2.1", ""},
		{"installed 2.1.5 newer than latest no update", "2.1.5", "2.1", ""},
		{"literal builtin offered", "builtin", "2.1", "https://x/2.1.2.zip"},
		{"abc/abc fails safe", "abc", "abc", ""},
		{"__none__ fails safe", "__none__", "__none__", ""},
		{"empty name and build no update", "", "", ""},
		{"empty name build set no update", "", "2.1", ""},
		{"name 2.1 build mismatch treated as installed 2.1.0 older still offered", "2.1", "2.0", "https://x/2.1.2.zip"},
		{"build mismatch garbage name no update", "abc", "2.1", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Decide(rel, tt.name_, tt.build)
			if got.URL != tt.wantURL {
				t.Errorf("URL got %q want %q (%+v)", got.URL, tt.wantURL, got)
			}
			if got.Version != "2.1.2" {
				t.Errorf("Version got %q", got.Version)
			}
		})
	}
	if got := Decide(nil, "2.1", "2.1"); got.Message != "no release" || got.URL != "" {
		t.Errorf("no release must stay no release: %+v", got)
	}
}
