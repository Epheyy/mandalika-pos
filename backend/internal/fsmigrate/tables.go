package fsmigrate

// Per-collection upserts. Every statement is ON CONFLICT idempotent so a
// re-run (or a resumed cutover) converges instead of duplicating. Child tables
// (variants, items, permissions) are delete+reinsert per parent so an updated
// parent never leaves orphan children.

import "github.com/google/uuid"

func (m *mig) outlets(ds []doc) {
	m.input("outlets", len(ds))
	for _, d := range ds {
		oid := id("outlets", docID(d))
		m.exec(`INSERT INTO outlets (id,name,address,phone,is_active,created_at)
		        VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, address=EXCLUDED.address,
		          phone=EXCLUDED.phone, is_active=EXCLUDED.is_active`,
			oid, reqStr(d, "name", "Outlet"), str(d, "address"), str(d, "phone"),
			d["isActive"] != false, ts(d, "createdAt"))
		m.count("outlets", 1)
	}
}

func (m *mig) categories(ds []doc) {
	m.input("categories", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO categories (id,name,description,sort_order)
		        VALUES ($1,$2,$3,$4)
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, description=EXCLUDED.description,
		          sort_order=EXCLUDED.sort_order`,
			id("categories", docID(d)), reqStr(d, "name", "Uncategorized"),
			str(d, "description"), intv(d, "sortOrder"))
		m.count("categories", 1)
	}
}

func (m *mig) products(ds []doc) {
	m.input("products", len(ds))
	for _, d := range ds {
		pid := id("products", docID(d))
		m.exec(`INSERT INTO products
		          (id,name,brand,category_id,description,image_url,
		           is_featured,is_favourite,is_active,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, brand=EXCLUDED.brand,
		          category_id=EXCLUDED.category_id, description=EXCLUDED.description,
		          image_url=EXCLUDED.image_url, is_featured=EXCLUDED.is_featured,
		          is_favourite=EXCLUDED.is_favourite, is_active=EXCLUDED.is_active`,
			pid, reqStr(d, "name", "Product"), reqStr(d, "brand", ""),
			fk("categories", d["categoryId"]), str(d, "description"),
			str(d, "imageUrl"), boolv(d, "isFeatured"), boolv(d, "isFavourite"),
			d["isActive"] != false, ts(d, "createdAt"))
		m.count("products", 1)

		// variants[] → product_variants (deterministic id per size).
		m.exec(`DELETE FROM product_variants WHERE product_id=$1`, pid)
		for _, v := range items(d, "variants") {
			size := reqStr(v, "size", "default")
			m.exec(`INSERT INTO product_variants
			          (id,product_id,size,price,stock,sku)
			        VALUES ($1,$2,$3,$4,$5,$6)`,
				uuid.NewSHA1(nsUUID, []byte("variant:"+docID(d)+":"+size)),
				pid, size, num(v, "price"), intv(v, "stock"), reqStr(v, "sku", ""))
			m.count("product_variants", 1)
		}
	}
}

func (m *mig) bundles(ds []doc) {
	m.input("bundles", len(ds))
	for _, d := range ds {
		bid := id("bundles", docID(d))
		m.exec(`INSERT INTO bundles (id,name,description,price,image_url,is_active,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, description=EXCLUDED.description,
		          price=EXCLUDED.price, image_url=EXCLUDED.image_url,
		          is_active=EXCLUDED.is_active`,
			bid, reqStr(d, "name", "Bundle"), str(d, "description"),
			num(d, "price"), str(d, "imageUrl"), d["isActive"] != false,
			ts(d, "createdAt"))
		m.count("bundles", 1)

		m.exec(`DELETE FROM bundle_items WHERE bundle_id=$1`, bid)
		for i, it := range items(d, "items") {
			m.exec(`INSERT INTO bundle_items
			          (id,bundle_id,product_id,product_name,variant_size,quantity,price)
			        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				uuid.NewSHA1(nsUUID, []byte(fmtIdx("bitem", docID(d), i))),
				bid, fkReq("products", it["productId"]),
				reqStr(it, "productName", ""), reqStr(it, "variantSize", ""),
				intv(it, "quantity"), num(it, "price"))
			m.count("bundle_items", 1)
		}
	}
}

