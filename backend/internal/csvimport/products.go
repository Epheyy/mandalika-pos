package csvimport

import (
	"fmt"
	"strconv"
	"strings"
)

// ProductSpec is the product file layout (unchanged from the old template so the
// product export round-trips). There is deliberately NO stock column (owner decision:
// opening stock is loaded by goods receipt or stock count).
var ProductSpec = Spec{
	Columns: []ColumnSpec{
		{Key: "Nama", Required: true},
		{Key: "Brand", Required: true},
		{Key: "Kategori"},
		{Key: "Deskripsi"},
		{Key: "Ukuran", Required: true},
		{Key: "Harga", Required: true},
		{Key: "SKU", Required: true},
		{Key: "Barcode"},
		{Key: "Jual"},
		{Key: "Aktif"},
		{Key: "Unggulan"},
	},
}

// Catalog is a snapshot of current products, variants and categories (loaded once).
type Catalog struct {
	Products   []CatalogProduct
	Variants   []CatalogVariant
	Categories []CatalogCategory
	// StockSizes lists, per product id, the sizes that already have per-outlet or warehouse
	// stock/price rows (a rename onto one of them would collide on the location key).
	StockSizes map[string]map[string]bool
	// StockedSizes maps product id -> size -> a location label ("outlet X" / "gudang Y")
	// for sizes that hold non-zero stock (negative included). A rename away from one is
	// refused (D13): stock is never moved by a rename; zero it by adjustment first.
	StockedSizes map[string]map[string]string
	// InFlightSizes lists, per product id, the sizes referenced by open documents (draft or
	// in-transit transfers, planned or in-progress stock counts). Those documents key stock
	// by the stored size text, so renaming a variant away from such a size would make their
	// completion write stock under a size that no variant has any more.
	InFlightSizes map[string]map[string]bool
	// CategoryNames maps category id -> name (for old->new text in the preview).
	CategoryNames map[string]string
}

type CatalogProduct struct {
	ID, Name, Brand, CategoryID, Description string
	Sellable, Active, Featured               bool
	// ERPLinked marks a product the ERP owns (erp_group_key or an erp_slug variant): its
	// category is read-only for the import.
	ERPLinked bool
}

type CatalogVariant struct {
	ID, ProductID, Size, SKU, Barcode string
	Price                             float64
	// ERPLinked marks a variant with an erp_slug: its size is read-only for the import.
	ERPLinked bool
}

type CatalogCategory struct{ ID, Name string }

// PlannedVariant is one variant write. Create inserts (never with stock); Update changes
// size, price and barcode only (RenameFrom set = the per-outlet stock and price rows
// move from that size to Size). An empty Barcode on update means keep.
type PlannedVariant struct {
	ExistingID string
	Size       string
	SKU        string
	Barcode    string
	Price      float64
	RenameFrom string
	// CurrentSize is the size the planner saw on the matched variant. Apply updates only
	// while the variant still has it, so a concurrent edit makes the import stale.
	CurrentSize string
	// Changes is the old→new summary shown as the reason of an update row.
	Changes string
	Create  bool
	Update  bool
}

// PlannedProduct is one product write. For an existing product nil pointers mean "keep";
// for a new one they are already filled with the documented defaults.
type PlannedProduct struct {
	ExistingID   string
	Name, Brand  string
	CategoryName string // "" = leave as is (or none for a new product)
	Description  *string
	Sellable     *bool
	Active       *bool
	Featured     *bool
	Variants     []PlannedVariant
}

// ProductsPlan is the outcome of planning a product file.
type ProductsPlan struct {
	Report        Report
	Products      []PlannedProduct
	NewCategories []string
}

type productRow struct {
	row                         Row
	name, brand, category, desc string
	size, sku, barcode          string
	price                       float64
	jual, aktif, unggulan       *bool
	key                         string
	valid                       bool
}

type productGroup struct {
	key      string
	rows     []*productRow
	existing *CatalogProduct
}

