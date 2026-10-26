package handlers

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/integration/erp"
	"github.com/mandalika/pos-backend/internal/write"
)

// Mapping v3 guards (sandbox pull report 2026-10-26 §4-§6, owner decisions 2026-10-26).
// Subtests of TestErpIntegrationPostgres (the ER gate runs only that name). The FG rows are
// copied from the production ERP catalog captured on 2026-10-26.

// erPosOutlet inserts a POS-owned outlet with its baseline content_versions row (as
// write.CreateOutlet does); slug "" leaves it unlinked.
func erPosOutlet(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name, code, address, phone, slug string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(ctx, `INSERT INTO outlets (name, code, address, phone, erp_slug)
		VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,'')) RETURNING id::text`, name, code, address, phone, slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO content_versions (outlet_id) VALUES ($1) ON CONFLICT DO NOTHING`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

// erPosVariant is one POS variant; slug "" leaves it unlinked.
type erPosVariant struct{ size, sku, slug string }

// erPosProduct inserts a priced, sellable POS product in category cat (created when
// missing) with the given group key ("" = none) and variants (price 225000, barcode = sku).
func erPosProduct(t *testing.T, ctx context.Context, pool *pgxpool.Pool, name, cat, key string, vs ...erPosVariant) string {
	t.Helper()
	var catID, pid string
	if err := pool.QueryRow(ctx, `WITH ins AS (INSERT INTO categories (name) SELECT $1 WHERE NOT EXISTS
		  (SELECT 1 FROM categories WHERE name=$1) RETURNING id)
		SELECT id::text FROM ins UNION ALL SELECT id::text FROM categories WHERE name=$1`, cat).Scan(&catID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO products (name, brand, category_id, sellable, images, erp_group_key)
		VALUES ($1,'Mandalika',$2,true,'["https://img/x.png"]'::jsonb,NULLIF($3,'')) RETURNING id::text`, name, catID, key).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		if _, err := pool.Exec(ctx, `INSERT INTO product_variants (product_id, size, price, sku, barcode, erp_slug)
			VALUES ($1,$2,225000,$3,$3,NULLIF($4,''))`, pid, v.size, v.sku, v.slug); err != nil {
			t.Fatal(err)
		}
	}
	return pid
}

// erProductRow is everything the pull must leave alone on an existing product.
func erProductRow(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) string {
	t.Helper()
	return erStr(t, ctx, pool, `SELECT p.name||'|'||COALESCE(c.name,'-')||'|'||p.brand||'|'||p.sellable||'|'||p.images::text||'|'||
		(SELECT string_agg(v.size||'='||v.price, ',' ORDER BY v.sku) FROM product_variants v WHERE v.product_id=p.id AND v.price > 0)
		FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=$1`, id)
}

