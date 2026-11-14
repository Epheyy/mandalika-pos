package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/mandalika/pos-backend/internal/apperr"
	"github.com/mandalika/pos-backend/internal/bundles"
	"math"
	"strings"
	"time"
)

// Limits are PostgreSQL numeric(14,2) money and integer quantities/points,
// not business spending caps. Decimal input remains supported by the schema.
const maxSaleMoney = 999_999_999_999.99

var ErrSaleInput = apperr.New(apperr.Rejected, "Data penjualan belum dapat diproses; simpan catatan asli. Jika pembayaran sudah diterima, jangan tagih ulang")

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
	// A synced (offline) sale already happened: a bad bundle field never rejects it. The sale path
	// strips the bundle fields and flags it instead (sanitizeOfflineBundleFields).
	if !in.Offline {
		if err := validateBundleFields(in.Items); err != nil {
			return err
		}
	}
	_, hasTenders, err := parseTenders(in.Tenders)
	if err != nil {
		return err
	}
	moneyFields := []struct {
		field string
		value float64
	}{{"discountValue", in.ManualValue}, {"surchargeValue", in.Surcharge}}
	if !hasTenders { // with tenders the scalar summary is ignored
		moneyFields = append(moneyFields, struct {
			field string
			value float64
		}{"amountPaid", in.AmountPaid})
	}
	for _, value := range moneyFields {
		if err := saleMoney(value.field, value.value); err != nil {
			return err
		}
	}
	if in.PointsRedeemed < 0 || int64(in.PointsRedeemed) > math.MaxInt32 {
		return saleInputError("pointsRedeemed", "di luar rentang integer nonnegatif")
	}
	if err := validateReplacementFields(in); err != nil {
		return err
	}
	// Methods are free-form configured IDs (migration 0005), not a closed enum.
	if hasTenders {
		return nil
	}
	if strings.TrimSpace(in.PaymentMethod) == "" {
		return saleInputError("paymentMethod", "wajib diisi")
	}
	// The reserved split sentinel is only valid with tenders; without them it would
	// reach the order_tenders CHECK inside the transaction (a 500, endless batch retry).
	if isSplitID(in.PaymentMethod) {
		return saleInputError("paymentMethod", "split memerlukan daftar pembayaran")
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

// validateBundleFields is the structural check of the bundle fields on sale lines. Whether the
// three pieces really form a valid bundle is semantic and decided by resolveSetBundles.
func validateBundleFields(items []OrderItem) error {
	for i, it := range items {
		field := fmt.Sprintf("items[%d]", i)
		if it.BundleGroup < 0 || it.BundleGroup > 32767 {
			return saleInputError(field+".bundleGroup", "harus 1 sampai 32767")
		}
		if it.BundleGroup == 0 {
			if it.BundleRole != "" {
				return saleInputError(field+".bundleRole", "hanya boleh diisi pada baris bundle")
			}
			if it.BundlePrice != 0 || it.BundleBasisPrice != 0 {
				return saleInputError(field+".bundlePrice", "hanya boleh diisi pada baris bundle")
			}
			continue
		}
		switch it.BundleRole {
		case "large", "atomizer", "vial":
		default:
			return saleInputError(field+".bundleRole", "harus large, atomizer atau vial")
		}
		if it.Quantity != 1 {
			return saleInputError(field+".quantity", "baris bundle harus berjumlah 1")
		}
		if it.IsReward {
			return saleInputError(field+".isReward", "tidak boleh pada baris bundle")
		}
		if it.IsBundle {
			return saleInputError(field+".isBundle", "tidak boleh pada baris bundle")
		}
		for _, m := range []struct {
			name string
			v    float64
		}{{"bundlePrice", it.BundlePrice}, {"bundleBasisPrice", it.BundleBasisPrice}} {
			if err := saleMoney(field+"."+m.name, m.v); err != nil {
				return err
			}
			// Fractional rupiah (a numeric(14,2) catalog price) is rounded by the server, not refused.
			if m.v > float64(bundles.MaxBundleMoney) {
				return saleInputError(field+"."+m.name, "melebihi batas yang didukung")
			}
		}
	}
	return nil
}

// validateReplacementFields checks the void-replacement fields (migration 0093). They are set by the
// server's void paths, never trusted from a payload shape: a malformed one is a rejection, not a 500.
func validateReplacementFields(in CreateOrderInput) error {
	if in.ReplacesOrderID != "" {
		if _, err := uuid.Parse(in.ReplacesOrderID); err != nil {
			return saleInputError("replacesOrderId", "bukan UUID yang valid")
		}
	}
	if in.BusinessDate != "" {
		if _, err := time.Parse("2006-01-02", in.BusinessDate); err != nil {
			return saleInputError("businessDate", "harus berformat YYYY-MM-DD")
		}
	}
	if t := in.CorrectionTarget; t != nil && (*t < 0 || float64(*t) > maxSaleMoney) {
		return saleInputError("correctionTarget", "di luar rentang")
	}
	return nil
}
