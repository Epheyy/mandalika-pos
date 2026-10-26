package handlers

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/mandalika/pos-backend/internal/integration/erp"
)

// Mapping v3 grouping and labels on the production rows captured read-only on 2026-10-26
// (erpmap testdata: the fragrances named in the sandbox report plus KEM-* and hampers).

const erSamplePath = "../integration/erp/erpmap/testdata/fg_sample_2026-10-26.json"

// erLoadSample posts every sample FG to the stub as is and returns code -> slug.
func (e *erEnv) erLoadSample() map[string]string {
	e.t.Helper()
	b, err := os.ReadFile(erSamplePath)
	if err != nil {
		e.t.Fatal(err)
	}
	var doc struct{ Items []map[string]any }
	if err := json.Unmarshal(b, &doc); err != nil {
		e.t.Fatal(err)
	}
	slugs := map[string]string{}
	for _, it := range doc.Items {
		body, _ := json.Marshal(it)
		e.hook("/_stub/fg", string(body))
		slugs[it["code"].(string)] = it["slug"].(string)
	}
	return slugs
}

// erLabels lists the labels of the product holding sku.
func erLabels(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sku string) string {
	t.Helper()
	return erStr(t, ctx, pool, `SELECT string_agg(v.size, '|' ORDER BY v.size) FROM product_variants v
		WHERE v.product_id=(SELECT product_id FROM product_variants WHERE sku=$1)`, sku)
}

// erProductOf is name|category|sellable|key of the product holding sku.
func erProductOf(t *testing.T, ctx context.Context, pool *pgxpool.Pool, sku string) string {
	t.Helper()
	return erStr(t, ctx, pool, `SELECT p.name||'|'||COALESCE(c.name,'-')||'|'||p.sellable||'|'||COALESCE(p.erp_group_key,'-')
		FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE v.sku=$1`, sku)
}

