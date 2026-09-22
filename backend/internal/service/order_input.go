package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

// Limits are PostgreSQL numeric(14,2) money and integer quantities/points,
// not business spending caps. Decimal input remains supported by the schema.
const maxSaleMoney = 999_999_999_999.99

var ErrSaleInput = errors.New("Data penjualan belum dapat diproses; simpan catatan asli. Jika pembayaran sudah diterima, jangan tagih ulang")

func saleInputError(field, reason string) error {
	return fmt.Errorf("%w: %s %s", ErrSaleInput, field, reason)
}

// Distinguish a real free line (explicit zero) from absent/null monetary data.
// Optional legacy adjustment fields remain nullable on CreateOrderInput's callers.
func (it *OrderItem) UnmarshalJSON(data []byte) error {
	type wireItem OrderItem
	var decoded wireItem
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, field := range []string{"price", "quantity", "subtotal"} {
		v, ok := fields[field]
		if !ok || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return saleInputError("items."+field, "wajib berupa angka")
		}
	}
	*it = OrderItem(decoded)
	return nil
}

func saleMoney(field string, value float64) error {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > maxSaleMoney {
		return saleInputError(field, "di luar rentang angka yang didukung")
	}
	return nil
}

// validateSaleItems checks numeric domains both before and after the existing
// reward resolvers. Captured lines use raw-cent or whole-rupiah line rounding;
// resolved bundles may store a rounded average unit price and allocated subtotal.
// Only that server-derived phase omits price*quantity equality.
func validateSaleItems(items []OrderItem, captured bool) error {
	var subtotal float64
	for i, it := range items {
		field := fmt.Sprintf("items[%d]", i)
		if it.Quantity <= 0 || int64(it.Quantity) > math.MaxInt32 {
			return saleInputError(field+".quantity", "harus bilangan bulat positif dalam rentang integer")
		}
		if err := saleMoney(field+".price", it.Price); err != nil {
			return err
		}
		if err := saleMoney(field+".subtotal", it.Subtotal); err != nil {
			return err
		}
		product := it.Price * float64(it.Quantity)
		if captured {
			if err := saleMoney(field+".price*quantity", product); err != nil {
				return err
			}
			// Compare representable cents, tolerating only floating-point noise.
			// This uses the captured unit price, never today's catalog price.
			cents := math.Round(it.Subtotal * 100)
			if cents != math.Round(product*100) && cents != math.Round(product)*100 {
				return saleInputError(field+".subtotal", "tidak sesuai harga dan jumlah yang dicatat")
			}
		}
		subtotal += it.Subtotal
		if err := saleMoney("items.subtotal.sum", subtotal); err != nil {
			return err
		}
	}
	return nil
}

// ValidateSaleInput validates captured values without consulting current prices,
// stock or caller-supplied authority flags. It does not prove payment or entitlement.
func ValidateSaleInput(in CreateOrderInput) error {
	if len(in.Items) == 0 {
		return ErrNoItems
	}
	if err := validateSaleItems(in.Items, true); err != nil {
		return err
	}
	for _, value := range []struct {
		field string
		value float64
	}{
		{"amountPaid", in.AmountPaid}, {"discountValue", in.ManualValue}, {"surchargeValue", in.Surcharge},
	} {
		if err := saleMoney(value.field, value.value); err != nil {
			return err
		}
	}
	if in.PointsRedeemed < 0 || int64(in.PointsRedeemed) > math.MaxInt32 {
		return saleInputError("pointsRedeemed", "di luar rentang integer nonnegatif")
	}
	// Methods are free-form configured IDs (migration 0005), not a closed enum.
	if strings.TrimSpace(in.PaymentMethod) == "" {
		return saleInputError("paymentMethod", "wajib diisi")
	}
	return nil
}

func validateSalePricing(res PricingResult) error {
	// Intermediate discount contributions may exceed subtotal and are capped by
	// Compute. Preserve that behavior, but never allow non-finite arithmetic to be
	// hidden by the cap. Persisted money fields below use numeric(14,2)'s range.
	for _, v := range []float64{res.ManualDiscount, res.PromoDiscount, res.ManualDiscount + res.PromoDiscount} {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return saleInputError("discountCalculation", "tidak valid")
		}
	}
	for _, value := range []struct {
		field string
		value float64
	}{
		{"subtotal", res.Subtotal}, {"discountAmount", res.DiscountAmount},
		{"taxableAmount", res.TaxableAmount}, {"taxAmount", res.TaxAmount},
		{"surchargeAmount", res.SurchargeAmount}, {"total", res.Total},
	} {
		if err := saleMoney(value.field, value.value); err != nil {
			return err
		}
	}
	return salePoints("earnedPoints", float64(res.EarnedPoints))
}

func salePoints(field string, value float64) error {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > math.MaxInt32 {
		return saleInputError(field, "di luar rentang integer nonnegatif")
	}
	return nil
}
