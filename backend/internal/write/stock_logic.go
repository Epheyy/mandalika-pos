package write

import "fmt"

// Goods receipt sources: what a receipt is for. Pergerakan reports warranty replacements apart.
const (
	ReceiptSourceSupply   = "supply"
	ReceiptSourceWarranty = "warranty"
)

// receiptSource is the stored source of a receipt: empty means supply.
func receiptSource(s string) string {
	if s == "" {
		return ReceiptSourceSupply
	}
	return s
}

// validateReceiptSource rejects a source other than supply or warranty (empty is supply).
func validateReceiptSource(s string) error {
	if s != "" && s != ReceiptSourceSupply && s != ReceiptSourceWarranty {
		return fmt.Errorf("sumber penerimaan tidak valid")
	}
	return nil
}

// validateGoodsReceipt checks a location goods-in request before any DB work.
// MaxReceiptQty bounds one goods-receipt line so the int32 stock arithmetic can
// never wrap.
const MaxReceiptQty = 1_000_000

func validateGoodsReceipt(kind string, items []GoodsReceiptItem) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if len(items) == 0 {
		return fmt.Errorf("minimal satu item")
	}
	for _, it := range items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
		if it.Qty > MaxReceiptQty {
			return fmt.Errorf("qty tidak boleh lebih dari %d", MaxReceiptQty)
		}
	}
	return nil
}

// validateLocationAdjust checks an absolute stock correction request.
func validateLocationAdjust(kind string, newQty int, reason string) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if reason == "" {
		return fmt.Errorf("alasan wajib diisi")
	}
	if newQty < 0 {
		return fmt.Errorf("stok tidak boleh negatif")
	}
	return nil
}
