package service

import (
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/apperr"
)

const refundTestOrderID = "00000000-0000-4000-8f01-000000000001"

func TestNormalizeRefund(t *testing.T) {
	for _, tc := range []struct {
		name, orderID, reason string
		want                  string
		wantErr               error
	}{
		{"plain", refundTestOrderID, "rusak", "rusak", nil},
		{"trimmed", refundTestOrderID, "  \trusak\n ", "rusak", nil},
		{"inner spaces kept", refundTestOrderID, " salah  ukuran ", "salah  ukuran", nil},
		{"empty", refundTestOrderID, "", "", ErrRefundReasonRequired},
		{"whitespace only", refundTestOrderID, " \t\n ", "", ErrRefundReasonRequired},
		{"exactly 500 ascii", refundTestOrderID, strings.Repeat("a", MaxRefundReasonRunes), strings.Repeat("a", MaxRefundReasonRunes), nil},
		{"exactly 500 multibyte", refundTestOrderID, strings.Repeat("é", MaxRefundReasonRunes), strings.Repeat("é", MaxRefundReasonRunes), nil},
		{"501 multibyte", refundTestOrderID, strings.Repeat("é", MaxRefundReasonRunes+1), "", ErrRefundReasonTooLong},
		{"padding does not count toward the cap", refundTestOrderID, "  " + strings.Repeat("a", MaxRefundReasonRunes) + "  ", strings.Repeat("a", MaxRefundReasonRunes), nil},
		{"order id not a uuid", "abc", "rusak", "", ErrRefundOrderInvalid},
		{"order id empty", "", "rusak", "", ErrRefundOrderInvalid},
		{"order id checked before reason", "abc", "", "", ErrRefundOrderInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeRefund(tc.orderID, tc.reason)
			if err != tc.wantErr {
				t.Fatalf("err=%v want %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Fatalf("reason=%q want %q", got, tc.want)
			}
		})
	}
}

// Every refusal is a business rule: Rejected for bad input, Conflict for a bad
// order state. The text is Indonesian, safe to show, and never offers a re-pay.
func TestRefundErrorsAreCodedAndWarnAgainstRepaying(t *testing.T) {
	for _, tc := range []struct {
		err  *apperr.Error
		code apperr.Code
	}{
		{ErrRefundOrderInvalid, apperr.Rejected},
		{ErrRefundReasonRequired, apperr.Rejected},
		{ErrRefundReasonTooLong, apperr.Rejected},
		{ErrAlreadyRefunded, apperr.Conflict},
		{ErrOrderNotRefundable, apperr.Conflict},
	} {
		if got := tc.err.ErrorCode(); got != tc.code {
			t.Errorf("%q: code=%s want %s", tc.err, got, tc.code)
		}
		if !strings.Contains(tc.err.Error(), "Jika uang sudah dikembalikan, jangan bayar ulang.") {
			t.Errorf("%q: missing the do-not-repay warning", tc.err)
		}
	}
	// shift.go shares ErrOrderClosed; it must keep its code and text.
	if ErrOrderClosed.ErrorCode() != apperr.Conflict || ErrOrderClosed.Error() != "order not refundable" {
		t.Fatalf("ErrOrderClosed changed: %v", ErrOrderClosed)
	}
}
