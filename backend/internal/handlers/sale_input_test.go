package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/service"
	"time"
)

func TestDirectSaleDecodeAndSharedBoundary(t *testing.T) {
	secret := []byte("S0C-SYNTHETIC-TEST-KEY")
	token, err := auth.IssueAccess(secret, time.Hour, "trusted-user", "cashier", "trusted-outlet", []string{"create_order"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, line, extra string
		decoded, allowed  bool
	}{
		{"normal cash", `{"price":100,"quantity":1,"subtotal":100}`, `"amountPaid":100`, true, true},
		{"legacy zero optional adjustments", `{"price":0,"quantity":1,"subtotal":0}`, `"amountPaid":null,"discountValue":null,"pointsRedeemed":null`, true, true},
		{"negative quantity forged authority", `{"price":100,"quantity":-1,"subtotal":100}`, `"Offline":true,"alreadyPaid":true,"role":"admin","CanRefund":true`, true, false},
		{"line mismatch", `{"price":100,"quantity":1,"subtotal":1}`, `"amountPaid":100`, true, false},
		{"fractional", `{"price":100,"quantity":1.5,"subtotal":150}`, `"amountPaid":150`, false, false},
		{"missing price", `{"quantity":1,"subtotal":0}`, `"amountPaid":0`, false, false},
		{"null subtotal", `{"price":0,"quantity":1,"subtotal":null}`, `"amountPaid":0`, false, false},
		{"negative tender", `{"price":100,"quantity":1,"subtotal":100}`, `"amountPaid":-1`, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, accepted := 0, 0
			h := &Handlers{}
			wrapped := mw.RequireAuth(&config.Config{AccessSecret: secret})(mw.RequirePermission("create_order")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				h.createOrder(w, r, func(r *http.Request) (callerID, error) {
					return callerID{userID: r.Context().Value(auth.CtxUserID).(string), outletID: r.Context().Value(auth.CtxOutletID).(string)}, nil
				}, func(_ context.Context, in service.CreateOrderInput) (string, bool, bool, error) {
					calls++
					if in.OutletID != "trusted-outlet" || in.CashierID != "trusted-user" || in.IdempotencyKey != "original-key" || in.Offline {
						t.Fatalf("untrusted mapping: %+v", in)
					}
					if err := service.ValidateSaleInput(in); err != nil {
						return "", false, false, err
					}
					accepted++
					// Stop before DB/readback. This is command mapping, not HTTP success evidence.
					return "", false, false, errors.New("synthetic valid boundary reached")
				})
			})))
			r := httptest.NewRequest("POST", "/orders", strings.NewReader(`{"paymentMethod":"cash","outletId":"forged","cashierId":"forged","items":[`+tc.line+`],`+tc.extra+`}`))
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("Idempotency-Key", "original-key")
			w := httptest.NewRecorder()
			wrapped.ServeHTTP(w, r)
			if (calls == 1) != tc.decoded || (accepted == 1) != tc.allowed || w.Code != 400 {
				t.Fatalf("calls=%d accepted=%d status=%d body=%s", calls, accepted, w.Code, w.Body.String())
			}
			if tc.decoded && !tc.allowed && !strings.Contains(w.Body.String(), service.ErrSaleInput.Error()) {
				t.Fatal(w.Body.String())
			}
		})
	}
}
