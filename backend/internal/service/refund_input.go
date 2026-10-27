package service

import (
	"math/bits"
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
	// A41: a refund that names its sale by client orderUuid. Another tablet's sale is
	// a review item; an id and a uuid that are not the same order are a bad request.
	ErrRefundSaleOtherDevice = apperr.New(apperr.Conflict, "Transaksi ini dibuat di tablet lain dan tidak dapat direfund dari tablet ini."+refundWarning)
	ErrRefundOrderMismatch   = apperr.New(apperr.Rejected, "ID transaksi dan UUID penjualan refund tidak cocok."+refundWarning)

	// C4a per-line refund. Quantity over what is left is a Conflict (it may be a second
	// payout from another tablet: review, never retried); the rest are malformed input or a
	// shape the order cannot take (Rejected).
	ErrRefundQtyExceeded = apperr.New(apperr.Conflict, "Jumlah refund melebihi sisa barang yang belum direfund."+refundWarning)
	// ErrRefundPartialNeedsNewApp is the legacy (no items) refund hitting an order another
	// tablet already part-refunded. It must NEVER mean "refund the remainder": the old
	// dialog showed the full total, which may already be paid out.
	ErrRefundPartialNeedsNewApp = apperr.New(apperr.Conflict, "Sebagian transaksi ini sudah direfund dari tablet lain. Perbarui aplikasi lalu refund sisa barang."+refundWarning)
	ErrRefundGroupSplit         = apperr.New(apperr.Rejected, "Barang promo paket/beli-gratis harus direfund bersamaan seluruhnya."+refundWarning)
	ErrRefundLegacyWholeOnly    = apperr.New(apperr.Rejected, "Transaksi lama hanya bisa direfund seluruhnya."+refundWarning)
	ErrRefundLineUnknown        = apperr.New(apperr.Rejected, "Baris barang refund tidak dikenal, ganda, atau jumlahnya tidak valid."+refundWarning)
	ErrRefundReasonCodeInvalid  = apperr.New(apperr.Rejected, "Kode alasan refund tidak valid."+refundWarning)
)

// Refund amount warnings stored on order_refunds.amount_warning (D-39: the amount is a
// captured fact, a difference is flagged for head office and never rejected).
const (
	RefundWarnAmountMismatch = "amount_mismatch"
	RefundWarnOverTotal      = "over_total"
)

const (
	// maxRefundReasonCodeRunes caps the optional preset code (D-43 presets are short slugs).
	maxRefundReasonCodeRunes = 40
	// refundAmountToleranceRp is the rupiah rounding slack before a claimed amount is flagged.
	refundAmountToleranceRp = 1
	// maxRefundAmountRp bounds a claimed refund amount (numeric(14,2) tops out at 999,999,999,999.99).
	maxRefundAmountRp = int64(999_999_999_999)
)

// RefundItemInput is one refunded order line: LineNo is order_items.line_no (the 0-based
// position in the sale payload), Quantity the units coming back in this refund.
type RefundItemInput struct {
	LineNo   int
	Quantity int
}

// IsCanonicalUUID reports whether s is a uuid in the canonical 36-char spelling.
func IsCanonicalUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

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
	// Items selects the lines of a partial refund. NIL means the legacy whole-order shape
	// (no items key in the payload); a non-nil empty slice is malformed (ErrRefundLineUnknown)
	// so a buggy client can never turn "no lines" into "refund everything".
	Items []RefundItemInput
	// RefundAmount is the rupiah the tablet showed and paid out (optional, captured fact).
	RefundAmount *int64
	// ReasonCode is an optional preset slug (D-43); ReasonCode "" = none.
	ReasonCode string
	// DeviceID + ClientRefundUUID identify the refund for UNIQUE(device_id,
	// client_refund_uuid), defence in depth behind the A11 operation receipt. Either empty =
	// no dedupe row (direct route, old tablets).
	DeviceID, ClientRefundUUID string
}

