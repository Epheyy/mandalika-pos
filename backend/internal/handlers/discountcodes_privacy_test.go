package handlers

import (
	"strings"
	"testing"
)

// The discount-code list is cached per outlet; a holder of manage_promotions sees
// customer names and everyone else must not be served that cached body (A30).
func TestDiscountCodesCacheKeyDiffersByPermission(t *testing.T) {
	withPerm := discountCodesCacheKey(scopeReq("manager", "manage_promotions"))
	without := discountCodesCacheKey(scopeReq("cashier", "create_order"))
	if withPerm == without {
		t.Fatalf("keys must differ by manage_promotions: %q", withPerm)
	}
	// Admin holds every permission implicitly: privileged suffix (its outlet part may differ).
	if admin := discountCodesCacheKey(scopeReq("admin")); !strings.HasSuffix(admin, ":p=1") {
		t.Errorf("admin must use the privileged key: %q", admin)
	}
	if again := discountCodesCacheKey(scopeReq("cashier", "create_order")); again != without {
		t.Errorf("key must be stable: %q vs %q", again, without)
	}
}