func (m *mig) customers(ds []doc) {
	m.input("customers", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO customers
		          (id,name,phone,email,points,total_spent,visit_count,last_visit,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, phone=EXCLUDED.phone, email=EXCLUDED.email,
		          points=EXCLUDED.points, total_spent=EXCLUDED.total_spent,
		          visit_count=EXCLUDED.visit_count, last_visit=EXCLUDED.last_visit`,
			id("customers", docID(d)), reqStr(d, "name", "Customer"),
			reqStr(d, "phone", ""), str(d, "email"), intv(d, "points"),
			num(d, "totalSpent"), intv(d, "visitCount"), ts(d, "lastVisit"),
			ts(d, "createdAt"))
		m.count("customers", 1)
	}
}

func (m *mig) loyaltySettings(s map[string]any) {
	if s == nil {
		return
	}
	m.exec(`UPDATE loyalty_settings SET
	          enabled=$1, tier_enabled=$2, points_per_thousand=$3, redemption_rate=$4
	        WHERE id=1`,
		boolv(s, "enabled"), boolv(s, "tierEnabled"),
		num(s, "pointsPerThousand"), num(s, "redemptionRate"))
	m.count("loyalty_settings", 1)
}

func (m *mig) loyaltyConditions(ds []doc) {
	m.input("loyaltyConditions", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO loyalty_conditions
		          (id,name,type,trigger,reward_type,reward_value,reward_product_ids,
		           campaign_start_date,campaign_end_date,active_days,
		           applicable_product_ids,minimum_spend,is_active,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, type=EXCLUDED.type, trigger=EXCLUDED.trigger,
		          reward_type=EXCLUDED.reward_type, reward_value=EXCLUDED.reward_value,
		          reward_product_ids=EXCLUDED.reward_product_ids,
		          campaign_start_date=EXCLUDED.campaign_start_date,
		          campaign_end_date=EXCLUDED.campaign_end_date,
		          active_days=EXCLUDED.active_days,
		          applicable_product_ids=EXCLUDED.applicable_product_ids,
		          minimum_spend=EXCLUDED.minimum_spend, is_active=EXCLUDED.is_active`,
			id("loyaltyConditions", docID(d)), reqStr(d, "name", ""),
			reqStr(d, "type", "always_on"), reqStr(d, "trigger", ""),
			reqStr(d, "rewardType", "set_points"), num(d, "rewardValue"),
			jsonbOrNil(d, "rewardProductIds"), str(d, "campaignStartDate"),
			str(d, "campaignEndDate"), jsonbOrNil(d, "activeDays"),
			jsonbOrNil(d, "applicableProductIds"), nullNum(d, "minimumSpend"),
			d["isActive"] != false, ts(d, "createdAt"))
		m.count("loyalty_conditions", 1)
	}
}

func (m *mig) promotions(ds []doc) {
	m.input("promotions", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO promotions
		          (id,name,description,type,value,min_purchase,applicable_product_ids,
		           applicable_variant_keys,applicable_variant_sizes,outlet_ids,
		           combinable,combinable_with,active_from_hour,active_to_hour,
		           active_days,is_active,start_date,end_date,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, description=EXCLUDED.description,
		          type=EXCLUDED.type, value=EXCLUDED.value,
		          min_purchase=EXCLUDED.min_purchase,
		          applicable_product_ids=EXCLUDED.applicable_product_ids,
		          applicable_variant_keys=EXCLUDED.applicable_variant_keys,
		          applicable_variant_sizes=EXCLUDED.applicable_variant_sizes,
		          outlet_ids=EXCLUDED.outlet_ids, combinable=EXCLUDED.combinable,
		          combinable_with=EXCLUDED.combinable_with,
		          active_from_hour=EXCLUDED.active_from_hour,
		          active_to_hour=EXCLUDED.active_to_hour,
		          active_days=EXCLUDED.active_days, is_active=EXCLUDED.is_active,
		          start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date`,
			id("promotions", docID(d)), reqStr(d, "name", ""),
			str(d, "description"), reqStr(d, "type", "percentage"),
			num(d, "value"), nullNum(d, "minPurchase"),
			jsonbOrNil(d, "applicableProductIds"),
			jsonbOrNil(d, "applicableVariantKeys"),
			jsonbOrNil(d, "applicableVariantSizes"), jsonbOrNil(d, "outletIds"),
			d["combinable"], jsonbOrNil(d, "combinableWith"),
			str(d, "activeFromHour"), str(d, "activeToHour"),
			jsonbOrNil(d, "activeDays"), d["isActive"] != false,
			str(d, "startDate"), str(d, "endDate"), ts(d, "createdAt"))
		m.count("promotions", 1)
	}
}

func (m *mig) discountCodes(ds []doc) {
	m.input("discountCodes", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO discount_codes
		          (id,code,promotion_id,type,value,min_purchase,usage_limit,
		           usage_count,is_active,start_date,end_date,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          code=EXCLUDED.code, promotion_id=EXCLUDED.promotion_id,
		          type=EXCLUDED.type, value=EXCLUDED.value,
		          min_purchase=EXCLUDED.min_purchase,
		          usage_limit=EXCLUDED.usage_limit, usage_count=EXCLUDED.usage_count,
		          is_active=EXCLUDED.is_active, start_date=EXCLUDED.start_date,
		          end_date=EXCLUDED.end_date`,
			id("discountCodes", docID(d)), reqStr(d, "code", docID(d)),
			fk("promotions", d["promotionId"]), reqStr(d, "type", "percentage"),
			num(d, "value"), nullNum(d, "minPurchase"),
			nullInt(d, "usageLimit"), intv(d, "usageCount"),
			d["isActive"] != false, str(d, "startDate"), str(d, "endDate"),
			ts(d, "createdAt"))
		m.count("discount_codes", 1)
	}
}

