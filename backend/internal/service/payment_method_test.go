package service

import (
	"testing"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/oapi-codegen/nullable"
)

func TestIsCashMethod(t *testing.T) {
	flag := func(id string, v bool) api.PaymentMethodConfig {
		return api.PaymentMethodConfig{Id: id, IsCash: nullable.NewNullableWithValue(v)}
	}
	unset := func(id string) api.PaymentMethodConfig { return api.PaymentMethodConfig{Id: id} }
	null := func(id string) api.PaymentMethodConfig {
		return api.PaymentMethodConfig{Id: id, IsCash: nullable.NewNullNullable[bool]()}
	}
	cases := []struct {
		name    string
		methods []api.PaymentMethodConfig
		id      string
		want    bool
	}{
		{"no config cash", nil, "cash", true},
		{"no config tunai", nil, "tunai", true},
		{"no config TUNAI padded", nil, " TUNAI ", true},
		{"no config qris", nil, "qris", false},
		{"no config custom", nil, "kas_kecil", false},
		{"unset flag uses default tunai", []api.PaymentMethodConfig{unset("tunai")}, "tunai", true},
		{"null flag uses default", []api.PaymentMethodConfig{null("tunai")}, "tunai", true},
		{"null flag custom stays non-cash", []api.PaymentMethodConfig{null("bca")}, "bca", false},
		{"explicit true custom", []api.PaymentMethodConfig{flag("kas_kecil", true)}, "kas_kecil", true},
		{"explicit true matches case-insensitively", []api.PaymentMethodConfig{flag("Kas_Kecil", true)}, "kas_kecil", true},
		{"explicit false beats tunai default", []api.PaymentMethodConfig{flag("tunai", false)}, "tunai", false},
		{"explicit false beats cash default", []api.PaymentMethodConfig{flag("cash", false)}, "CASH", false},
		{"cash absent from config is still cash", []api.PaymentMethodConfig{flag("kas_kecil", true)}, "cash", true},
		{"other entries do not leak", []api.PaymentMethodConfig{flag("tunai", false)}, "cash", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsCashMethod(c.methods, c.id); got != c.want {
				t.Fatalf("IsCashMethod(%q)=%v want %v", c.id, got, c.want)
			}
		})
	}
}
