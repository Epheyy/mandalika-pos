package handlers

import (
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/phone"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

// A18 cross-outlet returns: the online-only refund of a sale made at another outlet, and the lookup
// that finds such a sale. Both need process_refund (route gate) and an explicit active outlet.

const (
	maxCrossRefundDeviceRunes = 128
	// maxCrossRefundAmountRp mirrors the sync path's bound on a claimed refund amount.
	maxCrossRefundAmountRp = 1e12
	crossRefundRetryAfter  = "2"
	msgNoActiveOutlet      = "Outlet aktif belum dipilih untuk akun ini."
	msgBadActiveOutlet     = "Outlet aktif tidak valid. Pilih outlet dari daftar outlet."
)

type crossOutletRefundBody struct {
	ClientRefundUUID string   `json:"clientRefundUuid"`
	DeviceID         string   `json:"deviceId"`
	ShiftID          string   `json:"shiftId"`
	Reason           string   `json:"reason"`
	ReasonCode       string   `json:"reasonCode"`
	RefundAmount     *float64 `json:"refundAmount"`
	PayoutMethod     *string  `json:"payoutMethod"`
	PayoutPicked     *bool    `json:"payoutPicked"`
	// Items absent = the whole order; a present empty array stays non-nil and is refused.
	Items []struct {
		LineNo   int `json:"lineNo"`
		Quantity int `json:"quantity"`
	} `json:"items"`
}

// crossRefundInput validates the request and builds the service input. Every refusal here happens
// before any SQL and is a 400 (the request itself is wrong). ids are lower-cased like the sync path.
func crossRefundInput(orderID string, b crossOutletRefundBody, outletID, userID, userName string) (service.RefundInput, error) {
	if n := utf8.RuneCountInString(b.DeviceID); n < 1 || n > maxCrossRefundDeviceRunes ||
		!service.IsCanonicalUUID(b.ClientRefundUUID) {
		return service.RefundInput{}, service.ErrCrossRefundKeyRequired
	}
	if !service.IsCanonicalUUID(b.ShiftID) {
		return service.RefundInput{}, apperr.New(apperr.Rejected, "ID shift tidak valid."+refundHTTPWarning)
	}
	if _, err := service.NormalizeRefund(orderID, b.Reason); err != nil {
		return service.RefundInput{}, err
	}
	in := service.RefundInput{
		OutletID: outletID, OrderID: strings.ToLower(orderID), Reason: b.Reason,
		ShiftID: strings.ToLower(b.ShiftID), UserID: userID, UserName: userName,
		ReasonCode: b.ReasonCode, PayoutMethod: b.PayoutMethod, PayoutPicked: b.PayoutPicked,
		DeviceID: b.DeviceID, ClientRefundUUID: strings.ToLower(b.ClientRefundUUID),
	}
	if b.Items != nil {
		in.Items = make([]service.RefundItemInput, 0, len(b.Items))
		for _, it := range b.Items {
			in.Items = append(in.Items, service.RefundItemInput{LineNo: it.LineNo, Quantity: it.Quantity})
		}
	}
	if _, err := service.ValidateRefundExtras(in.Items, in.ReasonCode); err != nil {
		return service.RefundInput{}, err
	}
	if _, err := service.ValidateRefundPayoutMethod(in.PayoutMethod); err != nil {
		return service.RefundInput{}, err
	}
	if b.RefundAmount != nil {
		a := math.Round(*b.RefundAmount)
		if math.IsNaN(a) || a < 0 || a > maxCrossRefundAmountRp {
			return service.RefundInput{}, apperr.New(apperr.Rejected, "Jumlah refund tidak valid."+refundHTTPWarning)
		}
		v := int64(a)
		in.RefundAmount = &v
	}
	return in, nil
}

// refundHTTPWarning repeats the service warning for handler-side refusals (never a second payout).
const refundHTTPWarning = " Data tetap tersimpan. Jika uang sudah dikembalikan, jangan bayar ulang."

// crossRefundHTTPError maps an error to (status, message, retryable). Unlike refundHTTPError a lock
// conflict is a 503 + Retry-After: the tablet keeps its attempt and resends the same uuid; every
// 400/403/409 is a refusal the tablet clears.
func crossRefundHTTPError(err error) (status int, msg string, retry bool) {
	if errors.Is(err, write.ErrBusy) {
		return http.StatusServiceUnavailable, write.ErrBusy.Error(), true
	}
	if code, ok := apperr.CodeOf(err); ok {
		switch code {
		case apperr.Rejected:
			return http.StatusBadRequest, err.Error(), false
		case apperr.Forbidden:
			return http.StatusForbidden, err.Error(), false
		case apperr.Conflict:
			return http.StatusConflict, err.Error(), false
		case apperr.Busy:
			return http.StatusServiceUnavailable, write.ErrBusy.Error(), true
		}
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "40P01", "40001", "55P03":
			return http.StatusServiceUnavailable, write.ErrBusy.Error(), true
		}
	}
	return http.StatusInternalServerError, "Terjadi kesalahan server, silakan coba lagi", true
}

