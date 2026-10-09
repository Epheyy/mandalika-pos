package write

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestMapBusy(t *testing.T) {
	raw := errors.New("boom")
	for _, tt := range []struct {
		name string
		in   error
		want error
	}{
		{"nil", nil, nil},
		{"deadlock", &pgconn.PgError{Code: "40P01", Message: "deadlock detected"}, ErrBusy},
		{"serialization", &pgconn.PgError{Code: "40001"}, ErrBusy},
		{"lock timeout", &pgconn.PgError{Code: "55P03"}, ErrBusy},
		{"wrapped deadlock", fmt.Errorf("commit: %w", &pgconn.PgError{Code: "40P01"}), ErrBusy},
		{"other pg error passes through", &pgconn.PgError{Code: "23505"}, nil},
		{"domain error passes through", raw, raw},
	} {
		got := mapBusy(tt.in)
		switch {
		case tt.want == nil && tt.in == nil:
			if got != nil {
				t.Fatalf("%s: got %v", tt.name, got)
			}
		case tt.want == nil:
			if got != tt.in {
				t.Fatalf("%s: error must pass through unchanged, got %v", tt.name, got)
			}
		case got != tt.want:
			t.Fatalf("%s: got %v want %v", tt.name, got, tt.want)
		}
	}
	if msg := ErrBusy.Error(); msg == "" {
		t.Fatal("ErrBusy needs a user-facing message")
	}
}

func TestRetryBusy(t *testing.T) {
	deadlock := func() error { return &pgconn.PgError{Code: "40P01"} }
	run := func(failures int, failWith func() error) (int, error) {
		calls := 0
		err := retryBusy(context.Background(), func() error {
			calls++
			if calls <= failures {
				return failWith()
			}
			return nil
		})
		return calls, err
	}
	if calls, err := run(2, deadlock); err != nil || calls != 3 {
		t.Fatalf("two deadlocks then success: calls=%d err=%v", calls, err)
	}
	if calls, err := run(3, deadlock); !errors.Is(err, ErrBusy) || calls != 3 {
		t.Fatalf("three deadlocks: calls=%d err=%v", calls, err)
	}
	domain := errors.New("aksi tidak diizinkan")
	if calls, err := run(1, func() error { return domain }); err != domain || calls != 1 {
		t.Fatalf("domain error must not retry: calls=%d err=%v", calls, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := retryBusy(ctx, deadlock); !errors.Is(err, ErrBusy) {
		t.Fatalf("cancelled context: %v", err)
	}
}
