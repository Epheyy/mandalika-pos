package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/clientip"
	"github.com/mandalika/pos-backend/internal/config"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
	"github.com/mandalika/pos-backend/internal/receiptlink"
	"github.com/mandalika/pos-backend/internal/write"
)

// Receipt links are valid for 7 days (the default message says so).
const receiptLinkTTL = 7 * 24 * time.Hour

const (
	rlMaxDeviceRunes = 128
	msgRLUnsynced    = "Order belum tersinkron"
)

func (h *Handlers) receiptLinkBase() string {
	if h.linkBase != "" {
		return h.linkBase
	}
	return config.DefaultPublicLinkBaseURL
}

// CreateReceiptLink is POST /receipt-links: a one-time-per-send link to the digital receipt and
// rating page, plus the rendered WhatsApp message and click-to-chat URL. Neither the token nor the
// full phone number is stored or logged (the link row keeps the token's SHA-256 and "****1234").
func (h *Handlers) CreateReceiptLink(w http.ResponseWriter, r *http.Request) {
	var in api.ReceiptLinkRequest
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Permintaan tidak valid.")
		return
	}
	if (in.OrderUuid == nil) == (in.OrderId == nil) {
		httpx.Err(w, http.StatusBadRequest, "Isi tepat satu: orderUuid atau orderId.")
		return
	}
	if !requireActiveOutlet(w, r) {
		return
	}
	byUUID, id := in.OrderUuid != nil, ""
	if byUUID {
		id = in.OrderUuid.String()
	} else {
		id = in.OrderId.String()
	}
	order, err := h.Repo.ReceiptLinkOrder(r.Context(), scope(r), byUUID, id)
	if errors.Is(err, read.ErrNotFound) {
		if byUUID {
			httpx.Err(w, http.StatusConflict, msgRLUnsynced)
		} else {
			httpx.Err(w, http.StatusNotFound, "Order tidak ditemukan.")
		}
		return
	}
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if order.Status != "completed" && order.Status != "partially_refunded" {
		httpx.Err(w, http.StatusConflict, "Struk digital hanya untuk pesanan yang selesai.")
		return
	}

	rawPhone, source := "", "customer"
	if in.Phone != nil && strings.TrimSpace(*in.Phone) != "" {
		rawPhone, source = *in.Phone, "typed"
	} else {
		rawPhone = order.CustomerPhone
	}
	digits := receiptlink.WaDigits(rawPhone)
	switch {
	case digits == "" && source == "typed":
		httpx.Err(w, http.StatusBadRequest, "Nomor WhatsApp tidak valid")
		return
	case digits == "":
		httpx.Err(w, http.StatusBadRequest, "Nomor WhatsApp wajib diisi")
		return
	}

	token, hash, err := receiptlink.NewToken()
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	salt, err := receiptlink.NewSalt()
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	c, _ := h.caller(r)
	device := ""
	if in.DeviceId != nil {
		device = xoTruncateRunes(strings.TrimSpace(*in.DeviceId), rlMaxDeviceRunes)
	}
	expires := time.Now().Add(receiptLinkTTL)
	if _, _, err := h.Write.InsertReceiptLink(r.Context(), write.ReceiptLinkRow{
		OrderID: order.ID, OutletID: order.OutletID, CreatedBy: c.userID, CreatedByName: c.name, DeviceID: device,
		TokenHash: hash, RecipientMasked: receiptlink.MaskPhone(digits), RecipientSource: source,
		NetSalt: salt, NetHash: receiptlink.NetHash(salt, clientip.ClientIPBucket(r)), ExpiresAt: expires,
	}); err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}

	tpl, err := h.Repo.WaReceiptTemplate(r.Context())
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if tpl == "" || receiptlink.Validate(tpl) != "" {
		tpl = receiptlink.DefaultTemplate
	}
	url := h.receiptLinkBase() + "/r/" + token
	message := receiptlink.Render(tpl, receiptlink.Values{
		CustomerName: order.CustomerName, SalesmanName: order.SalesmanName, OutletName: order.OutletName,
		OrderNumber: order.OrderNumber, Total: order.Total, Link: url,
	})
	writeJSON(w, http.StatusCreated, api.ReceiptLinkResponse{Data: api.ReceiptLink{
		Url: url, Message: message, WaUrl: receiptlink.WaURL(digits, message),
		ExpiresAt: expires.UTC(), PhoneMasked: receiptlink.MaskPhone(digits),
	}})
}
