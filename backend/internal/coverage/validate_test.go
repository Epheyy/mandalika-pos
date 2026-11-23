package coverage

import (
	"errors"
	"reflect"
	"testing"
)

func TestValidate(t *testing.T) {
	tests := []struct {
		name string
		role string
		home string
		ids  []string
		all  bool
		want error
	}{
		{"cashier with home only", "cashier", "A", nil, false, nil},
		{"cashier with [home]", "cashier", "A", []string{"a"}, false, nil},
		{"cashier without home", "cashier", "", nil, false, ErrCashierOneOutlet},
		{"cashier with two outlets", "cashier", "A", []string{"A", "B"}, false, ErrCashierOneOutlet},
		{"cashier with all outlets", "cashier", "A", nil, true, ErrCashierOneOutlet},
		{"manager all", "manager", "", nil, true, nil},
		{"manager all with a home", "manager", "A", nil, true, ErrAllWithHome},
		{"manager all with a list", "manager", "", []string{"A"}, true, ErrAllWithHome},
		{"manager unassigned", "manager", "", nil, false, ErrManagerNeedsCoverage},
		{"manager list without home", "manager", "", []string{"A"}, false, ErrManagerNeedsCoverage},
		{"manager home only", "manager", "A", nil, false, nil},
		{"manager home A with [A,B]", "manager", "A", []string{"A", "B"}, false, nil},
		{"manager home outside the list", "manager", "C", []string{"A", "B"}, false, ErrHomeNotCovered},
		{"admin plain", "admin", "", nil, false, nil},
		{"admin with all outlets", "admin", "", nil, true, ErrAdminNoCoverage},
		{"admin with a list", "admin", "", []string{"A"}, false, ErrAdminNoCoverage},
		{"unknown role is not validated here", "ghost", "", nil, false, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Validate(tc.role, tc.home, tc.ids, tc.all); !errors.Is(got, tc.want) {
				t.Fatalf("Validate() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestValidateTexts(t *testing.T) {
	want := map[error]string{
		ErrCashierOneOutlet:     "Kasir harus ditempatkan di tepat satu outlet.",
		ErrManagerNeedsCoverage: "Manajer perlu Semua Outlet atau minimal satu outlet.",
		ErrHomeNotCovered:       "Outlet utama harus termasuk outlet yang dicakup.",
		ErrAdminNoCoverage:      "Admin tidak memakai daftar outlet.",
		ErrAllWithHome:          "Semua Outlet tidak bisa digabung dengan outlet utama.",
	}
	for err, text := range want {
		if err.Error() != text {
			t.Errorf("%q, want %q", err.Error(), text)
		}
	}
}

func TestExtras(t *testing.T) {
	tests := []struct {
		name string
		role string
		home string
		ids  []string
		all  bool
		want []string
	}{
		{"manager keeps the list minus home", "manager", "A", []string{"A", "b", "B"}, false, []string{"b"}},
		{"manager all keeps none", "manager", "", []string{"A"}, true, []string{}},
		{"cashier keeps none", "cashier", "A", []string{"A", "B"}, false, []string{}},
		{"admin keeps none", "admin", "", []string{"A"}, false, []string{}},
		{"home-less manager keeps none", "manager", "", []string{"A"}, false, []string{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Extras(tc.role, tc.home, tc.ids, tc.all); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Extras() = %#v, want %#v", got, tc.want)
			}
		})
	}
}
