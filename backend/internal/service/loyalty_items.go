package service

// loyaltyProductSet builds the product / variant key set the loyalty conditions
// (SP-CRM-8/9b) match against. Free reward lines and Diskon Bundle pieces are left
// out: a reward must not trigger more conditions, and a bundle piece is part of a
// set price, not an individually bought product (same rule as product-keyed
// promotions). Earned points are unaffected: they stay on what was paid.
func loyaltyProductSet(items []OrderItem) map[string]bool {
	set := make(map[string]bool, len(items)*2)
	for _, it := range items {
		if it.IsReward || it.BundleGroup > 0 || it.BundleRole != "" {
			continue
		}
		set[it.ProductID] = true
		if it.VariantSize != "" {
			set[variantKey(it.ProductID, it.VariantSize)] = true // variant-level trigger entries (SP-CRM-9b)
		}
	}
	return set
}
