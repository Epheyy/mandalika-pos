package csvimport

import (
	"fmt"
	"strings"
)

// Import kinds.
const (
	KindCustomers   = "customers"
	KindProducts    = "products"
	KindIngredients = "ingredients"
)

// CustomerSpec is the customer file layout. The ignored names are the extra columns of
// the customer export (it is not a round-trip format for points or totals: owner Q3).
var CustomerSpec = Spec{
	Columns: []ColumnSpec{
		{Key: "Nama", Required: true},
		{Key: "Telepon", Required: true},
		{Key: "Email"},
		{Key: "Tanggal Lahir"},
		{Key: "Anniversary"},
		{Key: "Catatan"},
	},
	Ignored: []string{"Poin", "Total Belanja", "Jumlah Kunjungan", "Tag", "Segmen"},
}

// CustomerCreate is one customer apply will insert.
type CustomerCreate struct {
	Name, Phone, Email, Birthday, Anniversary, Notes string
}

// MergedKeeper is the terminal live customer a merged-away (tombstoned) customer ended
// up in; the planner only quotes its name and the last four digits of its phone.
type MergedKeeper struct {
	Name, Phone string
	// ChainTooLong is set when the merge chain was cut at the depth cap, so Name/Phone
	// are an intermediate record and must not be quoted as the keeper.
	ChainTooLong bool
}

// PhoneMatch is what the database knows about one cleaned phone: how many LIVE customers
// (merged_into IS NULL) have it exactly, and, when none do but a tombstoned customer
// had it, the keeper that customer was merged into (nil otherwise).
type PhoneMatch struct {
	Live   int
	Keeper *MergedKeeper
}

// CustomerPhoneLookup returns a PhoneMatch for each cleaned phone that has a live or a
// tombstoned customer. Phones with neither are absent.
type CustomerPhoneLookup func(phones []string) (map[string]PhoneMatch, error)

// CustomersPlan is the outcome of planning a customer file.
type CustomersPlan struct {
	Report  Report
	Creates []CustomerCreate
}

type customerCandidate struct {
	row Row
	c   CustomerCreate
}

// PlanCustomers validates every row and decides create or skip against live customers.
// A phone that already exists is skipped and reported; nothing is ever merged or filled.
// A phone that only a merged-away (tombstoned) customer had is skipped with a warning
// naming the keeper: an import never re-creates a merged customer.
func PlanCustomers(t *Table, lookup CustomerPhoneLookup) (*CustomersPlan, error) {
	b := NewBuilder(KindCustomers, t)
	if t.HasFileError() {
		return &CustomersPlan{Report: b.Report()}, nil
	}
	seen := map[string]int{}
	var cands []customerCandidate
	for _, row := range t.Rows {
		b.Begin(row)
		c, ok := validateCustomerRow(b, row, seen)
		if !ok || b.RowHasError(row) {
			b.Row(row, ActionError, rowKey(row.Cells["Telepon"], row.Cells["Nama"]), "")
			continue
		}
		cands = append(cands, customerCandidate{row: row, c: c})
	}

	phones := make([]string, 0, len(cands))
	for _, c := range cands {
		phones = append(phones, c.c.Phone)
	}
	existing := map[string]PhoneMatch{}
	if len(phones) > 0 {
		var err error
		if existing, err = lookup(phones); err != nil {
			return nil, err
		}
	}
	plan := &CustomersPlan{}
	for _, cand := range cands {
		m := existing[cand.c.Phone]
		switch n := m.Live; {
		case n == 0 && m.Keeper != nil:
			b.Issue(cand.row, "Telepon", SevWarning, "merged_away", mergedAwayMessage(m.Keeper), cand.c.Phone)
			b.Row(cand.row, ActionSkip, cand.c.Phone, mergedAwayReason)
		case n == 0:
			plan.Creates = append(plan.Creates, cand.c)
			b.Row(cand.row, ActionCreate, cand.c.Phone, "")
		case n == 1:
			b.Row(cand.row, ActionSkip, cand.c.Phone, "pelanggan sudah ada (nomor telepon sama)")
		default:
			b.Issue(cand.row, "Telepon", SevWarning, "multiple_matches",
				fmt.Sprintf("%d pelanggan memiliki nomor ini; periksa tab Duplikat", n), cand.c.Phone)
			b.Row(cand.row, ActionSkip, cand.c.Phone, "beberapa pelanggan sudah memakai nomor ini; lihat tab Duplikat")
		}
	}
	plan.Report = b.Report()
	return plan, nil
}

