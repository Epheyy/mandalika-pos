package service

import (
	"fmt"
	"time"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// Void ("Batalkan transaksi"): a wrong sale is cancelled whole and one append-only
// order_voids row records it. The void has its own write path (void.go) and never touches
// order_refunds, so every money reader keeps reading refunds as money paid out.

// VoidReasonCode is the wire value of a void reason.
type VoidReasonCode string

const (
	VoidReasonWrongPayment  VoidReasonCode = "salah_metode_pembayaran"
	VoidReasonWrongItems    VoidReasonCode = "salah_barang"
	VoidReasonWrongPromo    VoidReasonCode = "salah_promo"
	VoidReasonWrongCustomer VoidReasonCode = "salah_pelanggan"
	VoidReasonDuplicate     VoidReasonCode = "transaksi_ganda"
	VoidReasonTest          VoidReasonCode = "transaksi_tes"
	VoidReasonOther         VoidReasonCode = "lainnya"
)

// VoidMode is what the void leaves behind: nothing, a replacement made in the same
// transaction, or a replacement to be made later (Phase 2).
type VoidMode string

const (
	VoidModeNone    VoidMode = "none"
	VoidModeReplace VoidMode = "replace"
	VoidModeLater   VoidMode = "later"
)

// VoidSource is where the void came from.
type VoidSource string

const (
	VoidSourcePOS        VoidSource = "pos"
	VoidSourceBackoffice VoidSource = "backoffice"
)

// VoidAuthority is why the caller may void this sale.
type VoidAuthority string

const (
	VoidOwnShift VoidAuthority = "own_shift"
	VoidAny      VoidAuthority = "any"
)

// VoidStockChoice is the per-line choice for a sale line an approved stock count covered.
type VoidStockChoice string

const (
	VoidStockRestock     VoidStockChoice = "restock"
	VoidStockSkipCounted VoidStockChoice = "skip_counted"
)

const (
	DefaultVoidWindowDays = 7
	MinVoidWindowDays     = 1
	MaxVoidWindowDays     = 30
	MinVoidOtherNoteRunes = 10
	MaxVoidNoteRunes      = 500
)

// VoidInput is one void request, after the caller's rights were read from its token.
type VoidInput struct {
	OutletID, OrderID string
	Reason            VoidReasonCode
	Note              string
	Mode              VoidMode
	Source            VoidSource
	UserID, UserName  string
	// DeviceID and ClientVoidUUID are the idempotency pair (UNIQUE on order_voids).
	DeviceID, ClientVoidUUID string
	// CallerShiftID is the envelope shift of a POS void; empty for the Backoffice.
	CallerShiftID               string
	CanVoidOwnShift, CanVoidAny bool
	// EnvelopeDeviceID is the envelope's device, used by the unattributed-sale rule (O5).
	EnvelopeDeviceID string
	// StockChoices maps a sale movement's dedupe key to the user's choice for it.
	StockChoices map[string]VoidStockChoice
	Channel      string
}

// VoidResult is the outcome of one void, returned to the sync layer for the ack.
type VoidResult struct {
	VoidID, OrderID, ReplacementOrderID string
	Authority                           VoidAuthority
	AfterClose, Replayed                bool
}

// voidFacts are the rows the pure rules decide on, read under the void's locks.
type voidFacts struct {
	Status              string
	RefundCount         int
	HasVoid             bool
	OutletID, DeviceID  string
	CreatedAt           time.Time
	BusinessDate, Today string // YYYY-MM-DD, the outlet's zone
	WindowDays          int

	ShiftID, ShiftStatus string
	ShiftClosedAt        *time.Time
	// HasReplacementCorrection: the order has a shift_corrections row of kind 'replacement'
	// (Phase 2), so it counts in a closed shift although it was created after the close.
	HasReplacementCorrection bool

	CallerShiftStatus   string
	CallerShiftOpenedAt *time.Time
}

var (
	ErrVoidNotFound           = apperr.New(apperr.Conflict, "Transaksi tidak ditemukan di outlet ini.")
	ErrVoidAlreadyVoided      = apperr.New(apperr.Conflict, "Transaksi ini sudah dibatalkan.")
	ErrVoidRefunded           = apperr.New(apperr.Conflict, "Transaksi yang sudah direfund tidak dapat dibatalkan.")
	ErrVoidNotCompleted       = apperr.New(apperr.Conflict, "Hanya transaksi selesai yang dapat dibatalkan.")
	ErrVoidForbidden          = apperr.New(apperr.Forbidden, "Izin membatalkan transaksi ini tidak dimiliki.")
	ErrVoidCountNeedsChoice   = apperr.New(apperr.Conflict, "Stock opname sudah menghitung barang di transaksi ini. Lakukan pembatalan saat online agar pilihan stok bisa dibuat.")
	ErrVoidShiftClosed        = apperr.New(apperr.Forbidden, "Shift transaksi ini sudah ditutup. Batalkan lewat Backoffice oleh pengguna dengan izin Batalkan Transaksi.")
	ErrVoidReasonInvalid      = apperr.New(apperr.Rejected, "Alasan pembatalan tidak valid.")
	ErrVoidNoteRequired       = apperr.New(apperr.Rejected, "Catatan wajib diisi minimal 10 karakter untuk alasan Lainnya.")
	ErrVoidNoMovements        = apperr.New(apperr.Conflict, "Catatan stok transaksi ini tidak ditemukan; pembatalan tidak dapat diproses.")
	ErrVoidReplacementInvalid = apperr.New(apperr.Rejected, "Data transaksi pengganti tidak valid.")
)

// errVoidOutsideWindow is the window refusal with the configured days in its text.
func errVoidOutsideWindow(days int) error {
	return apperr.New(apperr.Conflict, fmt.Sprintf("Transaksi ini sudah melewati batas waktu pembatalan (%d hari).", days))
}

// errVoidAmountsLocked is the replacement-amount refusal (Phase 2); total is formatted by the caller.
func errVoidAmountsLocked(total string) error {
	return apperr.New(apperr.Rejected, fmt.Sprintf("Jumlah pembayaran pengganti harus sama dengan yang diterima (Rp %s).", total))
}
