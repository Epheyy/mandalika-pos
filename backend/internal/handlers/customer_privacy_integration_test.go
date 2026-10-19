package handlers

import (
	"encoding/json"
	"os"
	"testing"
)

// A30 customer privacy: phone-only cashier lookup, role-scoped customer reads, a stripped
// pull bundle and a restricted order search. Opt-in only, same isolation contract as the
// other PostgreSQL gates (fixture "CP", port 56464).
func TestCustomerPrivacyPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "CP", 56464)

	t.Run("sql normalize_phone matches the shared vectors", func(t *testing.T) {
		raw, err := os.ReadFile("../../../packages/sync/src/__fixtures__/phone-vectors.json")
		if err != nil {
			t.Fatal(err)
		}
		var vs []struct{ Input, Norm string }
		if err := json.Unmarshal(raw, &vs); err != nil {
			t.Fatal(err)
		}
		for _, v := range vs {
			var got string
			if err := pool.QueryRow(ctx, `SELECT normalize_phone($1)`, v.Input).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != v.Norm {
				t.Errorf("normalize_phone(%q) = %q, want %q", v.Input, got, v.Norm)
			}
		}
	})

	t.Run("phone_norm is generated and indexed", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO customers(id,name,phone) VALUES('00000000-0000-4000-8f20-0000000000a1','CP gen','+62 812-0000-1111')`); err != nil {
			t.Fatal(err)
		}
		var norm string
		if err := pool.QueryRow(ctx, `SELECT phone_norm FROM customers WHERE id='00000000-0000-4000-8f20-0000000000a1'`).Scan(&norm); err != nil {
			t.Fatal(err)
		}
		if norm != "081200001111" {
			t.Fatalf("phone_norm = %q", norm)
		}
		var idx int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE indexname='idx_customers_phone_norm'`).Scan(&idx); err != nil || idx != 1 {
			t.Fatalf("index missing: %d %v", idx, err)
		}
	})
}