func erV3CatalogSubtests(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Run("v3-real-catalog-one-product-per-fragrance", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		erPosOutlet(t, ctx, pool, "Mandalika PMS", "PMS", "", "", "")
		slugs := e.erLoadSample()
		v := func(size, sku string) erPosVariant { return erPosVariant{size, sku, slugs[sku]} }
		fr := func(fc string) []erPosVariant { // the five priced sizes the POS sells per fragrance
			big := "110ml"
			if fc == "NO1" || fc == "ONL" {
				big = "120ml"
			}
			pe, pp := "PW110E-"+fc, "PW110P-"+fc
			if big == "120ml" { // the 4 POS SKUs corrected to the ERP codes by the mapping import
				pe, pp = "PP120E-"+fc, "PP120P-"+fc
			}
			return []erPosVariant{v("10ml ATOMIZER", "A10M-"+fc), v(big+" EXTRAIT DE PARFUM", pe), v(big+" PARFUM INTENSE", pp),
				v("2ml EXTRAIT DE PARFUM", "V2E-"+fc), v("2ml PARFUM INTENSE", "V2P-"+fc)}
		}
		// The test-Neon catalog after the SKU-mapping import (keys erp:<fragrance> / erp:<code>).
		no1 := erPosProduct(t, ctx, pool, "NO1", "MAN", "erp:NO1", fr("NO1")...)
		onl := erPosProduct(t, ctx, pool, "ONLY THE BRAVE", "MAN", "erp:ONL", fr("ONL")...)
		gor := erPosProduct(t, ctx, pool, "GORGEOUS TUBEROSE", "WOMAN", "erp:GOR", fr("GOR")...)
		hol := erPosProduct(t, ctx, pool, "HOLY SWEET", "WOMAN", "erp:HOL", fr("HOL")...)
		uns := erPosProduct(t, ctx, pool, "UNSTOPPABLE", "UNISEX", "erp:UNS", fr("UNS")...)
		hamper := erPosProduct(t, ctx, pool, "THE ONLY ONE", "HAMPERS", "erp:HAMPERS-THE",
			v("EXTRAIT DE PARFUM", "HAME-THE"), v("PARFUM INTENSE", "HAMP-THE"))
		can := erPosProduct(t, ctx, pool, "CANVAS BAG", "KEMASAN", "erp:KEM-CAN", v("Satuan", "KEM-CAN"))
		kar := erPosProduct(t, ctx, pool, "KARTU GARANSI", "KEMASAN", "erp:KEM-KAR", v("Satuan", "KEM-KAR"))
		existing := []string{no1, onl, gor, hol, uns, hamper, can, kar}
		before := map[string]string{}
		for _, id := range existing {
			before[id] = erProductRow(t, ctx, pool, id)
		}
		cats := erCount(t, ctx, pool, `SELECT count(*) FROM categories`)

		rep := e.mustComplete(erp.ModeFull)
		r := e.resource(rep, erp.ResourceFinishedGoods)
		if r.ItemErrors != 0 || r.Upserted != 118 {
			t.Fatalf("fg result = %+v", r)
		}
		for _, s := range []string{`product name "THE ONLY ONE" is taken, new product named "THE ONLY ONE (THE)"`,
			`product name "ONLY THE BRAVE" is taken, new product named "ONLY THE BRAVE (ONL-R)"`} {
			if !strings.Contains(r.Error, s) {
				t.Fatalf("fg note lacks %q: %s", s, r.Error)
			}
		}
		for _, id := range existing {
			erWant(t, "existing product after the pull", erProductRow(t, ctx, pool, id), before[id])
		}
		erWantInt(t, "only the not-for-sale marker category is added", erCount(t, ctx, pool, `SELECT count(*) FROM categories`), cats+1)

		const ext, pi = "EXTRAIT DE PARFUM", "PARFUM INTENSE"
		lbl := func(ls ...string) string { return strings.Join(ls, "|") }
		full := lbl("100ml "+ext, "100ml "+pi, "10ml ATOMIZER", "120ml "+ext, "120ml "+pi, "15ml GLASS MAN", "2ml "+ext, "2ml "+pi)
		for _, c := range []struct{ sku, product, labels string }{
			{"PP120E-24H", "24HOURS|MAN|false|erp:24H", full},
			{"PP120E-DAY", "DAY|MAN|false|erp:DAY", full},
			{"PP120E-CHA", "CHAMPION|MAN|false|erp:CHA", lbl("10ml ATOMIZER", "120ml "+ext, "120ml "+pi, "2ml "+ext, "2ml "+pi)},
			{"A10M-NO1", "NO1|MAN|true|erp:NO1", lbl("100ml "+ext, "100ml "+pi, "10ml ATOMIZER", "120ml "+ext, "120ml "+pi, "15ml GLASS MAN", "15ml LEATHER", "2ml "+ext, "2ml "+pi)},
			{"A10M-ONL", "ONLY THE BRAVE|MAN|true|erp:ONL", lbl("100ml "+ext, "100ml "+pi, "10ml ATOMIZER", "120ml "+ext, "120ml "+pi, "15ml GLASS MAN", "15ml LEATHER", "2ml "+ext, "2ml "+pi)},
			{"PP120E-ONL-R", "ONLY THE BRAVE (ONL-R)|MAN|false|erp:ONL-R", lbl("120ml " + ext)},
			{"A10M-GOR", "GORGEOUS TUBEROSE|WOMAN|true|erp:GOR", lbl("10ml ATOMIZER", "110ml "+ext, "110ml "+pi, "15ml GLASS WOMAN", "15ml GLITTER", "2ml "+ext, "2ml "+pi)},
			{"A10M-HOL", "HOLY SWEET|WOMAN|true|erp:HOL", lbl("10ml ATOMIZER", "110ml "+ext, "110ml "+pi, "15ml GLASS WOMAN", "15ml GLITTER", "2ml "+ext, "2ml "+pi)},
			{"A10M-HOL-EX", "HOLY SWEET ELIXIR|WOMAN|false|erp:HOL-EX", lbl("10ml ATOMIZER", "110ml "+pi, "2ml "+ext)},
			{"V2E-THE", "THE ONLY ONE (THE)|WOMAN|false|erp:THE", lbl("15ml LEATHER", "2ml "+ext, "2ml "+pi)},
			{"HAME-THE", "THE ONLY ONE|HAMPERS|true|erp:HAMPERS-THE", lbl(ext, pi)},
			{"KEM-CAN", "CANVAS BAG|KEMASAN|true|erp:KEM-CAN", "Satuan"},
			{"KEM-GIF", "GIFT CARD (KEM-GIF)|ERP: bukan untuk dijual|false|erp:KEM-GIF", "Satuan"},
			{"KEM-PAP", "PAPERBAG CREAM (KEM-PAP)|ERP: bukan untuk dijual|false|erp:KEM-PAP", "Satuan"},
			{"DP120E-24H", "24HOURS (DP120E-24H)|ERP: bukan untuk dijual|false|erp:DP120E-24H", "Satuan"},
			{"PP120P-ONL-R", "ONLY THE BRAVE - 120ML PARFUM INTENSE REWORK (PP120P-ONL-R)|ERP: bukan untuk dijual|false|erp:PP120P-ONL-R", "Satuan"},
		} {
			erWant(t, c.sku+" product", erProductOf(t, ctx, pool, c.sku), c.product)
			erWant(t, c.sku+" labels", erLabels(t, ctx, pool, c.sku), c.labels)
		}
		erWantInt(t, "every unlinked others item is its own not-for-sale product", erCount(t, ctx, pool, `
			SELECT count(*) FROM product_variants v JOIN products p ON p.id=v.product_id
			 WHERE v.price=0 AND v.size='Satuan' AND p.erp_group_key='erp:'||v.sku AND NOT p.sellable
			   AND (SELECT count(*) FROM product_variants x WHERE x.product_id=p.id)=1`), 46-4)
		erWantInt(t, "no fragrance product holds an others item", erCount(t, ctx, pool, `
			SELECT count(*) FROM product_variants v JOIN products p ON p.id=v.product_id
			 WHERE v.size='Satuan' AND v.price=0 AND p.erp_group_key<>'erp:'||v.sku`), 0)

		version := erVersion(t, ctx, pool)
		e.clock.Advance(time.Hour)
		e.mustComplete(erp.ModeFull)
		erWant(t, "an unchanged re-pull writes nothing", erVersion(t, ctx, pool), version)
	})

	// Safety nets: a POS fragrance product the mapping left without its key, an uncorrected
	// POS SKU, and one fragrance linked in two products.
	t.Run("v3-fragrance-fallback-and-conflicts", func(t *testing.T) {
		e := newErEnv(t, ctx, pool, 0)
		day := erPosProduct(t, ctx, pool, "DAY", "MAN", "", erPosVariant{"10ml ATOMIZER", "A10M-DAY", "day-a10m"})
		erPosProduct(t, ctx, pool, "NO1", "MAN", "erp:NO1", erPosVariant{"10ml ATOMIZER", "A10M-NO1", "no1-a10m"},
			erPosVariant{"120ml EXTRAIT DE PARFUM", "PW110E-NO1", ""}) // wrong POS SKU, not corrected
		erPosProduct(t, ctx, pool, "CHAMPION", "MAN", "pos:champion", erPosVariant{"10ml ATOMIZER", "A10M-CHA", "cha-a10m"})
		erPosProduct(t, ctx, pool, "CHAMPION 2", "MAN", "", erPosVariant{"2ml EXTRAIT DE PARFUM", "V2E-CHA", "cha-v2e"})
		e.fg("day-a10m", "A10M-DAY", "DAY", "ATOMIZER", 10, "ACTIVE", `,"gender":"MEN"`)
		e.fg("day-v2e", "V2E-DAY", "DAY", "EXT", 2, "ACTIVE", `,"gender":"MEN"`)
		e.fg("no1-a10m", "A10M-NO1", "NO1", "ATOMIZER", 10, "ACTIVE", `,"gender":"MEN"`)
		e.fg("no1", "PP120E-NO1", "NO1", "EXT", 120, "ACTIVE", `,"gender":"MEN"`)
		e.fg("cha-a10m", "A10M-CHA", "CHAMPION", "ATOMIZER", 10, "ACTIVE", `,"gender":"MEN"`)
		e.fg("cha-v2e", "V2E-CHA", "CHAMPION", "EXT", 2, "ACTIVE", `,"gender":"MEN"`)
		e.fg("cha-v2p", "V2P-CHA", "CHAMPION", "PERFUME INTENSE", 2, "ACTIVE", `,"gender":"MEN"`)
		rep := e.mustComplete(erp.ModeFull)

		erWantInt(t, "DAY sibling adopted by the linked fragrance", erCount(t, ctx, pool,
			`SELECT count(*) FROM product_variants WHERE sku='V2E-DAY' AND product_id=$1`, day), 1)
		erWantInt(t, "the uncorrected SKU blocks a duplicate 120ml label", erCount(t, ctx, pool,
			`SELECT count(*) FROM product_variants WHERE sku='PP120E-NO1'`), 0)
		erWantInt(t, "CHAMPION in two products: no third product", erCount(t, ctx, pool,
			`SELECT count(*) FROM product_variants WHERE sku='V2P-CHA'`), 0)
		r := e.resource(rep, erp.ResourceFinishedGoods)
		if r.ItemErrors != 2 || !strings.Contains(r.Error, `size label "120ml EXTRAIT DE PARFUM" already exists`) ||
			!strings.Contains(r.Error, "fragrance CHA is linked in more than one POS product") {
			t.Fatalf("fg result = %+v", r)
		}
	})
}
