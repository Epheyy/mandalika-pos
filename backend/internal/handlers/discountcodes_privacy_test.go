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

// /orders is cached too, and its q result depends on customerScope: a manager's
// customer-name hit must never be served to a cashier at the same outlet (A30).
func TestOrdersCacheKeyDiffersByCustomerScope(t *testing.T) {
	all := ordersCacheKey(scopeReq("manager", "manage_customers"))
	phoneOnly := ordersCacheKey(scopeReq("cashier", "manage_customers"))
	if all == phoneOnly {
		t.Fatalf("keys must differ by customer scope: %q", all)
	}
	if mgrNo := ordersCacheKey(scopeReq("manager", "view_reports")); mgrNo != phoneOnly {
		t.Errorf("phone-only callers share one key: %q vs %q", mgrNo, phoneOnly)
	}
}