// PlanProducts validates and plans a product file against the catalog snapshot. It is
// merge-only: it never plans a delete and never a stock write.
func PlanProducts(t *Table, cat Catalog) (*ProductsPlan, error) {
	b := NewBuilder(KindProducts, t)
	if t.HasFileError() {
		return &ProductsPlan{Report: b.Report()}, nil
	}
	ix := newCatalogIndex(cat)

	var groups []*productGroup
	byKey := map[string]*productGroup{}
	all := make([]*productRow, 0, len(t.Rows))
	for _, row := range t.Rows {
		b.Begin(row)
		pr := parseProductRow(b, row)
		all = append(all, pr)
		if !pr.valid {
			continue
		}
		g := byKey[pr.key]
		if g == nil {
			g = &productGroup{key: pr.key}
			byKey[pr.key] = g
			groups = append(groups, g)
		}
		g.rows = append(g.rows, pr)
	}

	plan := &ProductsPlan{}
	newCats := newCategoryTracker(ix)
	fileSKU := map[string]string{}     // sku -> group key that first used it
	fileBarcode := map[string]string{} // effective barcode -> group key
	actions := map[int]rowOutcome{}    // row index -> outcome for valid rows

	for _, g := range groups {
		pp := planProductGroup(b, g, ix, newCats, fileSKU, fileBarcode, actions)
		if pp != nil {
			plan.Products = append(plan.Products, *pp)
		}
	}
	for _, pr := range all {
		switch {
		case !pr.valid || b.RowHasError(pr.row):
			b.Row(pr.row, ActionError, pr.sku, "")
		default:
			o := actions[pr.row.Index]
			b.Row(pr.row, o.action, pr.sku, o.reason)
		}
	}
	plan.NewCategories = newCats.names
	b.NewCategories(len(newCats.names))
	plan.Report = b.Report()
	return plan, nil
}

type rowOutcome struct{ action, reason string }

const noChange = "tidak ada perubahan"

func parseProductRow(b *Builder, row Row) *productRow {
	c := row.Cells
	pr := &productRow{row: row}
	pr.name = strings.TrimSpace(c["Nama"])
	pr.brand = strings.TrimSpace(c["Brand"])
	pr.category = strings.TrimSpace(c["Kategori"])
	pr.desc = c["Deskripsi"]
	pr.size = strings.TrimSpace(c["Ukuran"])
	pr.sku = strings.TrimSpace(c["SKU"])
	pr.barcode = strings.TrimSpace(c["Barcode"])

	required := func(col, v string, max int) {
		if v == "" {
			b.Issue(row, col, SevError, "required", col+" wajib diisi", "")
			return
		}
		checkMax(b, row, col, v, max)
	}
	required("Nama", pr.name, MaxName)
	required("Brand", pr.brand, MaxName)
	required("Ukuran", pr.size, MaxName)
	required("SKU", pr.sku, MaxCode)
	if pr.category != "" {
		checkMax(b, row, "Kategori", pr.category, MaxName)
	}
	if pr.barcode != "" {
		checkMax(b, row, "Barcode", pr.barcode, MaxCode)
	}
	checkMax(b, row, "Deskripsi", pr.desc, MaxText)

	switch price, err := ParseRupiah(c["Harga"], false); {
	case err == errBlank:
		b.Issue(row, "Harga", SevError, "required", "Harga wajib diisi", "")
	case err != nil:
		b.Issue(row, "Harga", SevError, "invalid_number", "Harga: "+err.Error(), c["Harga"])
	default:
		pr.price = price
		if price == 0 {
			b.Issue(row, "Harga", SevWarning, "zero_price", "harga 0", c["Harga"])
		}
	}
	pr.jual = optionalBool(b, row, "Jual")
	pr.aktif = optionalBool(b, row, "Aktif")
	pr.unggulan = optionalBool(b, row, "Unggulan")

	// Excel turns long numeric codes into 8.99E+12; refuse them like phones.
	for _, f := range []struct{ col, v string }{{"SKU", pr.sku}, {"Barcode", pr.barcode}} {
		if LooksScientific(f.v) {
			b.Issue(row, f.col, SevError, "code_scientific",
				"Excel mengubah angka "+f.col+" ke notasi ilmiah; format kolom sebagai Teks lalu isi ulang", f.v)
		}
	}

	pr.key = productKey(pr.name, pr.brand)
	pr.valid = !b.RowHasError(row)
	return pr
}

