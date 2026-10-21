package service

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
)

// appSettings is the slice of app_settings an order needs: pricing switches and
// the configured payment methods (for the cash/non-cash decision).
type appSettings struct {
	TaxEnabled      bool
	TaxRate         float64
	RoundingEnabled bool
	RoundingType    string
	PaymentMethods  []api.PaymentMethodConfig
}

func loadAppSettings(ctx context.Context, tx pgx.Tx) (appSettings, error) {
	var a appSettings
	var methods []byte
	err := tx.QueryRow(ctx,
		`SELECT tax_enabled, tax_rate, rounding_enabled, rounding_type, payment_methods
		   FROM app_settings WHERE id=1`).Scan(&a.TaxEnabled, &a.TaxRate, &a.RoundingEnabled, &a.RoundingType, &methods)
	if err != nil {
		return a, err
	}
	a.PaymentMethods = parsePaymentMethods(methods)
	return a, nil
}

// parsePaymentMethods is tolerant: a malformed stored value must not stop sales,
// it just falls back to the id defaults in IsCashMethod. Writes are validated.
func parsePaymentMethods(raw []byte) []api.PaymentMethodConfig {
	if len(raw) == 0 {
		return nil
	}
	var methods []api.PaymentMethodConfig
	if err := json.Unmarshal(raw, &methods); err != nil {
		slog.Warn("payment_methods decode failed; using id defaults", "err", err)
		return nil
	}
	return methods
}
