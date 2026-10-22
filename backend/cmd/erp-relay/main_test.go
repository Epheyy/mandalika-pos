package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/integration/erp"
)

type fakeRelayer struct {
	retried  string
	retryErr error
	report   erp.RunReport
	runErr   error
}

func (f *fakeRelayer) Retry(_ context.Context, id string) (erp.OutboxItem, error) {
	f.retried = id
	return erp.OutboxItem{ID: id, Kind: "sale", RefNumber: "INV-1"}, f.retryErr
}

func (f *fakeRelayer) Run(context.Context) (erp.RunReport, error) { return f.report, f.runErr }

func setup(t *testing.T, f *fakeRelayer, connErr error, env map[string]string) {
	t.Helper()
	for _, k := range []string{"ERP_RELAY_ENABLED", "ERP_BASE_URL", "ERP_API_KEY", "ERP_SCHEDULER_TOKEN", "ERP_BRAND", "ERP_RELAY_MAX_ATTEMPTS", "ENV"} {
		t.Setenv(k, env[k])
	}
	old := connect
	connect = func(context.Context, string, config.ERPRelay) (relayer, func(), error) {
		if connErr != nil {
			return nil, nil, connErr
		}
		return f, func() {}, nil
	}
	t.Cleanup(func() { connect = old })
}

func runCmd(args []string, dsn string) (int, string, string) {
	var out, errb bytes.Buffer
	getenv := func(k string) string {
		if k == "DATABASE_URL" {
			return dsn
		}
		return os.Getenv(k)
	}
	code := run(context.Background(), args, getenv, &out, &errb)
	return code, out.String(), errb.String()
}

func TestRunPrintsReportAsJSON(t *testing.T) {
	f := &fakeRelayer{report: erp.RunReport{Claimed: 3, Delivered: 2, Dead: 1, Stopped: "budget"}}
	setup(t, f, nil, nil)
	code, out, _ := runCmd(nil, "postgres://x")
	if code != exitOK {
		t.Fatalf("exit %d", code)
	}
	for _, want := range []string{`"claimed": 3`, `"delivered": 2`, `"dead": 1`, `"stopped": "budget"`, `"disabled": false`} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %s:\n%s", want, out)
		}
	}
}

func TestRunDisabledPrintsDisabledAndExitsZero(t *testing.T) {
	setup(t, &fakeRelayer{report: erp.RunReport{Disabled: true}}, nil, nil)
	code, out, _ := runCmd(nil, "postgres://x")
	if code != exitOK || !strings.Contains(out, `"disabled": true`) {
		t.Fatalf("exit %d out=%s", code, out)
	}
}

func TestRunRetryRequeuesFirst(t *testing.T) {
	f := &fakeRelayer{}
	setup(t, f, nil, nil)
	code, out, _ := runCmd([]string{"-retry", "abc"}, "postgres://x")
	if code != exitOK || f.retried != "abc" || !strings.Contains(out, "re-queued abc") {
		t.Fatalf("exit %d retried=%q out=%s", code, f.retried, out)
	}
}

func TestRunFailures(t *testing.T) {
	t.Run("retry error", func(t *testing.T) {
		setup(t, &fakeRelayer{retryErr: erp.ErrNotRetryable}, nil, nil)
		if code, _, _ := runCmd([]string{"-retry", "abc"}, "postgres://x"); code != exitFailed {
			t.Fatalf("exit %d", code)
		}
	})
	t.Run("run error", func(t *testing.T) {
		setup(t, &fakeRelayer{runErr: errors.New("boom")}, nil, nil)
		if code, _, _ := runCmd(nil, "postgres://x"); code != exitFailed {
			t.Fatalf("exit %d", code)
		}
	})
}

func TestRunUsageErrors(t *testing.T) {
	setup(t, &fakeRelayer{}, nil, nil)
	if code, _, _ := runCmd(nil, ""); code != exitUsage {
		t.Errorf("no DSN: exit %d", code)
	}
	if code, _, _ := runCmd([]string{"extra"}, "postgres://x"); code != exitUsage {
		t.Errorf("positional arg: exit %d", code)
	}
	if code, _, _ := runCmd([]string{"-timeout", "0s"}, "postgres://x"); code != exitUsage {
		t.Errorf("zero timeout: exit %d", code)
	}
	if code, _, _ := runCmd([]string{"-bogus"}, "postgres://x"); code != exitUsage {
		t.Errorf("bad flag: exit %d", code)
	}
}

func TestRunInvalidConfigExits2WithoutSecrets(t *testing.T) {
	setup(t, &fakeRelayer{}, nil, map[string]string{"ERP_RELAY_ENABLED": "true", "ERP_BASE_URL": "https://x/y", "ERP_API_KEY": ""})
	code, _, errOut := runCmd(nil, "postgres://x")
	if code != exitUsage || !strings.Contains(errOut, "ERP_API_KEY") {
		t.Fatalf("exit %d err=%s", code, errOut)
	}
}

func TestRunConnectFailureDoesNotEchoError(t *testing.T) {
	setup(t, nil, errors.New("password=hunter2"), nil)
	code, _, errOut := runCmd(nil, "postgres://x")
	if code != exitUsage || strings.Contains(errOut, "hunter2") {
		t.Fatalf("exit %d err=%s", code, errOut)
	}
}

func TestRunProductionRequiresHTTPS(t *testing.T) {
	f := &fakeRelayer{}
	setup(t, f, nil, map[string]string{"ERP_RELAY_ENABLED": "true", "ERP_BASE_URL": "http://erp.example.com/v1", "ERP_API_KEY": "k", "ENV": "production"})
	if code, _, _ := runCmd(nil, "postgres://x"); code != exitUsage {
		t.Fatalf("exit %d want %d", code, exitUsage)
	}
}

func TestRunIgnoresSchedulerToken(t *testing.T) {
	setup(t, &fakeRelayer{}, nil, map[string]string{"ERP_SCHEDULER_TOKEN": "short"})
	if code, _, _ := runCmd(nil, "postgres://x"); code != exitOK {
		t.Fatalf("exit %d want %d", code, exitOK)
	}
}