// productKey identifies a product by trimmed, case-folded name and brand. The separator is
// a control character so a "|" inside a name can never make two products collide.
func productKey(name, brand string) string {
	return strings.ToLower(strings.TrimSpace(name)) + "\x1f" + strings.ToLower(strings.TrimSpace(brand))
}

// ProductKey is exported for the apply side, which maps created ids back to plan entries.
func ProductKey(name, brand string) string { return productKey(name, brand) }

func checkMax(b *Builder, row Row, col, v string, max int) {
	if err := CheckLen(v, max); err != nil {
		b.Issue(row, col, SevError, "too_long", col+" "+err.Error(), "")
	}
}

func optionalBool(b *Builder, row Row, col string) *bool {
	raw := strings.TrimSpace(row.Cells[col])
	if raw == "" {
		return nil
	}
	v, err := ParseBool(raw)
	if err != nil {
		b.Issue(row, col, SevError, "invalid_bool", col+": "+err.Error(), raw)
		return nil
	}
	return &v
}

// catalogIndex holds the lookups the planner needs.
type catalogIndex struct {
	byKey      map[string][]*CatalogProduct
	variantsOf map[string][]CatalogVariant
	skuOwners  map[string]map[string]bool // sku -> product ids
	barcodeOf  map[string]string          // barcode -> variant id
	catByLower map[string]CatalogCategory
	stockSizes map[string]map[string]bool
	stocked    map[string]map[string]string
	inFlight   map[string]map[string]bool
	catName    map[string]string
}

func newCatalogIndex(cat Catalog) *catalogIndex {
	ix := &catalogIndex{
		byKey: map[string][]*CatalogProduct{}, variantsOf: map[string][]CatalogVariant{},
		skuOwners: map[string]map[string]bool{}, barcodeOf: map[string]string{},
		catByLower: map[string]CatalogCategory{}, stockSizes: cat.StockSizes,
		stocked: cat.StockedSizes, inFlight: cat.InFlightSizes, catName: cat.CategoryNames,
	}
	for i := range cat.Products {
		p := &cat.Products[i]
		k := productKey(p.Name, p.Brand)
		ix.byKey[k] = append(ix.byKey[k], p)
	}
	for _, v := range cat.Variants {
		ix.variantsOf[v.ProductID] = append(ix.variantsOf[v.ProductID], v)
		if ix.skuOwners[v.SKU] == nil {
			ix.skuOwners[v.SKU] = map[string]bool{}
		}
		ix.skuOwners[v.SKU][v.ProductID] = true
		if v.Barcode != "" {
			ix.barcodeOf[v.Barcode] = v.ID
		}
	}
	for _, c := range cat.Categories {
		l := strings.ToLower(strings.TrimSpace(c.Name))
		if _, ok := ix.catByLower[l]; !ok {
			ix.catByLower[l] = c
		}
	}
	return ix
}

type categoryTracker struct {
	ix    *catalogIndex
	seen  map[string]bool
	names []string
}

func newCategoryTracker(ix *catalogIndex) *categoryTracker {
	return &categoryTracker{ix: ix, seen: map[string]bool{}}
}

// resolve returns the existing category id ("" when the category is new) and records a
// new category once, keeping the first spelling.
func (c *categoryTracker) resolve(name string) string {
	l := strings.ToLower(name)
	if ex, ok := c.ix.catByLower[l]; ok {
		return ex.ID
	}
	if !c.seen[l] {
		c.seen[l] = true
		c.names = append(c.names, name)
	}
	return ""
}

