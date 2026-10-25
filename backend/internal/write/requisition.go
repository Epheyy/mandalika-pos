package write

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// Permintaan Barang (PB): pure state-machine and validation logic. The database side is
// requisition_repo.go. Status flow:
//
//	draft -> submitted -> approved | rejected;  approved -> fulfilled (a transfer draft is linked);
//	draft | submitted -> cancelled.
//
// "fulfil" from fulfilled is the re-fulfil, allowed only when the linked transfer was cancelled.

// RequisitionItemInput is one requested line (SKU = product + size).
type RequisitionItemInput struct {
	ProductID    string `json:"productId"`
	VariantSize  string `json:"variantSize"`
	RequestedQty int    `json:"requestedQty"`
	Note         string `json:"note"`
}

// RequisitionInput creates or replaces a draft.
type RequisitionInput struct {
	Note     string                 `json:"note"`
	NeededBy string                 `json:"neededBy"` // YYYY-MM-DD or ""
	Items    []RequisitionItemInput `json:"items"`
}

// RequisitionApproveItem is the warehouse's decision for one line.
type RequisitionApproveItem struct {
	ItemID      string `json:"itemId"`
	ApprovedQty int    `json:"approvedQty"`
}

// RequisitionApproval is the approve request: the source gudang and a qty per line.
type RequisitionApproval struct {
	WarehouseID string                   `json:"warehouseId"`
	Items       []RequisitionApproveItem `json:"items"`
	Note        string                   `json:"note"`
}

// reqLine is a loaded stock_requisition_items row.
type reqLine struct {
	id, pid, size string
	requested     int
	approved      *int
}

func errRequisitionDenied(from string) error {
	return apperr.Wrap(apperr.Conflict, fmt.Errorf("aksi tidak diizinkan dari status '%s'", from))
}

func errRequisitionRejected(format string, a ...any) error {
	return apperr.Wrap(apperr.Rejected, fmt.Errorf(format, a...))
}

// requisitionTransition returns the status `action` moves a PB to from `from`.
// Actions: submit, cancel, approve, reject, fulfil. Fulfil from "fulfilled" is returned as
// allowed here; the caller must additionally require the linked transfer to be cancelled.
func requisitionTransition(from, action string) (string, error) {
	switch action {
	case "submit":
		if from == "draft" {
			return "submitted", nil
		}
	case "cancel":
		if from == "draft" || from == "submitted" {
			return "cancelled", nil
		}
	case "approve":
		if from == "submitted" {
			return "approved", nil
		}
	case "reject":
		if from == "submitted" {
			return "rejected", nil
		}
	case "fulfil":
		if from == "approved" || from == "fulfilled" {
			return "fulfilled", nil
		}
	}
	return "", errRequisitionDenied(from)
}

// canRefulfil reports whether a fulfilled PB may be fulfilled again: only when its linked
// transfer was cancelled.
func canRefulfil(transferStatus string) bool { return transferStatus == "cancelled" }

// validateRequisitionInput checks a draft's lines and needed-by date. A duplicate
// (product, size) is refused exactly like a transfer line.
func validateRequisitionInput(in RequisitionInput) error {
	items := make([]TransferItemInput, len(in.Items))
	for i, it := range in.Items {
		items[i] = TransferItemInput{ProductID: it.ProductID, VariantSize: it.VariantSize, Qty: it.RequestedQty}
		if _, err := uuid.Parse(it.ProductID); err != nil {
			return errRequisitionRejected("produk tidak valid")
		}
		if strings.TrimSpace(it.VariantSize) == "" {
			return errRequisitionRejected("ukuran wajib diisi")
		}
	}
	if err := validateItems(items); err != nil {
		return apperr.Wrap(apperr.Rejected, err)
	}
	if in.NeededBy != "" {
		if _, err := time.Parse("2006-01-02", in.NeededBy); err != nil {
			return errRequisitionRejected("tanggal dibutuhkan tidak valid")
		}
	}
	return nil
}

// resolveApproval validates an approval against the stored lines and returns the approved
// qty per line id. Every line needs exactly one decision, 0 <= approvedQty <= requestedQty.
func resolveApproval(lines []reqLine, items []RequisitionApproveItem) (map[string]int, error) {
	byID := make(map[string]reqLine, len(lines))
	for _, l := range lines {
		byID[l.id] = l
	}
	out := make(map[string]int, len(items))
	for _, it := range items {
		id := it.ItemID
		if u, err := uuid.Parse(id); err == nil {
			id = u.String()
		}
		l, ok := byID[id]
		if !ok {
			return nil, errRequisitionRejected("baris tidak ditemukan pada permintaan ini")
		}
		if _, dup := out[id]; dup {
			return nil, errRequisitionRejected("baris muncul lebih dari sekali")
		}
		if it.ApprovedQty < 0 || it.ApprovedQty > l.requested {
			return nil, errRequisitionRejected("qty disetujui harus antara 0 dan qty diminta")
		}
		out[id] = it.ApprovedQty
	}
	if len(out) != len(lines) {
		return nil, errRequisitionRejected("setiap baris harus punya qty disetujui")
	}
	total := 0
	for _, q := range out {
		total += q
	}
	if total == 0 {
		// Nothing to transfer would strand the PB (fulfil refuses it): rejecting is the way out.
		return nil, errRequisitionRejected("Semua jumlah 0 — gunakan Tolak")
	}
	return out, nil
}

// approvedTransferItems turns approved lines into transfer lines; approved 0 is skipped.
func approvedTransferItems(lines []reqLine) []TransferItemInput {
	var out []TransferItemInput
	for _, l := range lines {
		if l.approved != nil && *l.approved > 0 {
			out = append(out, TransferItemInput{ProductID: l.pid, VariantSize: l.size, Qty: *l.approved})
		}
	}
	return out
}
