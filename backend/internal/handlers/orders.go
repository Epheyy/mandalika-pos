package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/service"
	"github.com/mandalika/pos-backend/internal/write"
)

type createOrderBody struct {
	OrderUuid         string              `json:"orderUuid"`
	DeviceID          string              `json:"deviceId"`
	SalesmanID        string              `json:"salesmanId"`
	SalesmanName      string              `json:"salesmanName"`
	CustomerID        string              `json:"customerId"`
	CustomerName      string              `json:"customerName"`
	Items             []service.OrderItem `json:"items"`
	PaymentMethod     string              `json:"paymentMethod"`
	AmountPaid        float64             `json:"amountPaid"`
	Tenders           json.RawMessage     `json:"tenders"` // C6: absent = legacy scalar path
	DiscountType      string              `json:"discountType"`
	DiscountValue     float64             `json:"discountValue"`
	SurchargeVal      float64             `json:"surchargeValue"`
	SurchargeKind     string              `json:"surchargeType"`
	DiscountCode      string              `json:"discountCode"`
	PromotionID       string              `json:"promotionId"`
	PromotionIDs      []string            `json:"promotionIds"`
	DiscountCodes     []string            `json:"discountCodes"`
	DiscountLabel     string              `json:"discountLabel"`
	DiscountBreakdown json.RawMessage     `json:"discountBreakdown"`
	PointsRedeemed    int                 `json:"pointsRedeemed"`
	Notes             string              `json:"notes"`
	ShiftID           string              `json:"shiftId"`
	QuotedTotal       *float64            `json:"quotedTotal"` // A10
	ReceiptSnapshot   json.RawMessage     `json:"receiptSnapshot"`
}

func (h *Handlers) CreateOrder(w http.ResponseWriter, r *http.Request) {
	h.createOrder(w, r, h.caller, h.OrderSvc.CreateOrder)
}

