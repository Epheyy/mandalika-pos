package sync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// realScanError is the error pgx returns when a NULL column is scanned into a
// plain string — the shape of the SP-Promo NULL-hour bug (a server bug, not bad data).
func realScanError(t *testing.T) error {
	t.Helper()
	var s string
	err := pgtype.NewMap().Scan(pgtype.TextOID, pgtype.TextFormatCode, nil, &s)
	if err == nil || !strings.Contains(err.Error(), "cannot scan NULL") {
		t.Fatalf("expected a genuine pgx scan error, got %v", err)
	}
	return err
}

// realConnectError dials a closed local port so pgconn builds its own *ConnectError.
func realConnectError(t *testing.T) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := pgconn.Connect(ctx, "host=127.0.0.1 port=1 user=x dbname=x connect_timeout=2 sslmode=disable")
	var ce *pgconn.ConnectError
	if !errors.As(err, &ce) {
		t.Fatalf("expected *pgconn.ConnectError, got %T %v", err, err)
	}
	return err
}

func TestClassifyItemError(t *testing.T) {
	_, shiftErr := service.DecodeOpenShift(bytes.NewReader([]byte("not json")))
	_, closeErr := service.DecodeCloseShift(bytes.NewReader([]byte(`{}`)), true)
	rejection := &service.ErrDiscountRejected{Violations: []service.PromoViolation{service.ViolationRewardInvalid}}

	cases := []struct {
		name      string
		err       error
		code      apperr.Code
		retryable bool
		// wantMsg: "" means the generic internal text; "=err" means err.Error() verbatim.
		wantMsg string
	}{
		{"pgx scan error is a server bug", realScanError(t), apperr.Internal, true, internalMessage},
		{"connection error", realConnectError(t), apperr.Internal, true, internalMessage},
		{"net op error", &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset")}, apperr.Internal, true, internalMessage},
		{"deadline exceeded", fmt.Errorf("begin: %w", context.DeadlineExceeded), apperr.Internal, true, internalMessage},
		{"canceled", context.Canceled, apperr.Internal, true, internalMessage},
		{"invalid text representation", &pgconn.PgError{Code: "22P02", Message: "invalid input syntax for type uuid"}, apperr.Rejected, false, dataRejectedMessage},
		{"unique violation", &pgconn.PgError{Code: "23505", Message: "duplicate key"}, apperr.Rejected, false, dataRejectedMessage},
		{"not-null violation", &pgconn.PgError{Code: "23502"}, apperr.Rejected, false, dataRejectedMessage},
		{"check violation", &pgconn.PgError{Code: "23514"}, apperr.Rejected, false, dataRejectedMessage},
		{"wrapped fk violation is parent-not-synced-yet", fmt.Errorf("insert item: %w", &pgconn.PgError{Code: "23503"}), apperr.Internal, true, internalMessage},
		{"deadlock", &pgconn.PgError{Code: "40P01"}, apperr.Busy, true, write.ErrBusy.Error()},
		{"serialization failure", &pgconn.PgError{Code: "40001"}, apperr.Busy, true, write.ErrBusy.Error()},
		{"lock not available", &pgconn.PgError{Code: "55P03"}, apperr.Busy, true, write.ErrBusy.Error()},
		{"connection exception", &pgconn.PgError{Code: "08006"}, apperr.Internal, true, internalMessage},
		{"too many connections", &pgconn.PgError{Code: "53300"}, apperr.Internal, true, internalMessage},
		{"admin shutdown", &pgconn.PgError{Code: "57P01"}, apperr.Internal, true, internalMessage},
		{"undefined column is a server bug", &pgconn.PgError{Code: "42703", Message: "column x"}, apperr.Internal, true, internalMessage},
		{"write.ErrBusy", write.ErrBusy, apperr.Busy, true, "=err"},
		{"wrapped ErrBusy", fmt.Errorf("receive: %w", write.ErrBusy), apperr.Busy, true, "=err"},
		{"write.ErrNotFound", write.ErrNotFound, apperr.NotFound, false, "=err"},
		{"receipt key conflict", service.ErrReceiptKeyConflict, apperr.KeyConflict, false, "=err"},
		{"order closed", service.ErrOrderClosed, apperr.Conflict, false, "=err"},
		{"shift open", service.ErrShiftOpen, apperr.Conflict, false, "=err"},
		{"no items", service.ErrNoItems, apperr.Rejected, false, "=err"},
		{"decode open shift", shiftErr, apperr.Rejected, false, "=err"},
		{"decode close shift", closeErr, apperr.Rejected, false, "=err"},
		{"discount rejected", rejection, apperr.Rejected, false, "=err"},
		{"wrapped marked error", fmt.Errorf("outer: %w", apperr.New(apperr.Forbidden, "tidak berwenang")), apperr.Forbidden, false, "=err"},
		{"wrap keeps text", apperr.Wrap(apperr.Conflict, errors.New("aksi tidak diizinkan dari status 'cancelled'")), apperr.Conflict, false, "=err"},
		{"plain errors.New is unclassified", errors.New("boom"), apperr.Internal, true, internalMessage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyItemError(tc.err)
			if got.Code != tc.code || got.Retryable != tc.retryable {
				t.Fatalf("code/retryable = %s/%v, want %s/%v (err=%v)", got.Code, got.Retryable, tc.code, tc.retryable, tc.err)
			}
			want := tc.wantMsg
			if want == "=err" {
				want = tc.err.Error()
			}
			if got.Message != want {
				t.Fatalf("message = %q, want %q", got.Message, want)
			}
			if want != tc.err.Error() && !got.Sanitized {
				t.Fatalf("replaced message must be flagged Sanitized so the raw error is logged")
			}
			if strings.Contains(got.Message, "duplicate key") || strings.Contains(got.Message, "cannot scan") {
				t.Fatalf("raw database text leaked: %q", got.Message)
			}
		})
	}
}

func TestApperrWrapKeepsMessageAndChain(t *testing.T) {
	inner := errors.New("original text")
	w := apperr.Wrap(apperr.Rejected, inner)
	if w.Error() != "original text" || !errors.Is(w, inner) {
		t.Fatalf("wrap changed text or chain: %v", w)
	}
	if apperr.Wrap(apperr.Rejected, nil) != nil {
		t.Fatal("Wrap(nil) must stay nil")
	}
}

func TestItemResultWireShape(t *testing.T) {
	e := &Engine{}
	res := e.processOneWithCommands(context.Background(), Caller{OutletID: "o"}, BatchItem{Type: "nonsense", IdempotencyKey: "k"}, nil, nil)
	if res.Status != "error" || res.Code != string(apperr.Rejected) || res.Retryable == nil || *res.Retryable {
		t.Fatalf("unknown type must be a non-retryable rejection with retryable=false present: %+v", res)
	}
}