func erV3Subtests(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	// Report §4: NO1 MAN -> LEATHER, UNSTOPPABLE UNISEX -> ATOMIZER, CANVAS BAG renamed
	// "CANVAS BAG MANDALIKA" and re-filed under CANVAS BAG. The POS owns the product fields.
	t.Run("v3-existing-product-fields-are-pos-owned", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		erPosOutlet(t, ctx, pool, "Mandalika PMS", "PMS", "SURABAYA", "0811", "")
		no1 := erPosProduct(t, ctx, pool, "NO1", "MAN", "pos:no1",
			erPosVariant{"10ml ATOMIZER", "A10M-NO1", "a10m-no1"}, erPosVariant{"2ml EXTRAIT DE PARFUM", "V2E-NO1", "v2e-no1"})
		uns := erPosProduct(t, ctx, pool, "UNSTOPPABLE", "UNISEX", "erp:UNS", erPosVariant{"10ml ATOMIZER", "A10M-UNS", "a10m-uns"})
		can := erPosProduct(t, ctx, pool, "CANVAS BAG", "KEMASAN", "erp:KEM-CAN", erPosVariant{"Satuan", "KEM-CAN", "kem-can"})
		want := map[string]string{}
		for _, id := range []string{no1, uns, can} {
			want[id] = erProductRow(t, ctx, pool, id)
		}

		e.fg("a10m-no1", "A10M-NO1", "NO1", "ATOMIZER", 10, "ACTIVE", `,"gender":"MEN"`)
		e.fg("v2e-no1", "V2E-NO1", "NO1", "EXT", 2, "ACTIVE", `,"gender":"MEN"`)
		e.fg("15gl-no1", "15GL-NO1", "NO1", "LEATHER", 15, "ACTIVE", `,"gender":"MEN"`) // sorts first: the old owner
		e.fg("a10m-uns", "A10M-UNS", "UNSTOPPABLE", "ATOMIZER", 10, "ACTIVE", `,"gender":"WOMEN"`)
		e.fg("kem-can", "KEM-CAN", "CANVAS BAG MANDALIKA", "CANVAS BAG", 1, "ACTIVE", `,"gender":"UNISEX","is_others":true,"unit":"Pcs"`)
		for i := 0; i < 2; i++ {
			e.clock.Advance(time.Hour)
			e.mustComplete(erp.ModeFull)
			for id, w := range want {
				erWant(t, "existing product row after full pull", erProductRow(t, ctx, pool, id), w)
			}
		}
		erWantInt(t, "15GL-NO1 joined NO1", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants WHERE erp_slug='15gl-no1' AND product_id=$1`, no1), 1)
		erWantInt(t, "no ERP category created", erCount(t, ctx, pool, `SELECT count(*) FROM categories WHERE name IN ('LEATHER','ATOMIZER','CANVAS BAG','EXT')`), 0)
		erWant(t, "the ERP's view is stored on the variant", erStr(t, ctx, pool,
			`SELECT erp_name||'/'||erp_category FROM product_variants WHERE sku='KEM-CAN'`), "CANVAS BAG MANDALIKA/CANVAS BAG")

		// Later changes in the ERP (rename, re-file, discontinue one size) still never reach the product.
		e.clock.Advance(time.Hour)
		e.fg("a10m-uns", "A10M-UNS", "UNSTOPPABLE NEW", "LEATHER", 10, "ACTIVE", `,"gender":"MEN"`)
		e.fg("v2e-no1", "V2E-NO1", "NO1", "EXT", 2, "DISCONTINUE", `,"gender":"MEN"`)
		e.mustComplete(erp.ModeIncremental)
		erWant(t, "UNSTOPPABLE after an ERP rename", erProductRow(t, ctx, pool, uns), want[uns])
		erWant(t, "NO1 product name and category after a discontinued size",
			erStr(t, ctx, pool, `SELECT p.name||'|'||c.name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=$1`, no1), "NO1|MAN")
	})

	// Report §5: PMS, LWB, MKS lost name, address and phone; 25 outlets were created,
	// 4 of them ONLINE MP-* channels. Outlets are link-only and POS-owned.
	t.Run("v3-outlets-link-only", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		pms := erPosOutlet(t, ctx, pool, "Mandalika PMS", "PMS", "SURABAYA", "0811-1", "")
		bsd := erPosOutlet(t, ctx, pool, "Mandalika BSD", "BSD", "Jakarta", "021-2", "bsd")
		mpd := erPosOutlet(t, ctx, pool, "Online Depok", "MP-DPK", "Depok", "", "")     // a POS code equal to an ONLINE code
		mpk := erPosOutlet(t, ctx, pool, "Old online link", "MPK", "", "", "mp-kemang") // linked before v3
		row := func(id string) string {
			return erStr(t, ctx, pool, `SELECT name||'|'||COALESCE(address,'-')||'|'||COALESCE(phone,'-')||'|'||COALESCE(code,'-')||'|'||is_active
				||'|'||COALESCE(erp_slug,'-')||'|'||COALESCE(erp_code,'-') FROM outlets WHERE id=$1`, id)
		}
		e.outlet("pms", "PMS", "MANDALIKA PAKUWON MALL SURABAYA", "")
		e.outlet("bsd", "BSD", "MANDALIKA AEON BSD", "")
		e.outlet("alsut", "ALSUT", "MANDALIKA ALAM SUTERA", "")
		e.outlet("mp-depok", "MP-DPK", "MARKETPLACE DEPOK", `,"type":"ONLINE"`)
		e.outlet("mp-surabaya-pusat", "MP-SBY", "MARKETPLACE SURABAYA", `,"type":"ONLINE"`)
		e.outlet("mp-kemang", "MP-KMG", "MARKETPLACE KEMANG", `,"type":"ONLINE"`)
		rep := e.mustComplete(erp.ModeFull)

		erWantInt(t, "no outlet created", erCount(t, ctx, pool, `SELECT count(*) FROM outlets`), 4)
		erWant(t, "PMS linked by code, POS fields kept", row(pms), "Mandalika PMS|SURABAYA|0811-1|PMS|true|pms|PMS")
		erWant(t, "BSD (already linked) keeps its POS fields", row(bsd), "Mandalika BSD|Jakarta|021-2|BSD|true|bsd|BSD")
		erWant(t, "an ONLINE channel never links by code", row(mpd), "Online Depok|Depok|-|MP-DPK|true|-|-")
		erWant(t, "an old ONLINE link keeps its POS fields", row(mpk), "Old online link|-|-|MPK|true|mp-kemang|MP-KMG")
		note := e.resource(rep, erp.ResourceOutlets).Error
		for _, s := range []string{"ALSUT", "MANDALIKA ALAM SUTERA", "RETAIL", "MP-DPK", "MP-SBY", "ONLINE"} {
			if !strings.Contains(note, s) {
				t.Fatalf("outlet run note lacks %q: %s", s, note)
			}
		}
		if strings.Contains(note, "item error") {
			t.Fatalf("unlinked outlets must be a note, not item errors: %s", note)
		}

		e.clock.Advance(time.Hour)
		e.outlet("pms", "PMS2", "MANDALIKA PMS RENAMED", `,"address":"JL. X","phone":"999"`)
		e.mustComplete(erp.ModeFull)
		erWant(t, "PMS after an ERP edit: only erp_code follows", row(pms), "Mandalika PMS|SURABAYA|0811-1|PMS|true|pms|PMS2")
		erWantInt(t, "still no outlet created", erCount(t, ctx, pool, `SELECT count(*) FROM outlets`), 4)
	})

	// Owner decision (b): ERP others are their own not-for-sale products, never variants
	// of a priced product; the owner may sell one and the pull never flips it back.
	t.Run("v3-others-not-for-sale", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		outlet := erPosOutlet(t, ctx, pool, "Mandalika PMS", "PMS", "", "", "")
		e.fg("v2e-gor", "V2E-GOR", "GORGEOUS TUBEROSE", "EXT", 2, "ACTIVE", `,"gender":"WOMEN","unit":"Pcs"`)
		e.fg("dw110e-gor", "DW110E-GOR", "GORGEOUS TUBEROSE", "DISPLAY EXT", 110, "ACTIVE", `,"gender":"WOMEN","is_others":true,"unit":"Pcs"`)
		e.fg("ktl-cha", "KTL-CHA", "KERTAS TESTER LANDSCAPE CHAMPION", "KERTAS TESTER LANDSCAPE", 1, "ACTIVE", `,"gender":"MEN","is_others":true,"unit":"Pcs"`)
		e.mustComplete(erp.ModeFull)

		other := func(code string) string {
			return erStr(t, ctx, pool, `SELECT p.name||'|'||c.name||'|'||p.sellable||'|'||p.erp_group_key||'|'||v.size||'|'||v.price||'|'||
				(SELECT count(*) FROM product_variants x WHERE x.product_id=p.id)
				FROM product_variants v JOIN products p ON p.id=v.product_id JOIN categories c ON c.id=p.category_id WHERE v.sku=$1`, code)
		}
		erWant(t, "display item", other("DW110E-GOR"), "GORGEOUS TUBEROSE (DW110E-GOR)|ERP: bukan untuk dijual|false|erp:DW110E-GOR|Satuan|0.00|1")
		erWant(t, "tester paper", other("KTL-CHA"), "KERTAS TESTER LANDSCAPE CHAMPION (KTL-CHA)|ERP: bukan untuk dijual|false|erp:KTL-CHA|Satuan|0.00|1")
		erWantInt(t, "the fragrance product holds no others", erCount(t, ctx, pool, `SELECT count(*) FROM product_variants v
			WHERE v.product_id=(SELECT product_id FROM product_variants WHERE sku='V2E-GOR')`), 1)

		// The owner sells the display, prices it and renames it; ERP edits and every kind of pull keep that.
		var pid string
		if err := pool.QueryRow(ctx, `UPDATE products SET sellable=true, name='Display GT 110' WHERE id=(SELECT product_id FROM product_variants WHERE sku='DW110E-GOR')
			RETURNING id::text`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE product_variants SET price=50000 WHERE sku='DW110E-GOR'`); err != nil {
			t.Fatal(err)
		}
		before := erProductRow(t, ctx, pool, pid)
		e.clock.Advance(time.Hour)
		e.fg("dw110e-gor", "DW110E-GOR", "DISPLAY GORGEOUS TUBEROSE", "DISPLAY PARFUM", 110, "NEW_LAUNCHING", `,"gender":"UNISEX","is_others":true,"unit":"Pcs"`)
		e.mustComplete(erp.ModeIncremental)
		e.clock.Advance(time.Hour)
		e.mustComplete(erp.ModeFull)
		erWant(t, "sold display after later pulls", erProductRow(t, ctx, pool, pid), before)
		erWantInt(t, "sellable never flipped back", erCount(t, ctx, pool, `SELECT count(*) FROM products WHERE id=$1 AND sellable`, pid), 1)

		// An empty display leaves stock through the outlet adjustment request, not a sale:
		// nothing in that flow gates on sellable or price.
		if _, err := pool.Exec(ctx, `INSERT INTO outlet_variant_stock (outlet_id, product_id, variant_size, stock)
			SELECT $1, product_id, size, 1 FROM product_variants WHERE sku='KTL-CHA'`, outlet); err != nil {
			t.Fatal(err)
		}
		var tester string
		if err := pool.QueryRow(ctx, `SELECT product_id::text FROM product_variants WHERE sku='KTL-CHA'`).Scan(&tester); err != nil {
			t.Fatal(err)
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		reqID, err := write.New(pool).CreateAdjustmentRequestTx(ctx, tx, "00000000-0000-4000-8f20-0000000000aa", write.AdjustmentRequestInput{
			LocationType: "outlet", LocationID: outlet, ProductID: tester, VariantSize: "Satuan", NewQty: 0, ReasonCode: "tester_sample"})
		if err != nil || reqID == "" {
			t.Fatalf("adjustment request for a not-for-sale ERP item: id=%q err=%v", reqID, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	})
}