func (m *mig) customRoles(ds []doc) {
	m.input("customRoles", len(ds))
	for _, d := range ds {
		rid := id("customRoles", docID(d))
		m.exec(`INSERT INTO custom_roles (id,name,created_at)
		        VALUES ($1,$2,COALESCE($3,now()))
		        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
			rid, reqStr(d, "name", "Role"), ts(d, "createdAt"))
		m.count("custom_roles", 1)
		m.exec(`DELETE FROM custom_role_permissions WHERE role_id=$1`, rid)
		for _, p := range strSlice(d, "permissions") {
			m.exec(`INSERT INTO custom_role_permissions (role_id,permission)
			        VALUES ($1,$2) ON CONFLICT DO NOTHING`, rid, p)
			m.count("custom_role_permissions", 1)
		}
	}
}

func (m *mig) users(ds []doc) {
	m.input("users", len(ds))
	for _, d := range ds {
		uid := id("users", docID(d))
		role := reqStr(d, "role", "cashier")
		if role != "admin" && role != "manager" && role != "cashier" {
			m.warn("user %s: unknown role %q → coerced to cashier",
				reqStr(d, "email", docID(d)), role)
			role = "cashier"
		}
		var outletID *uuid.UUID
		if s, _ := d["outletId"].(string); s != "" && s != "default" {
			o := id("outlets", s)
			outletID = &o
		}
		m.exec(`INSERT INTO users
		          (id,email,password_hash,display_name,role,outlet_id,photo_url,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          email=EXCLUDED.email, display_name=EXCLUDED.display_name,
		          role=EXCLUDED.role, outlet_id=EXCLUDED.outlet_id,
		          photo_url=EXCLUDED.photo_url,
		          perm_version=users.perm_version+1`,
			uid, reqStr(d, "email", docID(d)+"@migrated.local"),
			firebaseMigratedHash, reqStr(d, "displayName", "User"),
			role, outletID, str(d, "photoURL"), ts(d, "createdAt"))
		m.count("users", 1)

		m.exec(`DELETE FROM user_permissions WHERE user_id=$1`, uid)
		for _, p := range strSlice(d, "permissions") {
			m.exec(`INSERT INTO user_permissions (user_id,permission)
			        VALUES ($1,$2) ON CONFLICT DO NOTHING`, uid, p)
			m.count("user_permissions", 1)
		}
	}
	if len(ds) > 0 {
		m.warn("%d users migrated with an unusable password hash — admins must "+
			"re-provision / password-reset (Firebase auth had no passwords)", len(ds))
	}
}

func (m *mig) shifts(ds []doc) {
	m.input("shifts", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO shifts
		          (id,outlet_id,outlet_name,cashier_id,cashier_name,status,
		           opened_at,closed_at,starting_cash,closing_cash,total_sales,
		           total_orders,total_refunds,cash_sales,card_sales,
		           transfer_sales,qris_sales)
		        VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		        ON CONFLICT (id) DO UPDATE SET
		          status=EXCLUDED.status, closed_at=EXCLUDED.closed_at,
		          closing_cash=EXCLUDED.closing_cash, total_sales=EXCLUDED.total_sales,
		          total_orders=EXCLUDED.total_orders, total_refunds=EXCLUDED.total_refunds,
		          cash_sales=EXCLUDED.cash_sales, card_sales=EXCLUDED.card_sales,
		          transfer_sales=EXCLUDED.transfer_sales, qris_sales=EXCLUDED.qris_sales`,
			id("shifts", docID(d)), m.resolveOutlet(d["outletId"]),
			str(d, "outletName"), fkReq("users", d["cashierId"]),
			reqStr(d, "cashierName", ""), reqStr(d, "status", "closed"),
			ts(d, "openedAt"), ts(d, "closedAt"), num(d, "startingCash"),
			nullNum(d, "closingCash"), num(d, "totalSales"),
			intv(d, "totalOrders"), num(d, "totalRefunds"), num(d, "cashSales"),
			num(d, "cardSales"), num(d, "transferSales"), num(d, "qrisSales"))
		m.count("shifts", 1)
	}
}

func (m *mig) orders(ds []doc) {
	m.input("orders", len(ds))
	for _, d := range ds {
		oid := id("orders", docID(d))
		ouid := uuid.NewSHA1(nsUUID, []byte("order_uuid:"+docID(d)))
		m.exec(`INSERT INTO orders
		          (id,order_number,order_uuid,idempotency_key,device_id,outlet_id,
		           cashier_id,cashier_name,salesman_id,salesman_name,customer_id,
		           customer_name,subtotal,discount_amount,discount_type,discount_value,
		           discount_code,tax_amount,total,payment_method,amount_paid,change,
		           status,notes,refund_reason,refunded_at,shift_id,client_created_at,
		           created_at)
		        VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
		                $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,COALESCE($28,now()))
		        ON CONFLICT (idempotency_key) DO UPDATE SET
		          status=EXCLUDED.status, total=EXCLUDED.total,
		          refund_reason=EXCLUDED.refund_reason, refunded_at=EXCLUDED.refunded_at`,
			oid, reqStr(d, "orderNumber", docID(d)), ouid, "legacy:"+docID(d),
			m.resolveOutlet(d["outletId"]), fkReq("users", d["cashierId"]),
			reqStr(d, "cashierName", ""), fk("users", d["salesmanId"]),
			str(d, "salesmanName"), fk("customers", d["customerId"]),
			str(d, "customerName"), num(d, "subtotal"), num(d, "discountAmount"),
			str(d, "discountType"), nullNum(d, "discountValue"),
			str(d, "discountCode"), num(d, "taxAmount"), num(d, "total"),
			reqStr(d, "paymentMethod", "cash"), num(d, "amountPaid"),
			num(d, "change"), reqStr(d, "status", "completed"), str(d, "notes"),
			str(d, "refundReason"), ts(d, "refundedAt"),
			fk("shifts", d["shiftId"]), ts(d, "createdAt"), ts(d, "createdAt"))
		m.count("orders", 1)

		m.exec(`DELETE FROM order_items WHERE order_id=$1`, oid)
		for i, it := range items(d, "items") {
			m.exec(`INSERT INTO order_items
			          (id,order_id,product_id,product_name,variant_size,price,
			           quantity,subtotal,is_bundle)
			        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				uuid.NewSHA1(nsUUID, []byte(fmtIdx("oitem", docID(d), i))),
				oid, fkReq("products", it["productId"]),
				reqStr(it, "productName", ""), reqStr(it, "variantSize", ""),
				num(it, "price"), intv(it, "quantity"), num(it, "subtotal"),
				boolv(it, "isBundle"))
			m.count("order_items", 1)
		}
	}
}

func (m *mig) stockCounts(ds []doc) {
	m.input("stockCounts", len(ds))
	for _, d := range ds {
		sid := id("stockCounts", docID(d))
		m.exec(`INSERT INTO stock_counts
		          (id,name,status,outlet_id,planned_date,started_at,completed_at,
		           notes,created_by,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now()))
		        ON CONFLICT (id) DO UPDATE SET
		          name=EXCLUDED.name, status=EXCLUDED.status,
		          started_at=EXCLUDED.started_at, completed_at=EXCLUDED.completed_at,
		          notes=EXCLUDED.notes`,
			sid, reqStr(d, "name", "Stock Count"),
			reqStr(d, "status", "planned"), m.resolveOutlet(d["outletId"]),
			str(d, "plannedDate"), ts(d, "startedAt"), ts(d, "completedAt"),
			str(d, "notes"), fk("users", d["createdBy"]), ts(d, "createdAt"))
		m.count("stock_counts", 1)

		m.exec(`DELETE FROM stock_count_items WHERE stock_count_id=$1`, sid)
		for i, it := range items(d, "items") {
			m.exec(`INSERT INTO stock_count_items
			          (id,stock_count_id,product_id,product_name,variant_size,sku,
			           frozen_qty,actual_qty,difference)
			        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				uuid.NewSHA1(nsUUID, []byte(fmtIdx("scitem", docID(d), i))),
				sid, fkReq("products", it["productId"]),
				reqStr(it, "productName", ""), reqStr(it, "variantSize", ""),
				reqStr(it, "sku", ""), intv(it, "frozenQty"),
				nullInt(it, "actualQty"), nullInt(it, "difference"))
			m.count("stock_count_items", 1)
		}
	}
}

