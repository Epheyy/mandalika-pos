package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// fg is one run-unique finished good. Letter A..D; D is created by the stub hook at run
// time (the incremental-pull step) and is never part of a printed seed.
type fg struct {
	Letter, Code, Slug, Name string
}

const (
	warehouseSlug = "gudang-pusat"
	fgCategory    = "Rehearsal"
	seedStamp     = "2026-01-01T00:00:00Z"
)

// normID reduces a run id to lowercase alphanumerics so codes and slugs stay valid.
func normID(runID string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(runID) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// fixtures derives the run's FGs: code RH-<ID>-A, slug rh-<id>-a, name "Rehearsal <ID> Alpha 50ml".
func fixtures(runID string) []fg {
	id := normID(runID)
	names := []string{"Alpha", "Bravo", "Charlie", "Delta"}
	out := make([]fg, 0, len(names))
	for i, n := range names {
		l := string(rune('A' + i))
		out = append(out, fg{
			Letter: l,
			Code:   "RH-" + strings.ToUpper(id) + "-" + l,
			Slug:   "rh-" + id + "-" + strings.ToLower(l),
			Name:   fmt.Sprintf("Rehearsal %s %s 50ml", strings.ToUpper(id), n),
		})
	}
	return out
}

func fgRecord(f fg, stamp string) obj {
	return obj{
		"slug": f.Slug, "code": f.Code, "name": f.Name, "category": fgCategory,
		"description": nil, "gender": "UNISEX", "is_others": false, "size": 50,
		"status": "ACTIVE", "unit": "PCS", "created_at": stamp, "updated_at": stamp, "deleted_at": nil,
	}
}

// outletSlugFor is the stub slug the rehearsal uses for the POS outlet unless the POS
// outlet is already linked (then its erp_slug wins).
func outletSlugFor(code, override string) string {
	if override != "" {
		return override
	}
	return "rehearsal-" + strings.ToLower(code)
}

func outletRecord(slug, code, name, stamp string) obj {
	return obj{
		"slug": slug, "code": code, "name": name, "type": "RETAIL", "address": nil, "phone": nil,
		"latitude": nil, "longitude": nil, "created_at": stamp, "updated_at": stamp, "deleted_at": nil,
	}
}

// printSeed writes a stub seed (same format as erpstub/seed.json) holding exactly the
// run's FGs A..C, one outlet and the warehouse. FG D is created by the hook during the
// run (it has to be new to the incremental pull), so it is NOT in the seed.
func printSeed(w io.Writer, runID, outletCode, outletSlug string) error {
	if normID(runID) == "" || outletCode == "" {
		return fmt.Errorf("-print-seed needs -run-id and -outlet-code")
	}
	var fgs []obj
	for _, f := range fixtures(runID)[:3] {
		fgs = append(fgs, fgRecord(f, seedStamp))
	}
	seed := obj{
		"finished_goods": fgs,
		"outlets":        []obj{outletRecord(outletSlugFor(outletCode, outletSlug), outletCode, "Rehearsal outlet "+outletCode, seedStamp)},
		"warehouses":     []obj{{"slug": warehouseSlug, "name": "Gudang Pusat"}},
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(seed)
}