// RefundCrossOutlet is POST /orders/{id}/cross-outlet-refund.
func (h *Handlers) RefundCrossOutlet(w http.ResponseWriter, r *http.Request) {
	var body crossOutletRefundBody
	if err := httpx.DecodeLoose(r, &body); err != nil {
		if isBodyTooLarge(err) {
			writeDecodeErr(w, err)
			return
		}
		httpx.Err(w, http.StatusBadRequest, "Isi permintaan refund tidak valid.")
		return
	}
	id := chi.URLParam(r, "id")
	fail := func(err error) {
		status, msg, retry := crossRefundHTTPError(err)
		if status >= http.StatusInternalServerError {
			slog.Error("cross-outlet refund failed", "orderId", id, "err", err)
		}
		if retry && status == http.StatusServiceUnavailable {
			w.Header().Set("Retry-After", crossRefundRetryAfter)
		}
		httpx.Err(w, status, msg)
	}
	c, _ := h.caller(r)
	if c.outletID == "" {
		// No admin fallback (unlike RefundOrder): the returning outlet must be explicit. The middleware
		// already put the token's outlet in context when no X-Outlet-Id was sent, so this only fires for
		// a token with no outlet at all.
		httpx.Err(w, http.StatusForbidden, msgNoActiveOutlet)
		return
	}
	if !service.IsCanonicalUUID(c.outletID) {
		httpx.Err(w, http.StatusBadRequest, msgBadActiveOutlet)
		return
	}
	in, err := crossRefundInput(id, body, c.outletID, c.userID, c.name)
	if err != nil {
		fail(err)
		return
	}
	var out service.CrossOutletOutcome
	if err := write.RetryBusy(r.Context(), func() error {
		var e error
		out, e = h.OrderSvc.RefundCrossOutlet(r.Context(), in)
		return e
	}); err != nil {
		fail(err)
		return
	}
	h.invalidate(r)
	// Committed: read back what was stored, never what the tablet selected (a replay returns the
	// earlier refund whatever items the retry sent). Same stripped projection as the lookup.
	co, err := h.Repo.CrossOutletOrderByID(r.Context(), id)
	if err != nil {
		slog.Error("cross-outlet refund committed but the read-back failed", "orderId", id, "outletId", c.outletID, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "Refund tersimpan, tetapi data transaksi belum dapat dimuat. Segarkan halaman dan jangan refund ulang.")
		return
	}
	refund, ok := findRefund(co.Order, out.RefundID)
	if !ok {
		slog.Error("cross-outlet refund committed but its row is not on the order", "orderId", id, "refundId", out.RefundID)
		httpx.Err(w, http.StatusInternalServerError, "Refund tersimpan, tetapi data transaksi belum dapat dimuat. Segarkan halaman dan jangan refund ulang.")
		return
	}
	status := http.StatusCreated
	if out.Replayed {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"data": api.CrossOutletRefundResult{
		RefundId: refund.Id, RefundState: api.CrossOutletRefundResultRefundState(out.RefundState),
		Amount: float64(out.Amount), Replayed: out.Replayed, SaleOutletId: co.Order.OutletId,
		Refund: refund, Order: co,
	}})
}

func findRefund(o api.Order, refundID string) (api.OrderRefund, bool) {
	if o.Refunds == nil {
		return api.OrderRefund{}, false
	}
	for _, rf := range *o.Refunds {
		if strings.EqualFold(rf.Id.String(), refundID) {
			return rf, true
		}
	}
	return api.OrderRefund{}, false
}

// CrossOutletLookup is GET /cross-outlet-returns/lookup?orderNumber=... | ?phone=...
func (h *Handlers) CrossOutletLookup(w http.ResponseWriter, r *http.Request) {
	c, _ := h.caller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, msgNoActiveOutlet)
		return
	}
	if !service.IsCanonicalUUID(c.outletID) {
		httpx.Err(w, http.StatusBadRequest, msgBadActiveOutlet)
		return
	}
	q := r.URL.Query()
	number, rawPhone := strings.TrimSpace(q.Get("orderNumber")), strings.TrimSpace(q.Get("phone"))
	if (number == "") == (rawPhone == "") {
		httpx.Err(w, http.StatusBadRequest, "Isi tepat satu: nomor order atau nomor HP.")
		return
	}
	var (
		rows []api.CrossOutletOrder
		err  error
	)
	if number != "" {
		rows, err = h.Repo.CrossOutletByNumber(r.Context(), c.outletID, number)
	} else {
		norm := phone.Normalize(rawPhone)
		if norm == "" {
			httpx.Err(w, http.StatusBadRequest, "Nomor HP tidak valid")
			return
		}
		rows, err = h.Repo.CrossOutletByPhone(r.Context(), c.outletID, norm)
	}
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if rows == nil {
		rows = []api.CrossOutletOrder{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows})
}