const (
	mergedAwayReason = "pelanggan ini sudah digabung ke pelanggan lain; tidak dibuat ulang"
	// mergedAwayStored replaces the issue message in the audit copy (it names the keeper).
	mergedAwayStored = "pelanggan dengan nomor ini sudah digabung ke pelanggan lain; baris dilewati"
)

// mergedAwayMessage points at the keeper by name and masked phone only.
func mergedAwayMessage(k *MergedKeeper) string {
	if k.ChainTooLong {
		return "pelanggan dengan nomor ini sudah digabung, tetapi rantai penggabungan terlalu panjang untuk ditelusuri; baris dilewati, tidak dibuat ulang"
	}
	return fmt.Sprintf("pelanggan dengan nomor ini sudah digabung ke %q (telepon ****%s); baris dilewati, tidak dibuat ulang",
		k.Name, lastDigits(k.Phone, 4))
}

func lastDigits(s string, n int) string {
	var d []rune
	for _, r := range s {
		if r >= '0' && r <= '9' {
			d = append(d, r)
		}
	}
	if len(d) > n {
		d = d[len(d)-n:]
	}
	return string(d)
}

func validateCustomerRow(b *Builder, row Row, seen map[string]int) (CustomerCreate, bool) {
	var c CustomerCreate
	cells := row.Cells
	c.Name = strings.TrimSpace(cells["Nama"])
	switch {
	case c.Name == "":
		b.Issue(row, "Nama", SevError, "required", "Nama wajib diisi", "")
	default:
		if err := CheckLen(c.Name, MaxName); err != nil {
			b.Issue(row, "Nama", SevError, "too_long", "Nama "+err.Error(), c.Name)
		}
	}

	rawPhone := strings.TrimSpace(cells["Telepon"])
	switch {
	case rawPhone == "":
		b.Issue(row, "Telepon", SevError, "required", "Telepon wajib diisi", "")
	case LooksScientific(rawPhone):
		b.Issue(row, "Telepon", SevError, "phone_scientific",
			"telepon berubah jadi notasi ilmiah oleh Excel; format kolom sebagai Teks lalu isi ulang", rawPhone)
	default:
		c.Phone = CleanPhone(rawPhone)
		if err := ValidPhone(c.Phone); err != nil {
			b.Issue(row, "Telepon", SevError, "invalid_phone", err.Error(), rawPhone)
		} else {
			if MissingLeadingZero(c.Phone) {
				b.Issue(row, "Telepon", SevWarning, "phone_leading_zero", "angka 0 di depan hilang?", rawPhone)
			}
			if first, dup := seen[c.Phone]; dup {
				b.Issue(row, "Telepon", SevError, "duplicate_in_file",
					fmt.Sprintf("nomor yang sama sudah ada di baris %d", first), rawPhone)
			} else {
				seen[c.Phone] = row.Index
			}
		}
	}

	c.Email = strings.TrimSpace(cells["Email"])
	if c.Email != "" {
		if err := CheckLen(c.Email, MaxName); err != nil {
			b.Issue(row, "Email", SevError, "too_long", "Email "+err.Error(), c.Email)
		} else if !ValidEmail(c.Email) {
			b.Issue(row, "Email", SevWarning, "invalid_email", "format email tampak salah", c.Email)
		}
	}
	c.Birthday = optionalDate(b, row, "Tanggal Lahir")
	c.Anniversary = optionalDate(b, row, "Anniversary")
	c.Notes = cells["Catatan"]
	if err := CheckLen(c.Notes, MaxText); err != nil {
		b.Issue(row, "Catatan", SevError, "too_long", "Catatan "+err.Error(), "")
	}
	return c, true
}

// optionalDate parses a blank-or-date cell; a bad value is an error on the row.
func optionalDate(b *Builder, row Row, column string) string {
	raw := strings.TrimSpace(row.Cells[column])
	if raw == "" {
		return ""
	}
	d, err := ParseDate(raw)
	if err != nil {
		b.Issue(row, column, SevError, "invalid_date", column+": "+err.Error(), raw)
		return ""
	}
	return d
}

func rowKey(primary, fallback string) string {
	if p := strings.TrimSpace(primary); p != "" {
		return p
	}
	return strings.TrimSpace(fallback)
}
