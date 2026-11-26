package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

const (
	xoTestOrder = "00000000-0000-4000-8f86-0a0000000001"
	xoTestUUID  = "00000000-0000-4000-8f86-0a0000000002"
	xoTestShift = "00000000-0000-4000-8f86-0a0000000003"
)

func xoValidBody() crossOutletRefundBody {
	return crossOutletRefundBody{ClientRefundUUID: xoTestUUID, DeviceID: "tablet-1", ShiftID: xoTestShift, Reason: "rusak"}
}

func TestCrossRefundInputValidation(t *testing.T) {
	for name, mut := range map[string]func(*crossOutletRefundBody){
		"no uuid":      func(b *crossOutletRefundBody) { b.ClientRefundUUID = "" },
		"bad uuid":     func(b *crossOutletRefundBody) { b.ClientRefundUUID = "abc" },
		"no device":    func(b *crossOutletRefundBody) { b.DeviceID = "" },
		"long device":  func(b *crossOutletRefundBody) { b.DeviceID = strings.Repeat("d", 129) },
		"bad shift":    func(b *crossOutletRefundBody) { b.ShiftID = "x" },
		"empty reason": func(b *crossOutletRefundBody) { b.Reason = "  " },
		"bad code":     func(b *crossOutletRefundBody) { b.ReasonCode = "Bad Code!" },
		"empty items": func(b *crossOutletRefundBody) {
			b.Items = []struct {
				LineNo   int `json:"lineNo"`
				Quantity int `json:"quantity"`
			}{}
		},
		"negative amount": func(b *crossOutletRefundBody) { v := -1.0; b.RefundAmount = &v },
	} {
		b := xoValidBody()
		mut(&b)
		_, err := crossRefundInput(xoTestOrder, b, "outlet", "user", "name")
		if code, ok := apperr.CodeOf(err); !ok || code != apperr.Rejected {
			t.Errorf("%s: want a Rejected refusal, got %v", name, err)
		}
	}
	in, err := crossRefundInput(xoTestOrder, xoValidBody(), "outlet-y", "u1", "Kasir")
	if err != nil || in.OutletID != "outlet-y" || in.SaleOutletID != "" || in.ShiftID != xoTestShift || in.DeviceID != "tablet-1" {
		t.Fatalf("valid input: %+v %v", in, err)
	}
	if _, err := crossRefundInput("nope", xoValidBody(), "o", "u", "n"); !errors.Is(err, service.ErrRefundOrderInvalid) {
		t.Fatalf("bad order id: %v", err)
	}
}

func TestCrossRefundHTTPError(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		retry  bool
	}{
		{"rejected", service.ErrCrossRefundKeyRequired, 400, false},
		{"conflict", service.ErrCrossRefundShift, 409, false},
		{"same outlet", service.ErrCrossRefundSameOutlet, 409, false},
		{"forbidden", apperr.New(apperr.Forbidden, "x"), 403, false},
		{"busy", write.ErrBusy, 503, true},
		{"busy wrapped", fmt.Errorf("w: %w", apperr.Wrap(apperr.Busy, write.ErrBusy)), 503, true},
		{"deadlock", &pgconn.PgError{Code: "40P01"}, 503, true},
		{"unknown", errors.New("boom"), 500, true},
	} {
		status, msg, retry := crossRefundHTTPError(tc.err)
		if status != tc.status || retry != tc.retry || msg == "" {
			t.Errorf("%s: got %d %q retry=%v", tc.name, status, msg, retry)
		}
	}
	if status, msg, _ := crossRefundHTTPError(errors.New("pq: secret")); status != http.StatusInternalServerError || strings.Contains(msg, "secret") {
		t.Errorf("unknown errors must be sanitised: %d %q", status, msg)
	}
}