func (m *mig) cashFlows(ds []doc) {
	m.input("cashFlows", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO cash_flows
		          (id,outlet_id,shift_id,type,amount,description,cashier_id,
		           cashier_name,created_at)
		        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now()))
		        ON CONFLICT (id) DO NOTHING`,
			id("cashFlows", docID(d)), m.resolveOutlet(d["outletId"]),
			fk("shifts", d["shiftId"]), reqStr(d, "type", "in"),
			num(d, "amount"), reqStr(d, "description", ""),
			fk("users", d["cashierId"]), str(d, "cashierName"),
			ts(d, "createdAt"))
		m.count("cash_flows", 1)
	}
}

func (m *mig) syncLogs(ds []doc) {
	m.input("syncLogs", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO sync_logs (id,outlet_id,cashier_id,cashier_name,synced_at,counts)
		        VALUES ($1,$2,$3,$4,COALESCE($5,now()),$6)
		        ON CONFLICT (id) DO NOTHING`,
			id("syncLogs", docID(d)), nullOutlet(d["outletId"]),
			fk("users", d["cashierId"]), str(d, "cashierName"),
			ts(d, "syncedAt"), jsonbOrNil(d, "counts"))
		m.count("sync_logs", 1)
	}
}

func (m *mig) devices(ds []doc) {
	m.input("devices", len(ds))
	for _, d := range ds {
		m.exec(`INSERT INTO devices (id,outlet_id,label,last_seen)
		        VALUES ($1,$2,$3,$4)
		        ON CONFLICT (id) DO UPDATE SET
		          label=EXCLUDED.label, last_seen=EXCLUDED.last_seen`,
			id("devices", docID(d)), nullOutlet(d["outletId"]),
			reqStr(d, "label", ""), ts(d, "lastSeen"))
		m.count("devices", 1)
	}
}