func (h *Handlers) createOrder(w http.ResponseWriter, r *http.Request,
	resolveCaller func(*http.Request) (callerID, error),
	create func(context.Context, service.CreateOrderInput) (string, bool, bool, error),
) {
	body, ok := decodeWrite[createOrderBody](w, r)
	if !ok {
		return
	}
	c, _ := resolveCaller(r)
	if c.outletID == "" {
		httpx.Err(w, http.StatusForbidden, "no active outlet")
		return
	}
	idem := r.Header.Get("Idempotency-Key")
	if idem == "" {
		httpx.Err(w, http.StatusBadRequest, "Idempotency-Key header required")
		return
	}
	// Redis fast-path: a known key returns the canonical order immediately.
	if h.Cache != nil {
		if oid, hit := h.Cache.Get(r.Context(), "idem:"+idem); hit {
			h.returnOrder(w, r, oid)
			return
		}
	}
	in := service.CreateOrderInput{
		IdempotencyKey: idem, OrderUUID: body.OrderUuid, DeviceID: body.DeviceID,
		OutletID: c.outletID, CashierID: c.userID, CashierName: c.name,
		SalesmanID: body.SalesmanID, SalesmanName: body.SalesmanName,
		CustomerID: body.CustomerID, CustomerName: body.CustomerName,
		Items: body.Items, PaymentMethod: body.PaymentMethod,
		AmountPaid: body.AmountPaid, Tenders: body.Tenders, ManualKind: service.DiscountKind(body.DiscountType),
		ManualValue: body.DiscountValue, Surcharge: body.SurchargeVal,
		SurchargeKind: service.DiscountKind(body.SurchargeKind),
		DiscountCode:  body.DiscountCode, PromotionID: body.PromotionID,
		PromotionIDs: body.PromotionIDs, DiscountCodes: body.DiscountCodes,
		DiscountLabel:     body.DiscountLabel,
		DiscountBreakdown: body.DiscountBreakdown,
		QuotedTotal:       body.QuotedTotal,
		ReceiptSnapshot:   body.ReceiptSnapshot,
		PointsRedeemed:    body.PointsRedeemed,
		Notes:             body.Notes, ShiftID: body.ShiftID, Offline: false,
	}
	// A42: a deadlock/serialization victim is re-run as a whole fresh transaction (the
	// processed_keys receipt makes a re-run after an applied commit a replay).
	var id string
	err := write.RetryBusy(r.Context(), func() error {
		var e error
		id, _, _, e = create(r.Context(), in)
		return e
	})
	if err != nil {
		if errors.Is(err, write.ErrBusy) {
			httpx.Err(w, http.StatusConflict, write.ErrBusy.Error()) // nothing applied, safe to retry
			return
		}
		var rej *service.ErrDiscountRejected
		if errors.As(err, &rej) {
			httpx.Err(w, http.StatusUnprocessableEntity, discountRejectMessage(rej.Violations))
			return
		}
		if errors.Is(err, service.ErrTenderRejected) {
			// The message carries only the cashier's own captured/due amounts.
			httpx.Err(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		if _, coded := apperr.CodeOf(err); !coded {
			// Unclassified (e.g. a database error): never echo its text to the client.
			slog.Error("create order failed", "idempotencyKey", idem, "err", err)
			httpx.Err(w, http.StatusInternalServerError, "Terjadi kesalahan server, silakan coba lagi")
			return
		}
		writeErr(w, r, http.StatusBadRequest, err)
		return
	}
	if h.Cache != nil {
		h.Cache.Set(r.Context(), "idem:"+idem, id, 24*60*60*1e9)
	}
	h.invalidate(r)
	h.returnOrder(w, r, id)
}

func (h *Handlers) returnOrder(w http.ResponseWriter, r *http.Request, id string) {
	o, err := h.Repo.Order(r.Context(), scope(r), id)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": o})
}

// refundHTTPError maps a refund failure to the direct route's response. Business
// refusals keep their (Indonesian) text; anything else is a server fault whose raw
// text stays in the log, never in the response (A06).
func refundHTTPError(err error) (int, string) {
	if code, ok := apperr.CodeOf(err); ok {
		switch code {
		case apperr.Rejected:
			return http.StatusBadRequest, err.Error()
		case apperr.Forbidden:
			return http.StatusForbidden, err.Error()
		case apperr.Conflict, apperr.Busy:
			return http.StatusConflict, err.Error()
		}
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "40P01", "40001", "55P03": // lock conflict: nothing applied, retry later
			return http.StatusConflict, write.ErrBusy.Error()
		}
	}
	return http.StatusInternalServerError, "Terjadi kesalahan server, silakan coba lagi"
}

// directRefundDevice is the device_id of a backoffice refund's replay key: "backoffice:<user>", or ""
// (no replay key) when the caller sent no client uuid.
func directRefundDevice(userID, clientUUID string) string {
	if clientUUID == "" {
		return ""
	}
	return "backoffice:" + userID
}

func (h *Handlers) RefundOrder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reason     string `json:"reason"`
		ReasonCode string `json:"reasonCode"`
		// ClientRefundUUID makes a retry of the same admin refund a replay (UNIQUE(device_id,
		// client_refund_uuid)) instead of a second payout when the response was lost. Optional.
		ClientRefundUUID string `json:"clientRefundUuid"`
		// Items is the per-line shape (C4c admin refund). Absent = the whole order; a present
		// but empty array stays non-nil so the service refuses it instead of refunding everything.
		Items []struct {
			LineNo   int `json:"lineNo"`
			Quantity int `json:"quantity"`
		} `json:"items"`
	}
	if err := httpx.DecodeLoose(r, &body); err != nil {
		if isBodyTooLarge(err) {
			writeDecodeErr(w, err)
			return
		}
		httpx.Err(w, http.StatusBadRequest, "Isi permintaan refund tidak valid.")
		return
	}
	var items []service.RefundItemInput
	if body.Items != nil {
		items = make([]service.RefundItemInput, 0, len(body.Items))
		for _, it := range body.Items {
			items = append(items, service.RefundItemInput{LineNo: it.LineNo, Quantity: it.Quantity})
		}
	}
	if body.ClientRefundUUID != "" && !service.IsCanonicalUUID(body.ClientRefundUUID) {
		httpx.Err(w, http.StatusBadRequest, "clientRefundUuid tidak valid.")
		return
	}
	id := chi.URLParam(r, "id")
	fail := func(err error) {
		status, msg := refundHTTPError(err)
		if status >= http.StatusInternalServerError {
			slog.Error("refund failed", "orderId", id, "err", err)
		}
		httpx.Err(w, status, msg)
	}
	// The shared input rules run first so a malformed id or reason never reaches SQL.
	if _, err := service.NormalizeRefund(id, body.Reason); err != nil {
		fail(err)
		return
	}
	c, _ := h.caller(r)
	outlet := c.outletID
	if outlet == "" {
		// An admin on "Semua outlet" refunds at the order's own outlet (no new
		// authority); any other caller without an outlet is refused.
		if c.role != "admin" {
			httpx.Err(w, http.StatusForbidden, "Outlet aktif belum dipilih untuk akun ini.")
			return
		}
		o, err := h.OrderSvc.OrderOutlet(r.Context(), id)
		if err != nil {
			fail(err)
			return
		}
		outlet = o
	}
	// Direct (backoffice/API) refunds are paid from no shift's drawer (owner B2).
	if err := write.RetryBusy(r.Context(), func() error {
		return h.OrderSvc.Refund(r.Context(), service.RefundInput{
			OutletID: outlet, OrderID: id, Reason: body.Reason,
			UserID: c.userID, UserName: c.name,
			Items: items, ReasonCode: body.ReasonCode,
			DeviceID: directRefundDevice(c.userID, body.ClientRefundUUID), ClientRefundUUID: body.ClientRefundUUID,
		})
	}); err != nil {
		fail(err)
		return
	}
	h.invalidate(r)
	// The refund is committed: read it back at the outlet it ran at (the request's
	// scope is empty for an admin on "Semua outlet"), and never echo a raw read error.
	o, err := h.Repo.Order(r.Context(), read.Scope{OutletID: outlet}, id)
	if err != nil {
		slog.Error("refund committed but the read-back failed", "orderId", id, "outletId", outlet, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "Refund tersimpan, tetapi data transaksi belum dapat dimuat. Segarkan halaman dan jangan refund ulang.")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"data": o})
}