func planProductGroup(b *Builder, g *productGroup, ix *catalogIndex, cats *categoryTracker,
	fileSKU, fileBarcode map[string]string, actions map[int]rowOutcome) *PlannedProduct {
	first := g.rows[0]
	matches := ix.byKey[g.key]
	if len(matches) > 1 {
		for _, r := range g.rows {
			b.Issue(r.row, "Nama", SevError, "ambiguous_product",
				fmt.Sprintf("%d produk bernama \"%s\" dengan brand yang sama sudah ada; gabungkan atau ubah nama dulu", len(matches), first.name), r.name)
		}
		return nil
	}
	if len(matches) == 1 {
		g.existing = matches[0]
	}

	pp := &PlannedProduct{Name: first.name, Brand: first.brand}
	var existingVariants []CatalogVariant
	if g.existing != nil {
		pp.ExistingID = g.existing.ID
		existingVariants = ix.variantsOf[g.existing.ID]
	}
	productChanges := mergeProductFields(b, g, pp, ix, cats)
	productChanged := len(productChanges) > 0

	seenSKU := map[string]int{}
	seenBarcode := map[string]int{}
	seenSize := map[string]int{}
	var firstOK *productRow
	for _, r := range g.rows {
		pv, ok := planVariant(b, r, g, existingVariants, ix, seenSKU, seenBarcode, seenSize, fileSKU, fileBarcode)
		if !ok {
			continue
		}
		if firstOK == nil {
			firstOK = r
		}
		switch {
		case pv.Create:
			actions[r.row.Index] = rowOutcome{ActionCreate, ""}
		case pv.Update:
			actions[r.row.Index] = rowOutcome{ActionUpdate, pv.Changes}
		default:
			actions[r.row.Index] = rowOutcome{ActionSkip, noChange}
		}
		if pv.Create || pv.Update {
			pp.Variants = append(pp.Variants, pv)
		}
	}
	if g.existing != nil && productChanged && firstOK != nil {
		o := actions[firstOK.row.Index]
		reason := strings.Join(productChanges, "; ")
		if o.action == ActionUpdate && o.reason != "" {
			reason = o.reason + "; " + reason
		}
		if o.action == ActionSkip || o.action == ActionUpdate {
			actions[firstOK.row.Index] = rowOutcome{ActionUpdate, reason}
		}
	}
	if g.existing == nil || productChanged || len(pp.Variants) > 0 {
		return pp
	}
	return nil
}

// mergeProductFields folds the product-level cells (first non-blank wins, later
// conflicting values warn) into pp and reports whether an existing product changes.
func mergeProductFields(b *Builder, g *productGroup, pp *PlannedProduct, ix *catalogIndex, cats *categoryTracker) []string {
	var (
		catRow, descRow, jualRow, aktifRow, unggRow *productRow
		cat, desc                                   string
		jual, aktif, ungg                           *bool
	)
	conflict := func(r, owner *productRow, col string) {
		b.Issue(r.row, col, SevWarning, "product_field_conflict",
			fmt.Sprintf("%s berbeda dari baris %d untuk produk yang sama; memakai baris pertama", col, owner.row.Index), "")
	}
	for _, r := range g.rows {
		if r.category != "" {
			if catRow == nil {
				catRow, cat = r, r.category
			} else if !strings.EqualFold(cat, r.category) {
				conflict(r, catRow, "Kategori")
			}
		}
		if strings.TrimSpace(r.desc) != "" {
			if descRow == nil {
				descRow, desc = r, r.desc
			} else if desc != r.desc {
				conflict(r, descRow, "Deskripsi")
			}
		}
		for _, f := range []struct {
			v     *bool
			owner **productRow
			val   **bool
			col   string
		}{{r.jual, &jualRow, &jual, "Jual"}, {r.aktif, &aktifRow, &aktif, "Aktif"}, {r.unggulan, &unggRow, &ungg, "Unggulan"}} {
			if f.v == nil {
				continue
			}
			if *f.owner == nil {
				*f.owner, *f.val = r, f.v
			} else if **f.val != *f.v {
				conflict(r, *f.owner, f.col)
			}
		}
	}

	ex := g.existing
	var changed []string
	// Category is POS-owned (mapping v3): applied like any product, ERP-linked or not.
	if cat != "" {
		pp.CategoryName = cat
		id := cats.resolve(cat)
		// A category that does not exist yet is always a change (it is created and assigned),
		// even when the product currently has none.
		if ex != nil && (id == "" || id != ex.CategoryID) {
			old := ix.catName[ex.CategoryID]
			if old == "" {
				old = "(kosong)"
			}
			changed = append(changed, fmt.Sprintf("kategori %s→%s", old, cat))
		}
	}
	if desc != "" {
		d := desc
		pp.Description = &d
		if ex != nil && d != ex.Description {
			changed = append(changed, "deskripsi diubah")
		}
	}
	pp.Sellable = pick(jual, ex, func(p *CatalogProduct) bool { return p.Sellable }, true, "jual", &changed)
	pp.Active = pick(aktif, ex, func(p *CatalogProduct) bool { return p.Active }, true, "aktif", &changed)
	pp.Featured = pick(ungg, ex, func(p *CatalogProduct) bool { return p.Featured }, false, "unggulan", &changed)
	return changed
}

