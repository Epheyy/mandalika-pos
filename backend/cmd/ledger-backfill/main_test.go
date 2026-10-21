package main

import (
	"bytes"
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/ledger"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func fakeConnect() func() {
	old := connect
	connect = func(context.Context, string) (ledger.TxBeginner, string, func(), error) {
		return nil, "db.example/pos", func() {}, nil
	}
	return func() { connect = old }
}

func TestRunRefusesWithoutDatabaseURL(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run(context.Background(), nil, env(nil), &out, &errb); code != exitUsage {
		t.Fatalf("code = %d", code)
	}
	if !strings.Contains(errb.String(), "DATABASE_URL") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestRunRejectsBadFlags(t *testing.T) {
	for _, args := range [][]string{{"-nope"}, {"extra"}, {"-timeout", "0s"}} {
		var out, errb bytes.Buffer
		if code := run(context.Background(), args, env(map[string]string{"DATABASE_URL": "x"}), &out, &errb); code != exitUsage {
			t.Fatalf("%v: code = %d", args, code)
		}
	}
}

func TestNewRunIDFormat(t *testing.T) {
	a, err := newRunID(time.Date(2026, 10, 22, 1, 2, 3, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^bf-20261022T010203Z-[0-9a-f]{6}$`).MatchString(a) {
		t.Fatalf("run id = %q", a)
	}
	if b, _ := newRunID(time.Now()); b == a {
		t.Fatal("run ids must differ")
	}
}

func TestRunPassesFlagsAndPrintsTargetWithoutSecrets(t *testing.T) {
	defer fakeConnect()()
	var got ledger.BackfillOptions
	old := runBackfill
	defer func() { runBackfill = old }()
	runBackfill = func(_ context.Context, _ ledger.TxBeginner, o ledger.BackfillOptions) (ledger.BackfillReport, []ledger.Violation, error) {
		got = o
		return ledger.BackfillReport{WouldInsert: 3}, []ledger.Violation{{LocationType: "outlet", LocationID: "o1"}}, nil
	}
	var out, errb bytes.Buffer
	code := run(context.Background(), []string{"-dry-run", "-reanchor", "-run-id", "r1"}, env(map[string]string{"DATABASE_URL": "postgres://u:s3cret@h/db"}), &out, &errb)
	if code != exitOK || !got.DryRun || !got.Reanchor || got.RunID != "r1" {
		t.Fatalf("code=%d opts=%+v err=%s", code, got, errb.String())
	}
	if s := out.String(); strings.Contains(s, "s3cret") || !strings.Contains(s, "target=db.example/pos") || !strings.Contains(s, "would insert 3") {
		t.Fatalf("stdout = %q", s)
	}
}

func TestRunGeneratesRunIDWhenOmitted(t *testing.T) {
	defer fakeConnect()()
	var got ledger.BackfillOptions
	old := runBackfill
	defer func() { runBackfill = old }()
	runBackfill = func(_ context.Context, _ ledger.TxBeginner, o ledger.BackfillOptions) (ledger.BackfillReport, []ledger.Violation, error) {
		got = o
		return ledger.BackfillReport{}, nil, nil
	}
	var out, errb bytes.Buffer
	if code := run(context.Background(), nil, env(map[string]string{"DATABASE_URL": "x"}), &out, &errb); code != exitOK {
		t.Fatalf("code=%d err=%s", code, errb.String())
	}
	if !strings.HasPrefix(got.RunID, "bf-") || !strings.Contains(out.String(), got.RunID) {
		t.Fatalf("run id %q not generated/printed: %q", got.RunID, out.String())
	}
}

func TestRunExitCodes(t *testing.T) {
	defer fakeConnect()()
	old := runBackfill
	defer func() { runBackfill = old }()
	many := make([]ledger.Violation, 25)
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"invariant", ledger.ErrInvariantViolated, "invariant violated"},
		{"lock", &pgconn.PgError{Code: "55P03"}, "re-run; writers held the stock tables"},
		{"other", errors.New("boom"), "boom"},
	}
	for _, c := range cases {
		runBackfill = func(context.Context, ledger.TxBeginner, ledger.BackfillOptions) (ledger.BackfillReport, []ledger.Violation, error) {
			return ledger.BackfillReport{}, many, c.err
		}
		var out, errb bytes.Buffer
		code := run(context.Background(), nil, env(map[string]string{"DATABASE_URL": "x"}), &out, &errb)
		if code != exitFailed || !strings.Contains(errb.String(), c.want) {
			t.Fatalf("%s: code=%d stderr=%q", c.name, code, errb.String())
		}
		if c.name == "invariant" && !strings.Contains(out.String(), "and 5 more") {
			t.Fatalf("violations must be capped at 20: %q", out.String())
		}
	}
}