func (m *mig) appSettings(s map[string]any) {
	if s == nil {
		return
	}
	m.exec(`UPDATE app_settings SET
	          tax_enabled=$1, tax_rate=$2, rounding_enabled=$3, rounding_type=$4,
	          rounding_amount=$5, rounding_direction=$6, rounding_apply_to_tax=$7,
	          auto_open_shift=$8, payment_methods=COALESCE($9,'[]'::jsonb),
	          receipt=COALESCE($10,'{}'::jsonb)
	        WHERE id=1`,
		boolv(s, "taxEnabled"), num(s, "taxRate"), boolv(s, "roundingEnabled"),
		reqStr(s, "roundingType", "none"), nullNum(s, "roundingAmount"),
		str(s, "roundingDirection"), s["roundingApplyToTax"],
		boolv(s, "autoOpenShift"), jsonbOrNil(s, "paymentMethods"),
		jsonbOrNil(s, "receipt"))
	m.count("app_settings", 1)
}

// ── small helpers used only by upserts ─────────────────────────

func fmtIdx(prefix, parent string, i int) string {
	return prefix + ":" + parent + ":" + itoa(i)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	p := len(b)
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	return string(b[p:])
}

// fkReq is for NOT NULL FK columns (cashier_id, order_items.product_id): a
// deterministic uuid is always produced even if the source string is blank, so
// the row still inserts (orphan flagged for admin reconciliation, never lost).
func fkReq(collection string, raw any) uuid.UUID {
	s, _ := raw.(string)
	return id(collection, s)
}

func nullOutlet(raw any) *uuid.UUID {
	s, _ := raw.(string)
	if s == "" || s == "default" {
		return nil
	}
	u := id("outlets", s)
	return &u
}

func nullNum(d doc, k string) any {
	if _, ok := d[k]; !ok || d[k] == nil {
		return nil
	}
	return num(d, k)
}

func nullInt(d doc, k string) any {
	if _, ok := d[k]; !ok || d[k] == nil {
		return nil
	}
	return intv(d, k)
}