// discountRejectMessage turns the first promo violation into an Indonesian cashier
// message for an online-rejected discount (SP-Promo-1).
func discountRejectMessage(v []service.PromoViolation) string {
	if len(v) == 0 {
		return "Diskon tidak berlaku"
	}
	switch v[0] {
	case service.ViolationExpired:
		return "Kode/promo sudah kadaluarsa"
	case service.ViolationNotStarted:
		return "Promo belum dimulai"
	case service.ViolationBelowMin:
		return "Belum memenuhi minimum belanja"
	case service.ViolationOutsideHours:
		return "Promo tidak berlaku pada jam ini"
	case service.ViolationWrongDay:
		return "Promo tidak berlaku hari ini"
	case service.ViolationWrongOutlet:
		return "Promo tidak berlaku di outlet ini"
	case service.ViolationUsageLimit:
		return "Kuota kode diskon sudah habis"
	case service.ViolationNotFound:
		return "Diskon tidak ditemukan"
	case service.ViolationNotCombinable:
		return "Promo/kode ini tidak bisa digabung"
	case service.ViolationCodeOnly:
		return "Promo ini hanya bisa dipakai lewat kode"
	case service.ViolationRewardInvalid:
		return "Hadiah promo tidak valid atau melebihi kuota"
	case service.ViolationBundleInvalid:
		return "Bundel tidak valid atau syaratnya tidak terpenuhi"
	case service.ViolationRequiresCustomer:
		return "Kode ini butuh pelanggan terdaftar"
	case service.ViolationPerCustomerCapReached:
		return "Pelanggan sudah mencapai batas pemakaian kode ini"
	case service.ViolationWrongCustomer:
		return "Kode ini khusus untuk pelanggan tertentu"
	default:
		return "Diskon tidak berlaku"
	}
}
