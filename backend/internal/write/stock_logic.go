package write

import "fmt"

// validateGoodsReceipt checks a location goods-in request before any DB work.
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
