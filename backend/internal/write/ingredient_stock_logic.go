package write

import "fmt"

// validateIngredientGoodsReceipt checks an ingredient location goods-in request.
func validateIngredientGoodsReceipt(kind string, items []IngredientGoodsReceiptItem) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if len(items) == 0 {
		return fmt.Errorf("minimal satu bahan")
	}
	for _, it := range items {
		if it.Qty <= 0 {
			return fmt.Errorf("qty harus lebih dari 0")
		}
		if err := validateUnitCost(it.UnitCost); err != nil {
			return err
		}
	}
	return nil
}

// validateIngredientLocationAdjust checks an ingredient absolute stock correction.
func validateIngredientLocationAdjust(kind string, newQty float64, reason string) error {
	if !validLocKind(kind) {
		return fmt.Errorf("lokasi tidak valid")
	}
	if reason == "" {
		return fmt.Errorf("alasan wajib")
	}
	if newQty < 0 {
		return fmt.Errorf("qty tidak boleh negatif")
	}
	return nil
}