// NormalizeRefund validates the refund input shared by the direct route and the
// /sync/batch item and returns the reason to store (trimmed). It runs before any
// SQL so a malformed id never reaches PostgreSQL as a raw 22P02.
func NormalizeRefund(orderID, reason string) (string, error) {
	// Canonical 36-char form only. uuid.Parse (and PostgreSQL) also accept braces,
	// "urn:uuid:" and 32 hex digits; we deliberately allow exactly one spelling.
	if !IsCanonicalUUID(orderID) {
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

// ValidateRefundExtras validates the C4a additions of a refund input and returns the
// normalised reason code ("" when absent). Items is nil for the legacy shape; otherwise it
// must be non-empty with unique, in-range line numbers and positive quantities.
func ValidateRefundExtras(items []RefundItemInput, reasonCode string) (string, error) {
	if items != nil {
		if len(items) == 0 {
			return "", ErrRefundLineUnknown
		}
		seen := make(map[int]bool, len(items))
		for _, it := range items {
			if it.LineNo < 0 || it.LineNo > maxLineNo || it.Quantity <= 0 || seen[it.LineNo] {
				return "", ErrRefundLineUnknown
			}
			seen[it.LineNo] = true
		}
	}
	reasonCode = strings.TrimSpace(reasonCode)
	if utf8.RuneCountInString(reasonCode) > maxRefundReasonCodeRunes {
		return "", ErrRefundReasonCodeInvalid
	}
	for _, r := range reasonCode {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return "", ErrRefundReasonCodeInvalid
		}
	}
	return reasonCode, nil
}

// ResolveRefundAmount picks the amount of record for a refund (D-39, A09 style, bounded by
// D-49) and never returns an error. Within the bound the tablet's claimed amount is the fact
// (it was paid out at the till), else the computed one. The bound: the amount of record never
// exceeds what the order still has left to refund, max(0, orderTotal - priorAmounts), so no
// money reader (cash, shift, reports, ERP tender) can sum past the order total. warning is ""
// or RefundWarnAmountMismatch (claimed differs from computed by more than Rp1, or the claim is
// out of range and was ignored); when the running total would exceed orderTotal by more than
// Rp1 it is RefundWarnOverTotal, which wins over a mismatch. claimedKept is the claim as sent
// (nil when absent or ignored), stored beside the capped amount as information only.
func ResolveRefundAmount(claimed *int64, computed, priorAmounts, orderTotal int64) (amount int64, warning string, claimedKept *int64) {
	amount = computed
	if claimed != nil {
		if *claimed < 0 || *claimed > maxRefundAmountRp {
			warning = RefundWarnAmountMismatch // malformed claim: keep the computed figure
		} else {
			v := *claimed
			claimedKept = &v
			amount = v
			if d := amount - computed; d > refundAmountToleranceRp || -d > refundAmountToleranceRp {
				warning = RefundWarnAmountMismatch
			}
		}
	}
	if priorAmounts+amount > orderTotal+refundAmountToleranceRp {
		warning = RefundWarnOverTotal
	}
	if remaining := max(orderTotal-priorAmounts, 0); amount > remaining {
		amount = remaining
	}
	return amount, warning, claimedKept
}

// ClawTarget is the cumulative share of points to take back (or restore) once refundedComputed
// of orderTotal has been refunded (D-37): floor(points * refundedComputed / orderTotal), and
// all of the points when the order is fully refunded. The caller subtracts what earlier
// refunds already took. Uses 128-bit math so large totals cannot overflow.
func ClawTarget(points, refundedComputed, orderTotal int64, complete bool) int64 {
	if points <= 0 {
		return 0
	}
	if complete {
		return points
	}
	// A Rp0 order (fully paid with points) has no value to apportion by: a partial refund
	// must not hand back or claw all points while the customer keeps the other items. Only
	// the completing refund settles, with the full amount.
	if orderTotal <= 0 || refundedComputed <= 0 {
		return 0
	}
	if refundedComputed >= orderTotal {
		return points
	}
	hi, lo := bits.Mul64(uint64(points), uint64(refundedComputed)) // refunded < total, so hi < total
	q, _ := bits.Div64(hi, lo, uint64(orderTotal))
	return int64(q)
}
