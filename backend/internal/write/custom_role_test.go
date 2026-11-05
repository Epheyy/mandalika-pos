package write

import "testing"

func TestValidateCustomRole(t *testing.T) {
	cases := []struct {
		name    string
		role    CustomRole
		wantErr bool
	}{
		{"no permissions", CustomRole{Name: "Kasir", Permissions: nil}, true},
		{"empty permissions", CustomRole{Name: "Kasir", Permissions: []string{}}, true},
		{"blank permission only", CustomRole{Name: "Kasir", Permissions: []string{" "}}, true},
		{"blank name", CustomRole{Name: "  ", Permissions: []string{"orders.read"}}, true},
		{"ok", CustomRole{Name: "Kasir", Permissions: []string{"orders.read"}}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := validateCustomRole(c.role); (err != nil) != c.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, c.wantErr)
			}
		})
	}
}