func yaTidak(v bool) string {
	if v {
		return "Ya"
	}
	return "Tidak"
}

// fmtMoney prints a rupiah amount without a needless fraction.
func fmtMoney(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// pick returns the planned boolean: for a new product the cell or the default; for an
// existing one the cell (recording a change when it differs) or nil (keep).
func pick(cell *bool, ex *CatalogProduct, cur func(*CatalogProduct) bool, def bool, name string, changed *[]string) *bool {
	if ex == nil {
		v := def
		if cell != nil {
			v = *cell
		}
		return &v
	}
	if cell == nil {
		return nil
	}
	if *cell != cur(ex) {
		*changed = append(*changed, fmt.Sprintf("%s %s→%s", name, yaTidak(cur(ex)), yaTidak(*cell)))
	}
	v := *cell
	return &v
}

func planVariant(b *Builder, r *productRow, g *productGroup, existing []CatalogVariant, ix *catalogIndex,
	seenSKU, seenBarcode, seenSize map[string]int, fileSKU, fileBarcode map[string]string) (PlannedVariant, bool) {
	row := r.row
	ok := true
	fail := func(col, code, msg, val string) {
		b.Issue(row, col, SevError, code, msg, val)
		ok = false
	}

	if first, dup := seenSKU[r.sku]; dup {
		fail("SKU", "duplicate_sku", fmt.Sprintf("SKU sama dengan baris %d untuk produk yang sama", first), r.sku)
	} else {
		seenSKU[r.sku] = row.Index
	}
	if owner, used := fileSKU[r.sku]; used && owner != g.key {
		fail("SKU", "sku_on_other_product", "SKU yang sama dipakai produk lain di file ini", r.sku)
	} else if !used {
		fileSKU[r.sku] = g.key
	}
	sizeKey := strings.ToLower(r.size)
	if first, dup := seenSize[sizeKey]; dup {
		fail("Ukuran", "duplicate_size", fmt.Sprintf("Ukuran sama dengan baris %d untuk produk yang sama", first), r.size)
	} else {
		seenSize[sizeKey] = row.Index
	}
	var matched *CatalogVariant
	if g.existing != nil {
		for i := range existing {
			if existing[i].SKU == r.sku {
				matched = &existing[i]
				break
			}
		}
	}
	// The barcode a new variant would get (explicit, else its SKU). A matched variant with
	// a blank cell keeps its barcode, so it takes no part in barcode duplicate checks.
	effBarcode := r.barcode
	if effBarcode == "" {
		effBarcode = r.sku
	}
	if r.barcode != "" || matched == nil {
		if first, dup := seenBarcode[effBarcode]; dup {
			fail("Barcode", "duplicate_barcode", fmt.Sprintf("barcode sama dengan baris %d", first), effBarcode)
		} else {
			seenBarcode[effBarcode] = row.Index
		}
		if owner, used := fileBarcode[effBarcode]; used && owner != g.key {
			fail("Barcode", "duplicate_barcode", "barcode yang sama dipakai produk lain di file ini", effBarcode)
		} else if !used {
			fileBarcode[effBarcode] = g.key
		}
	}
	// A SKU that belongs to another product is a row error (owner decision Q4).
	for pid := range ix.skuOwners[r.sku] {
		if g.existing == nil || pid != g.existing.ID {
			fail("SKU", "sku_on_other_product", "SKU sudah dipakai produk lain; ganti nama di form produk, bukan lewat impor", r.sku)
			break
		}
	}

	pv := PlannedVariant{Size: r.size, SKU: r.sku, Price: r.price}
	var changes []string
	if matched != nil {
		pv.ExistingID = matched.ID
		pv.CurrentSize = matched.Size
		if matched.Size != r.size && matched.ERPLinked {
			// ERP-owned (plan 4.5): the size is not applied; the other cells still are.
			b.Issue(row, "Ukuran", SevWarning, "erp_owned",
				fmt.Sprintf("ukuran varian ini dikelola ERP (\"%s\"); perubahan tidak diterapkan", matched.Size), r.size)
			pv.Size = matched.Size
		} else if matched.Size != r.size {
			if holder := sizeHolder(existing, r.size, matched.ID); holder != "" {
				fail("Ukuran", "size_collision", fmt.Sprintf("ukuran \"%s\" sudah dipakai varian lain (SKU %s); tukar atau ganti nama ukuran lewat form produk", r.size, holder), r.size)
			} else if loc := ix.stocked[matched.ProductID][matched.Size]; loc != "" {
				fail("Ukuran", "size_has_stock", fmt.Sprintf("ukuran \"%s\" masih punya stok di %s; nolkan lewat penyesuaian dulu sebelum mengganti ukuran", matched.Size, loc), r.size)
			} else if ix.stockSizes[matched.ProductID][r.size] {
				fail("Ukuran", "size_stock_residue", fmt.Sprintf("ukuran \"%s\" masih punya sisa baris stok atau harga (di outlet atau gudang) dari varian lama; kosongkan lewat penyesuaian stok atau pilih ukuran lain", r.size), r.size)
			} else if ix.inFlight[matched.ProductID][matched.Size] {
				fail("Ukuran", "size_in_flight", fmt.Sprintf("ukuran \"%s\" masih dipakai transfer atau stock count yang belum selesai; selesaikan atau batalkan dulu sebelum mengganti ukuran", matched.Size), r.size)
			} else {
				pv.RenameFrom = matched.Size
				pv.Update = true
				changes = append(changes, fmt.Sprintf("ukuran %s→%s", matched.Size, r.size))
				b.Issue(row, "Ukuran", SevWarning, "size_rename",
					fmt.Sprintf("ukuran berubah dari \"%s\" ke \"%s\": stok dan harga per outlet ikut pindah; penjualan POS yang masih antre dan pemilih tingkat varian (promo, loyalti, bundle: id|ukuran) tidak akan cocok lagi dengan ukuran baru", matched.Size, r.size), r.sku)
			}
		}
		if matched.Price != r.price {
			pv.Update = true
			changes = append(changes, fmt.Sprintf("harga %s→%s", fmtMoney(matched.Price), fmtMoney(r.price)))
		}
		if r.barcode != "" && r.barcode != matched.Barcode {
			if owner := ix.barcodeOf[r.barcode]; owner != "" && owner != matched.ID {
				fail("Barcode", "barcode_in_use", "barcode sudah dipakai varian lain", r.barcode)
			} else {
				pv.Barcode = r.barcode
				pv.Update = true
				changes = append(changes, fmt.Sprintf("barcode %s→%s", matched.Barcode, r.barcode))
			}
		}
		pv.Changes = strings.Join(changes, "; ")
	} else {
		pv.Create = true
		pv.Barcode = effBarcode
		if holder := sizeHolder(existing, r.size, ""); holder != "" {
			fail("Ukuran", "size_exists", fmt.Sprintf("ukuran \"%s\" sudah ada pada varian lain (SKU %s)", r.size, holder), r.size)
		} else if g.existing != nil && ix.stockSizes[g.existing.ID][r.size] {
			fail("Ukuran", "size_stock_residue", fmt.Sprintf("ukuran \"%s\" masih punya sisa baris stok atau harga (di outlet atau gudang) dari varian lama; kosongkan lewat penyesuaian stok atau pilih ukuran lain", r.size), r.size)
		}
		if owner := ix.barcodeOf[effBarcode]; owner != "" {
			fail("Barcode", "barcode_in_use", "barcode (atau SKU yang dipakai sebagai barcode) sudah dipakai varian lain", effBarcode)
		}
	}
	return pv, ok && !b.RowHasError(row)
}

// sizeHolder returns the SKU of an existing variant (other than exceptID) whose size
// equals size case-insensitively, or "".
func sizeHolder(existing []CatalogVariant, size, exceptID string) string {
	for _, v := range existing {
		if v.ID != exceptID && strings.EqualFold(v.Size, size) {
			return v.SKU
		}
	}
	return ""
}
