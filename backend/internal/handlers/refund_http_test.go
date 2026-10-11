package handlers

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// The direct refund route maps the shared refund errors to the same outcomes the
// batch classifier uses, and never shows raw database text.
func TestRefundHTTPError(t *testing.T) {
	rawPg := &pgconn.PgError{Code: "22P02", Message: `invalid input syntax for type uuid: "abc"`}
	for _, tc := range []struct {
		name       string
		err        error
		wantStatus int
		wantMsg    string // "" = must be the generic server text
	}{
		{"reason required", service.ErrRefundReasonRequired, http.StatusBadRequest, service.ErrRefundReasonRequired.Error()},
		{"reason too long", service.ErrRefundReasonTooLong, http.StatusBadRequest, service.ErrRefundReasonTooLong.Error()},
		{"order id invalid", service.ErrRefundOrderInvalid, http.StatusBadRequest, service.ErrRefundOrderInvalid.Error()},
		{"already refunded", service.ErrAlreadyRefunded, http.StatusConflict, service.ErrAlreadyRefunded.Error()},
		{"not refundable", service.ErrOrderNotRefundable, http.StatusConflict, service.ErrOrderNotRefundable.Error()},
		{"order missing", service.ErrOrderClosed, http.StatusConflict, service.ErrOrderClosed.Error()},
		{"busy", write.ErrBusy, http.StatusConflict, write.ErrBusy.Error()},
		{"forbidden", apperr.New(apperr.Forbidden, "tidak diizinkan"), http.StatusForbidden, "tidak diizinkan"},
		{"raw database error", rawPg, http.StatusInternalServerError, ""},
		{"wrapped raw error", errors.New("load points for refund: " + rawPg.Message), http.StatusInternalServerError, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, msg := refundHTTPError(tc.err)
			if status != tc.wantStatus {
				t.Fatalf("status=%d want %d", status, tc.wantStatus)
			}
			if tc.wantMsg != "" && msg != tc.wantMsg {
				t.Fatalf("msg=%q want %q", msg, tc.wantMsg)
			}
			if tc.wantMsg == "" && (msg == "" || strings.Contains(msg, "uuid") || strings.Contains(msg, "points")) {
				t.Fatalf("raw text leaked or empty: %q", msg)
			}
		})
	}
}
