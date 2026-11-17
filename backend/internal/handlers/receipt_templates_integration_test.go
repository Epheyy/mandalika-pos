package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/config"
	mw "github.com/mandalika/pos-backend/internal/middleware"
	"github.com/mandalika/pos-backend/internal/read"
	syncpkg "github.com/mandalika/pos-backend/internal/sync"
	"github.com/mandalika/pos-backend/internal/write"
)

// Receipt designer phase 2: template storage, outlet assignment and the pull field. Driven through
// the real handlers; opt-in fresh synthetic cluster (port 26483, prefix RT).
func TestReceiptTemplatesPostgres(t *testing.T) {
	pool, ctx := gatePool(t, "RT", 26483)
	const (
		outA   = "00000000-0000-4000-8f10-000000000001"
		outB   = "00000000-0000-4000-8f10-000000000002"
		outC   = "00000000-0000-4000-8f10-000000000003"
		adminU = "00000000-0000-4000-8f10-000000000011"
		secret = "RT-SYNTHETIC-TEST-KEY"
	)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO outlets(id,name,code,address,phone) VALUES
	  ($1,'RT A','RTA','Jl. Kuta 1','0361 111'),($2,'RT B','RTB',NULL,NULL),($3,'RT C','RTC','Jl. Sanur 3','0361 333')`, outA, outB, outC)
	exec(`INSERT INTO users(id,email,password_hash,display_name,role,outlet_id)
	      VALUES($1,'rt-admin@example.invalid','x','RT Admin','admin',NULL)`, adminU)

	rd, wr := read.New(pool), write.New(pool)
	h := New(rd, nil, auth.NewStore(pool), wr, nil, nil, nil)
	key := []byte(secret)
	tok := func(perms []string) string {
		role := "admin"
		if len(perms) == 1 && perms[0] == "view_reports" {
			role = "cashier" // admin passes every permission check; a plain role does not
		}
		s, err := auth.IssueAccess(key, time.Hour, adminU, role, "", perms)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	router := chi.NewRouter()
	router.Use(mw.RequireAuth(&config.Config{AccessSecret: key}))
	router.Group(func(r chi.Router) {
		r.Use(mw.RequirePermission("manage_settings"))
		r.Get("/receipt-templates", h.ListReceiptTemplates)
		r.Post("/receipt-templates", h.CreateReceiptTemplate)
		r.Put("/receipt-templates/assign", h.AssignReceiptTemplate)
		r.Put("/receipt-templates/{id}", h.UpdateReceiptTemplate)
		r.Delete("/receipt-templates/{id}", h.DeleteReceiptTemplate)
		r.Post("/receipt-templates/test-print", h.SendReceiptTestPrint)
	})
	router.Get("/sync/receipt-test-print", h.GetReceiptTestPrint)
	do := func(perms []string, method, path string, body any) (int, map[string]any) {
		t.Helper()
		var buf bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&buf).Encode(body); err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, &buf)
		r.Header.Set("Authorization", "Bearer "+tok(perms))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	admin := []string{"manage_settings"}

	core := func() []map[string]any {
		return []map[string]any{
			{"id": "i", "type": "items", "enabled": true},
			{"id": "o", "type": "totals", "enabled": true, "showSubtotal": true, "showDiscount": true, "showTax": true},
			{"id": "p", "type": "payment", "enabled": true},
		}
	}
	withText := func(txt string) []map[string]any {
		return append([]map[string]any{{"id": "h", "type": "header", "enabled": true, "text": txt, "size": "normal",
			"showOutletName": true, "showOutletAddress": true, "showOutletPhone": true}}, core()...)
	}
	input := func(name string, blocks []map[string]any, extra map[string]any) map[string]any {
		m := map[string]any{"name": name, "paperWidth": 58, "blocks": blocks}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	create := func(name string, extra map[string]any) string {
		t.Helper()
		code, body := do(admin, http.MethodPost, "/receipt-templates", input(name, withText(name), extra))
		if code != http.StatusCreated {
			t.Fatalf("create %s = %d %v", name, code, body)
		}
		return body["data"].(map[string]any)["id"].(string)
	}
	versionOf := func(outlet string) int64 {
		var v int64
		if err := pool.QueryRow(ctx, `SELECT COALESCE(max(version),0) FROM content_versions WHERE outlet_id=$1`, outlet).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	assignedTo := func(outlet string) *string {
		var s *string
		if err := pool.QueryRow(ctx, `SELECT receipt_template_id::text FROM outlets WHERE id=$1`, outlet).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	listIDs := func(tid string) []string {
		t.Helper()
		_, body := do(admin, http.MethodGet, "/receipt-templates", nil)
		for _, raw := range body["data"].([]any) {
			m := raw.(map[string]any)
			if m["id"] == tid {
				var ids []string
				for _, o := range m["outletIds"].([]any) {
					ids = append(ids, o.(string))
				}
				sort.Strings(ids)
				return ids
			}
		}
		t.Fatalf("template %s not listed", tid)
		return nil
	}
	pull := func(outlet string) syncpkg.PullBundle {
		t.Helper()
		b, err := syncpkg.New(pool, rd, nil, wr).Pull(ctx, read.Scope{OutletID: outlet}, outlet)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	t.Run("pull_omits_receiptTemplate_without_rows", func(t *testing.T) {
		b := pull(outA)
		if b.ReceiptTemplate != nil {
			t.Fatalf("no template rows, yet the pull carries %v", b.ReceiptTemplate.Id)
		}
		raw, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		var keys map[string]json.RawMessage
		_ = json.Unmarshal(raw, &keys)
		if _, ok := keys["receiptTemplate"]; ok {
			t.Fatal("receiptTemplate must be absent from the JSON, not null")
		}
	})

	t.Run("pull_carries_outlet_address_phone", func(t *testing.T) {
		a := pull(outA)
		if a.OutletAddress != "Jl. Kuta 1" || a.OutletPhone != "0361 111" {
			t.Fatalf("outlet A address/phone = %q / %q", a.OutletAddress, a.OutletPhone)
		}
		raw, _ := json.Marshal(pull(outB))
		var keys map[string]json.RawMessage
		_ = json.Unmarshal(raw, &keys)
		if _, ok := keys["outletAddress"]; ok {
			t.Fatal("an outlet without an address must omit outletAddress, not send null or an empty string")
		}
		if _, ok := keys["outletPhone"]; ok {
			t.Fatal("an outlet without a phone must omit outletPhone")
		}
	})

	t.Run("requires_manage_settings", func(t *testing.T) {
		if code, _ := do([]string{"view_reports"}, http.MethodGet, "/receipt-templates", nil); code != http.StatusForbidden {
			t.Fatalf("list without the permission = %d", code)
		}
	})

	var tplA, tplB string
	t.Run("second_template_while_standar_virtual_leaves_null_outlets_and_pull_unchanged", func(t *testing.T) {
		before := []int64{versionOf(outA), versionOf(outB), versionOf(outC)}
		tplA = create("Promo", nil)
		after := []int64{versionOf(outA), versionOf(outB), versionOf(outC)}
		for i := range before {
			if before[i] != after[i] {
				t.Fatalf("a plain create must not bump outlet %d: %v -> %v", i, before, after)
			}
		}
		for _, o := range []string{outA, outB, outC} {
			if assignedTo(o) != nil {
				t.Fatalf("outlet %s was assigned by a create", o)
			}
		}
		if len(listIDs(tplA)) != 0 {
			t.Fatalf("a non-default template with no assignment lists outlets: %v", listIDs(tplA))
		}
	})

	t.Run("create_refuses_locked_removed", func(t *testing.T) {
		code, body := do(admin, http.MethodPost, "/receipt-templates", input("Rusak", []map[string]any{
			{"id": "i", "type": "items", "enabled": true},
			{"id": "o", "type": "totals", "enabled": true},
			{"id": "d", "type": "divider", "enabled": true}}, nil))
		if code != http.StatusUnprocessableEntity || !strings.Contains(fmt.Sprint(body["error"]), "payment") {
			t.Fatalf("create without payment = %d %v", code, body)
		}
	})

	t.Run("create_refuses_duplicate_name_any_case", func(t *testing.T) {
		code, body := do(admin, http.MethodPost, "/receipt-templates", input("  promo ", withText("x"), nil))
		if code != http.StatusConflict {
			t.Fatalf("duplicate name = %d %v", code, body)
		}
	})

	t.Run("assign_moves_outlets_and_bumps_their_version_only", func(t *testing.T) {
		vA, vB, vC := versionOf(outA), versionOf(outB), versionOf(outC)
		code, body := do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA, "outletIds": []string{outA, outB}})
		if code != http.StatusOK {
			t.Fatalf("assign = %d %v", code, body)
		}
		if versionOf(outA) <= vA || versionOf(outB) <= vB || versionOf(outC) != vC {
			t.Fatalf("versions A %d->%d B %d->%d C %d->%d", vA, versionOf(outA), vB, versionOf(outB), vC, versionOf(outC))
		}
		if ids := listIDs(tplA); len(ids) != 2 || ids[0] != outA || ids[1] != outB {
			t.Fatalf("outletIds = %v", ids)
		}
		// Re-assigning the same set changes nothing, so it bumps nothing.
		vA = versionOf(outA)
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA, "outletIds": []string{outA, outB}})
		if versionOf(outA) != vA {
			t.Fatal("a no-op assign bumped the version")
		}
		// Omitting an outlet drops it back to the default.
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA, "outletIds": []string{outA}})
		if assignedTo(outB) != nil || assignedTo(outA) == nil {
			t.Fatal("outlets not listed must leave the template")
		}
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA, "outletIds": []string{outA, outB}})
	})

	t.Run("assign_unknown_outlet_or_template_404", func(t *testing.T) {
		if code, _ := do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA, "outletIds": []string{"00000000-0000-4000-8f10-0000000000ff"}}); code != http.StatusNotFound {
			t.Fatalf("unknown outlet = %d", code)
		}
		if code, _ := do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": "00000000-0000-4000-8f10-0000000000ee", "outletIds": []string{outA}}); code != http.StatusNotFound {
			t.Fatalf("unknown template = %d", code)
		}
	})

	t.Run("assign_without_templateId_moves_outlets_back_to_default", func(t *testing.T) {
		code, body := do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"outletIds": []string{outB}})
		if code != http.StatusOK {
			t.Fatalf("assign default = %d %v", code, body)
		}
		if assignedTo(outB) != nil || assignedTo(outA) == nil {
			t.Fatal("only the listed outlet may go back to the default")
		}
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA, "outletIds": []string{outA, outB}})
	})

	t.Run("update_stale_version_409", func(t *testing.T) {
		code, body := do(admin, http.MethodPut, "/receipt-templates/"+tplA, input("Promo", withText("v2"), map[string]any{"version": 1}))
		if code != http.StatusOK {
			t.Fatalf("update = %d %v", code, body)
		}
		if got := body["data"].(map[string]any)["version"].(float64); got != 2 {
			t.Fatalf("version after save = %v", got)
		}
		code, body = do(admin, http.MethodPut, "/receipt-templates/"+tplA, input("Promo", withText("v3"), map[string]any{"version": 1}))
		if code != http.StatusConflict || !strings.Contains(fmt.Sprint(body["error"]), "sudah diubah di tempat lain") {
			t.Fatalf("stale update = %d %v", code, body)
		}
		if code, _ = do(admin, http.MethodPut, "/receipt-templates/"+tplA, input("Promo", withText("v3"), nil)); code != http.StatusBadRequest {
			t.Fatalf("update without version = %d", code)
		}
	})

	t.Run("update_bumps_only_outlets_on_the_template", func(t *testing.T) {
		vA, vC := versionOf(outA), versionOf(outC)
		code, body := do(admin, http.MethodPut, "/receipt-templates/"+tplA, input("Promo", withText("v3"), map[string]any{"version": 2}))
		if code != http.StatusOK {
			t.Fatalf("update = %d %v", code, body)
		}
		if versionOf(outA) != vA+1 || versionOf(outC) != vC {
			t.Fatalf("A %d->%d C %d->%d", vA, versionOf(outA), vC, versionOf(outC))
		}
	})

	t.Run("update_refuses_locked_removed_and_keeps_the_row", func(t *testing.T) {
		code, _ := do(admin, http.MethodPut, "/receipt-templates/"+tplA, input("Promo", []map[string]any{{"id": "i", "type": "items", "enabled": true}}, map[string]any{"version": 3}))
		if code != http.StatusUnprocessableEntity {
			t.Fatalf("update with one block = %d", code)
		}
		var v int
		_ = pool.QueryRow(ctx, `SELECT version FROM receipt_templates WHERE id=$1`, tplA).Scan(&v)
		if v != 3 {
			t.Fatalf("a refused update changed the version to %d", v)
		}
	})

	t.Run("unknown_template_404", func(t *testing.T) {
		if code, _ := do(admin, http.MethodPut, "/receipt-templates/00000000-0000-4000-8f10-0000000000ee", input("X", withText("x"), map[string]any{"version": 1})); code != http.StatusNotFound {
			t.Fatalf("update unknown = %d", code)
		}
		if code, _ := do(admin, http.MethodDelete, "/receipt-templates/00000000-0000-4000-8f10-0000000000ee", nil); code != http.StatusNotFound {
			t.Fatalf("delete unknown = %d", code)
		}
	})

	t.Run("delete_assigned_409", func(t *testing.T) {
		code, body := do(admin, http.MethodDelete, "/receipt-templates/"+tplA, nil)
		if code != http.StatusConflict || !strings.Contains(fmt.Sprint(body["error"]), "masih dipakai di 2 outlet") {
			t.Fatalf("delete assigned = %d %v", code, body)
		}
	})

	t.Run("delete_unassigned_removes_it", func(t *testing.T) {
		tplB = create("Sementara", nil)
		if code, body := do(admin, http.MethodDelete, "/receipt-templates/"+tplB, nil); code != http.StatusOK {
			t.Fatalf("delete = %d %v", code, body)
		}
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM receipt_templates WHERE id=$1`, tplB).Scan(&n)
		if n != 0 {
			t.Fatal("template still stored")
		}
	})

	var standar string
	t.Run("create_isDefault_refused_when_default_exists", func(t *testing.T) {
		standar = create("Standar", map[string]any{"isDefault": true})
		code, body := do(admin, http.MethodPost, "/receipt-templates", input("Standar 2", withText("x"), map[string]any{"isDefault": true}))
		if code != http.StatusConflict {
			t.Fatalf("second default = %d %v", code, body)
		}
	})

	t.Run("saving_standar_bumps_outlets_without_an_assignment", func(t *testing.T) {
		// Standar was created above: outC (unassigned) now resolves to it; outA and outB (on Promo) do not.
		var bumped bool
		if err := pool.QueryRow(ctx, `SELECT (data_manifest->>'receipt_templates') IS NOT NULL FROM content_versions WHERE outlet_id=$1`, outC).Scan(&bumped); err != nil || !bumped {
			t.Fatalf("outlet C not bumped: %v %v", bumped, err)
		}
	})

	t.Run("list_outletIds_include_default_nulls", func(t *testing.T) {
		if ids := listIDs(standar); len(ids) != 1 || ids[0] != outC {
			t.Fatalf("default outletIds = %v, want only C", ids)
		}
		_, body := do(admin, http.MethodGet, "/receipt-templates", nil)
		first := body["data"].([]any)[0].(map[string]any)
		if first["isDefault"] != true {
			t.Fatalf("the default must list first: %v", first["name"])
		}
	})

	t.Run("delete_default_409", func(t *testing.T) {
		code, body := do(admin, http.MethodDelete, "/receipt-templates/"+standar, nil)
		if code != http.StatusConflict || !strings.Contains(fmt.Sprint(body["error"]), "Standar tidak bisa dihapus") {
			t.Fatalf("delete default = %d %v", code, body)
		}
	})

	t.Run("update_ignores_isDefault", func(t *testing.T) {
		code, body := do(admin, http.MethodPut, "/receipt-templates/"+tplA, input("Promo", withText("v4"), map[string]any{"version": 3, "isDefault": true}))
		if code != http.StatusOK || body["data"].(map[string]any)["isDefault"] != false {
			t.Fatalf("update must not move the default: %d %v", code, body)
		}
	})

	t.Run("assign_default_id_moves_outlets_back_to_it", func(t *testing.T) {
		if code, _ := do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": standar, "outletIds": []string{outB}}); code != http.StatusOK {
			t.Fatal("assign default id failed")
		}
		if assignedTo(outB) != nil || assignedTo(outA) == nil {
			t.Fatal("the default's own id must clear only the listed outlets")
		}
		if ids := listIDs(standar); len(ids) != 2 {
			t.Fatalf("default outletIds = %v", ids)
		}
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA, "outletIds": []string{outA, outB}})
	})

	t.Run("fk_set_null_backstop", func(t *testing.T) {
		tmp := create("Backstop", nil)
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tmp, "outletIds": []string{outC}})
		if assignedTo(outC) == nil {
			t.Fatal("setup: outlet C not assigned")
		}
		exec(`DELETE FROM receipt_templates WHERE id=$1`, tmp)
		if assignedTo(outC) != nil {
			t.Fatal("a raw delete must leave the outlet's assignment NULL")
		}
	})

	t.Run("template_limit_50", func(t *testing.T) {
		var have int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM receipt_templates`).Scan(&have)
		for i := have; i < 50; i++ {
			create(fmt.Sprintf("Bulk %02d", i), nil)
		}
		code, body := do(admin, http.MethodPost, "/receipt-templates", input("Satu lagi", withText("x"), nil))
		if code != http.StatusConflict || !strings.Contains(fmt.Sprint(body["error"]), "Maksimal 50") {
			t.Fatalf("51st template = %d %v", code, body)
		}
		exec(`DELETE FROM receipt_templates WHERE name LIKE 'Bulk %'`)
	})

	t.Run("pull_carries_assigned_template", func(t *testing.T) {
		b := pull(outA)
		if b.ReceiptTemplate == nil || b.ReceiptTemplate.Id.String() != tplA {
			t.Fatalf("outlet A should get Promo, got %+v", b.ReceiptTemplate)
		}
		if b.ReceiptTemplate.Version < 4 || int(b.ReceiptTemplate.PaperWidth) != 58 || len(b.ReceiptTemplate.Blocks) != 4 {
			t.Fatalf("template payload = %+v", b.ReceiptTemplate)
		}
	})

	t.Run("pull_falls_back_to_default", func(t *testing.T) {
		exec(`UPDATE outlets SET receipt_template_id=NULL WHERE id=$1`, outC)
		b := pull(outC)
		if b.ReceiptTemplate == nil || b.ReceiptTemplate.Id.String() != standar {
			t.Fatalf("an unassigned outlet should get Standar, got %+v", b.ReceiptTemplate)
		}
	})

	t.Run("pull_succeeds_when_the_assigned_row_is_gone", func(t *testing.T) {
		tmp := create("Hilang", nil)
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tmp, "outletIds": []string{outC}})
		if b := pull(outC); b.ReceiptTemplate == nil || b.ReceiptTemplate.Id.String() != tmp {
			t.Fatal("setup: outlet C should get the new template")
		}
		exec(`DELETE FROM receipt_templates WHERE id=$1`, tmp)
		b := pull(outC)
		if b.ReceiptTemplate == nil || b.ReceiptTemplate.Id.String() != standar {
			t.Fatalf("with the assigned row gone the pull must fall back to the default, got %+v", b.ReceiptTemplate)
		}
	})

	t.Run("pull_skips_a_row_whose_blocks_are_not_a_list", func(t *testing.T) {
		exec(`UPDATE receipt_templates SET blocks='{}'::jsonb WHERE id=$1`, standar)
		b := pull(outC)
		if b.ReceiptTemplate != nil {
			t.Fatalf("a corrupt row must not be shipped, got %+v", b.ReceiptTemplate)
		}
		exec(`UPDATE receipt_templates SET blocks=$2::jsonb WHERE id=$1`, standar, `[{"id":"i","type":"items","enabled":true},{"id":"o","type":"totals","enabled":true},{"id":"p","type":"payment","enabled":true}]`)
	})

	t.Run("pull_without_a_default_gives_unassigned_outlets_nothing", func(t *testing.T) {
		exec(`UPDATE receipt_templates SET is_default=false WHERE id=$1`, standar)
		defer exec(`UPDATE receipt_templates SET is_default=true WHERE id=$1`, standar)
		if b := pull(outC); b.ReceiptTemplate != nil {
			t.Fatalf("no default and no assignment: want none, got %+v", b.ReceiptTemplate)
		}
		if b := pull(outA); b.ReceiptTemplate == nil || b.ReceiptTemplate.Id.String() != tplA {
			t.Fatal("an assigned outlet still gets its template without a default")
		}
	})

	t.Run("pull_assigned_row_gone_and_no_default_omits_the_template", func(t *testing.T) {
		tmp := create("Hilang 2", nil)
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tmp, "outletIds": []string{outC}})
		exec(`UPDATE receipt_templates SET is_default=false WHERE id=$1`, standar)
		defer exec(`UPDATE receipt_templates SET is_default=true WHERE id=$1`, standar)
		exec(`DELETE FROM receipt_templates WHERE id=$1`, tmp)
		if b := pull(outC); b.ReceiptTemplate != nil {
			t.Fatalf("assigned row gone and no default: want none, got %+v", b.ReceiptTemplate)
		}
	})

	t.Run("assign_requires_outletIds", func(t *testing.T) {
		if code, _ := do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": tplA}); code != http.StatusBadRequest {
			t.Fatalf("assign without outletIds = %d", code)
		}
		if assignedTo(outA) == nil {
			t.Fatal("a refused assign must not unassign outlets")
		}
	})

	// Phase 4: the test-print relay.
	rasterOK := map[string]any{"width": 16, "height": 2, "data": "VVVVVQ=="} // 4 bytes
	draftBlocks := func() []map[string]any {
		return append([]map[string]any{
			{"id": "lg", "type": "image", "enabled": true, "image": rasterOK, "align": "center"},
			{"id": "qr", "type": "qr", "enabled": true, "url": "https://mandalikaperfume.co.id/ulasan", "align": "center"},
		}, core()...)
	}
	sendDraft := func(outlet string, blocks []map[string]any) (int, map[string]any) {
		return do(admin, http.MethodPost, "/receipt-templates/test-print", map[string]any{"outletId": outlet, "paperWidth": 58, "blocks": blocks})
	}
	tabletGet := func(outlet string) (int, map[string]any) {
		s, err := auth.IssueAccess(key, time.Hour, adminU, "cashier", outlet, nil)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/sync/receipt-test-print", nil)
		r.Header.Set("Authorization", "Bearer "+s)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	t.Run("test_print_round_trip_for_outlet", func(t *testing.T) {
		before := versionOf(outB)
		if code, body := sendDraft(outB, draftBlocks()); code != http.StatusOK {
			t.Fatalf("send = %d %v", code, body)
		}
		code, body := tabletGet(outB)
		if code != http.StatusOK {
			t.Fatalf("get = %d %v", code, body)
		}
		data := body["data"].(map[string]any)
		blocks := data["blocks"].([]any)
		if len(blocks) != 5 || blocks[0].(map[string]any)["type"] != "image" || blocks[1].(map[string]any)["url"] != "https://mandalikaperfume.co.id/ulasan" {
			t.Fatalf("draft not returned intact: %v", data)
		}
		if int(data["paperWidth"].(float64)) != 58 {
			t.Fatalf("paperWidth = %v", data["paperWidth"])
		}
		if versionOf(outB) != before {
			t.Fatal("a test print must not bump the outlet's content version")
		}
		// a newer draft replaces the older one
		if code, _ := sendDraft(outB, withText("Baru")); code != http.StatusOK {
			t.Fatal("second send refused")
		}
		_, body = tabletGet(outB)
		if got := body["data"].(map[string]any)["blocks"].([]any); len(got) != 4 {
			t.Fatalf("the newer draft should replace the older, got %d blocks", len(got))
		}
	})

	t.Run("test_print_expires_after_60_min", func(t *testing.T) {
		sendDraft(outB, withText("Lama"))
		exec(`UPDATE receipt_test_prints SET created_at = now() - interval '61 minutes' WHERE outlet_id=$1`, outB)
		if code, _ := tabletGet(outB); code != http.StatusNotFound {
			t.Fatalf("an expired draft must be 404, got %d", code)
		}
		exec(`UPDATE receipt_test_prints SET created_at = now() - interval '59 minutes' WHERE outlet_id=$1`, outB)
		if code, _ := tabletGet(outB); code != http.StatusOK {
			t.Fatalf("a 59-minute-old draft must still be served, got %d", code)
		}
	})

	t.Run("test_print_other_outlet_404", func(t *testing.T) {
		sendDraft(outA, withText("Untuk A"))
		if code, _ := tabletGet(outC); code != http.StatusNotFound {
			t.Fatalf("outlet C has no draft, got %d", code)
		}
	})

	noItems := func(b []map[string]any) []map[string]any { return append([]map[string]any{b[0]}, b[2:]...) }
	t.Run("test_print_refusals", func(t *testing.T) {
		if code, _ := sendDraft(outA, noItems(withText("x"))); code != http.StatusUnprocessableEntity {
			t.Fatalf("a draft without items must be 422, got %d", code)
		}
		bad := draftBlocks()
		bad[1]["url"] = "ftp://x.id"
		if code, _ := sendDraft(outA, bad); code != http.StatusUnprocessableEntity {
			t.Fatalf("a bad QR url must be 422, got %d", code)
		}
		if code, _ := sendDraft("00000000-0000-4000-8f10-0000000000ff", withText("x")); code != http.StatusNotFound {
			t.Fatalf("an unknown outlet must be 404, got %d", code)
		}
		if code, _ := do([]string{"view_reports"}, http.MethodPost, "/receipt-templates/test-print",
			map[string]any{"outletId": outA, "paperWidth": 58, "blocks": withText("x")}); code != http.StatusForbidden {
			t.Fatalf("a non-admin must be 403, got %d", code)
		}
	})

	t.Run("a_template_with_logo_and_qr_saves_and_ships_in_the_pull", func(t *testing.T) {
		id := create("Logo", nil)
		code, body := do(admin, http.MethodPut, "/receipt-templates/"+id, map[string]any{
			"name": "Logo", "paperWidth": 58, "version": 1, "blocks": draftBlocks()})
		if code != http.StatusOK {
			t.Fatalf("update = %d %v", code, body)
		}
		do(admin, http.MethodPut, "/receipt-templates/assign", map[string]any{"templateId": id, "outletIds": []string{outC}})
		b := pull(outC)
		if b.ReceiptTemplate == nil || len(b.ReceiptTemplate.Blocks) != 5 || b.ReceiptTemplate.Blocks[0].Image == nil || b.ReceiptTemplate.Blocks[0].Image.Width != 16 {
			t.Fatalf("pull should carry the raster, got %+v", b.ReceiptTemplate)
		}
	})
}
