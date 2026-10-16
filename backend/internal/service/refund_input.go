package service

import (
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/apperr"
)

// MaxRefundReasonRunes caps the stored refund reason (A06). Keep in sync with
// RefundRequest.reason maxLength in api/openapi.yaml and the POS dialog.
const MaxRefundReasonRunes = 500

// refundWarning ends every refusal: a refused refund may already have been paid
// out at the till, and a retry must never become a second payout.
const refundWarning = " Data tetap tersimpan. Jika uang sudah dikembalikan, jangan bayar ulang."

// Input errors are Rejected (the request itself is wrong); order-state errors are
// Conflict (the order cannot be refunded as it stands). Both are non-retryable.
var (
	ErrRefundOrderInvalid   = apperr.New(apperr.Rejected, "ID transaksi refund tidak valid."+refundWarning)
	ErrRefundReasonRequired = apperr.New(apperr.Rejected, "Alasan refund wajib diisi."+refundWarning)
	ErrRefundReasonTooLong  = apperr.New(apperr.Rejected, "Alasan refund terlalu panjang (maksimal 500 karakter)."+refundWarning)
	ErrAlreadyRefunded      = apperr.New(apperr.Conflict, "Transaksi ini sudah pernah direfund."+refundWarning)
	ErrOrderNotRefundable   = apperr.New(apperr.Conflict, "Hanya transaksi yang selesai yang dapat direfund."+refundWarning)
	// ErrRefundOrderNotFound covers an unknown order and one that belongs to another
	// outlet (indistinguishable on purpose). Unlike ErrOrderClosed, shared with shifts,
	// it carries the do-not-repay warning.
	ErrRefundOrderNotFound = apperr.New(apperr.Conflict, "Transaksi tidak ditemukan di outlet ini."+refundWarning)
)

// RefundInput is one refund. ShiftID is the shift whose drawer paid it out ("" when
// unknown or none: direct/backoffice refunds, legacy items, unknown envelope shift);
// the caller must only set it to a shift row that exists at OutletID, because the
// column is a foreign key. UserID/UserName record who refunded (A06 audit trail).
type RefundInput struct {
	OutletID, OrderID, Reason string
	ShiftID                   string
	UserID, UserName          string
	// Channel is the transport the refund arrived on: "sync" (tablet batch) or
	// "direct" (empty = direct). Only recorded on refund_unresolved_variant rows (A44).
	Channel string
}

// NormalizeRefund validates the refund input shared by the direct route and the
// /sync/batch item and returns the reason to store (trimmed). It runs before any
// SQL so a malformed id never reaches PostgreSQL as a raw 22P02.
func NormalizeRefund(orderID, reason string) (string, error) {
	// Canonical 36-char form only. uuid.Parse (and PostgreSQL) also accept braces,
	// "urn:uuid:" and 32 hex digits; we deliberately allow exactly one spelling.
	if _, err := uuid.Parse(orderID); err != nil || len(orderID) != 36 {
		return "", ErrRefundOrderInvalid
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return "", ErrRefundReasonRequired
	}
	if utf8.RuneCountInString(reason) > MaxRefundReasonRunes {
		return "", ErrRefundReasonTooLong
	}
	return reason, nil
}
