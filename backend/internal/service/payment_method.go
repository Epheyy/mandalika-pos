package service

import (
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
)

// IsCashMethod reports whether a payment method id puts money in the cash drawer.
// A configured entry (case-insensitive id match) with an explicit isCash flag
// decides, including an explicit false. Otherwise the id default applies, which
// also covers ids missing from the config: "cash" and "tunai" are cash.
func IsCashMethod(methods []api.PaymentMethodConfig, id string) bool {
	for _, m := range methods {
		if !strings.EqualFold(strings.TrimSpace(m.Id), strings.TrimSpace(id)) {
			continue
		}
		if v, err := m.IsCash.Get(); err == nil {
			return v
		}
		break
	}
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "cash", "tunai":
		return true
	}
	return false
}
