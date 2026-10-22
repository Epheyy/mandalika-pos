package config

import (
	"strings"
	"testing"
)

func setERPEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for _, k := range []string{"ERP_RELAY_ENABLED", "ERP_BASE_URL", "ERP_API_KEY", "ERP_SCHEDULER_TOKEN", "ERP_BRAND", "ERP_RELAY_MAX_ATTEMPTS"} {
		t.Setenv(k, kv[k])
	}
}

func TestLoadERPRelayDefaults(t *testing.T) {
	setERPEnv(t, nil)
	e := LoadERPRelay()
	if e.Enabled || e.Brand != "mandalika" || e.MaxAttempts != 10 {
		t.Fatalf("defaults: %+v", e)
	}
	if err := e.Validate(false); err != nil {
		t.Fatalf("disabled default must validate: %v", err)
	}
}

func TestLoadERPRelayEnabledFlag(t *testing.T) {
	for v, want := range map[string]bool{"true": true, "1": true, "TRUE": true, "yes": false, "0": false, "": false} {
		setERPEnv(t, map[string]string{"ERP_RELAY_ENABLED": v})
		if got := LoadERPRelay().Enabled; got != want {
			t.Errorf("ERP_RELAY_ENABLED=%q: %v want %v", v, got, want)
		}
	}
}

func TestERPRelayValidate(t *testing.T) {
	good := map[string]string{
		"ERP_RELAY_ENABLED": "true", "ERP_BASE_URL": "https://erp.example.com/api/integration/v1", "ERP_API_KEY": "k",
	}
	with := func(over map[string]string) map[string]string {
		m := map[string]string{}
		for k, v := range good {
			m[k] = v
		}
		for k, v := range over {
			m[k] = v
		}
		return m
	}
	for _, tc := range []struct {
		name string
		env  map[string]string
		bad  bool
	}{
		{"good", good, false},
		{"relative url", with(map[string]string{"ERP_BASE_URL": "/api"}), true},
		{"ftp url", with(map[string]string{"ERP_BASE_URL": "ftp://x/y"}), true},
		{"no host", with(map[string]string{"ERP_BASE_URL": "https:///x"}), true},
		{"query", with(map[string]string{"ERP_BASE_URL": "https://x/y?a=b"}), true},
		{"no key", with(map[string]string{"ERP_API_KEY": ""}), true},
		{"brand upper", with(map[string]string{"ERP_BRAND": "Flam"}), true},
		{"brand ok", with(map[string]string{"ERP_BRAND": "performance-perfume"}), false},
		{"brand too long", with(map[string]string{"ERP_BRAND": strings.Repeat("a", 41)}), true},
		{"short token", with(map[string]string{"ERP_SCHEDULER_TOKEN": "short"}), true},
		{"long token", with(map[string]string{"ERP_SCHEDULER_TOKEN": strings.Repeat("s", 32)}), false},
		{"attempts nan", with(map[string]string{"ERP_RELAY_MAX_ATTEMPTS": "x"}), true},
		{"attempts zero", with(map[string]string{"ERP_RELAY_MAX_ATTEMPTS": "0"}), true},
		{"attempts 101", with(map[string]string{"ERP_RELAY_MAX_ATTEMPTS": "101"}), true},
		{"attempts 100", with(map[string]string{"ERP_RELAY_MAX_ATTEMPTS": "100"}), false},
		{"disabled ignores url", map[string]string{"ERP_BASE_URL": "junk"}, false},
		{"disabled still checks token", map[string]string{"ERP_SCHEDULER_TOKEN": "short"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setERPEnv(t, tc.env)
			err := LoadERPRelay().Validate(false)
			if (err != nil) != tc.bad {
				t.Fatalf("err=%v want bad=%v", err, tc.bad)
			}
		})
	}
}

func TestERPRelayValidateNeverLeaksValues(t *testing.T) {
	setERPEnv(t, map[string]string{"ERP_RELAY_ENABLED": "1", "ERP_BASE_URL": "https://x/y?secret=SEKRET", "ERP_API_KEY": "KEYVAL"})
	err := LoadERPRelay().Validate(false)
	if err == nil || strings.Contains(err.Error(), "SEKRET") || strings.Contains(err.Error(), "KEYVAL") {
		t.Fatalf("error leaks a value: %v", err)
	}
}

func TestERPRelayTrimsWhitespace(t *testing.T) {
	setERPEnv(t, map[string]string{
		"ERP_RELAY_ENABLED": "true", "ERP_BASE_URL": " https://erp.example.com/v1\n",
		"ERP_API_KEY": "key\n", "ERP_SCHEDULER_TOKEN": strings.Repeat("s", 32) + "\r\n",
	})
	e := LoadERPRelay()
	if e.APIKey != "key" || e.SchedulerToken != strings.Repeat("s", 32) || e.BaseURL != "https://erp.example.com/v1" {
		t.Fatalf("not trimmed: %+v", e)
	}
	if err := e.Validate(true); err != nil {
		t.Fatalf("trimmed config must validate: %v", err)
	}
}

func TestERPRelayRejectsEmbeddedSpaceOrControl(t *testing.T) {
	for name, over := range map[string]map[string]string{
		"key space":     {"ERP_API_KEY": "ab cd"},
		"key control":   {"ERP_API_KEY": "ab\x01cd"},
		"key inner nl":  {"ERP_API_KEY": "ab\ncd"},
		"token space":   {"ERP_SCHEDULER_TOKEN": strings.Repeat("s", 16) + " " + strings.Repeat("s", 16)},
		"token control": {"ERP_SCHEDULER_TOKEN": strings.Repeat("s", 16) + "\t" + strings.Repeat("s", 16)},
	} {
		env := map[string]string{"ERP_RELAY_ENABLED": "true", "ERP_BASE_URL": "https://x/y", "ERP_API_KEY": "k"}
		for k, v := range over {
			env[k] = v
		}
		setERPEnv(t, env)
		if err := LoadERPRelay().Validate(false); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestERPRelayValidateBaseURLModes(t *testing.T) {
	for _, tc := range []struct {
		url      string
		prod, ok bool
	}{
		{"https://erp.example.com/v1", true, true},
		{"http://erp.example.com/v1", true, false},
		{"http://erp.example.com/v1", false, true},
		{"http://localhost:8080/v1", true, true},
		{"http://127.0.0.1:8080/v1", true, true},
		{"http://[::1]:8080/v1", true, true},
		{"https://user:pw@erp.example.com/v1", false, false},
		{"https://user@erp.example.com/v1", true, false},
		{"http://localhost.evil.com/v1", true, false},
	} {
		setERPEnv(t, map[string]string{"ERP_RELAY_ENABLED": "true", "ERP_BASE_URL": tc.url, "ERP_API_KEY": "k"})
		err := LoadERPRelay().Validate(tc.prod)
		if (err == nil) != tc.ok {
			t.Errorf("%s prod=%v: err=%v want ok=%v", tc.url, tc.prod, err, tc.ok)
		}
		if err != nil && strings.Contains(err.Error(), "pw@") {
			t.Errorf("error leaks credentials: %v", err)
		}
	}
}
