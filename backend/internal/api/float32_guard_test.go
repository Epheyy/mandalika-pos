package api

import (
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"reflect"
	"strings"
	"testing"
)

// Non-money JSON names that may legitimately be float32 (quantities and rates).
var float32NonMoneyNames = map[string]bool{
	"qty": true, "newQty": true, "sentQty": true, "receivedQty": true, "difference": true,
	"counted": true, "onHandTotal": true, "taxRate": true, "pointsPerThousand": true,
	"redemptionRate": true,
}

// "total" is a money name everywhere except the ingredient overview quantity sum.
var float32NonMoneyScoped = map[string]bool{"IngredientOverviewRow.total": true}

// D-1 guard: oapi-codegen maps `type: number` without `format: double` to float32,
// which rounds Rupiah above 2^24. Parses api.gen.go (so every generated struct is
// covered, not a hand-kept list) and fails on any float32 field outside the allowlist.
func TestNoFloat32MoneyFieldsInGeneratedAPI(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "api.gen.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	ast.Inspect(file, func(n ast.Node) bool {
		ts, ok := n.(*ast.TypeSpec)
		if !ok {
			return true
		}
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			return true
		}
		for _, f := range st.Fields.List {
			var sb strings.Builder
			if err := printer.Fprint(&sb, fset, f.Type); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(sb.String(), "float32") {
				continue
			}
			checked++
			jsonName := ""
			if f.Tag != nil {
				tag := reflect.StructTag(strings.Trim(f.Tag.Value, "`")).Get("json")
				jsonName = strings.Split(tag, ",")[0]
			}
			if float32NonMoneyNames[jsonName] || float32NonMoneyScoped[ts.Name.Name+"."+jsonName] {
				continue
			}
			t.Errorf("%s.%s (json %q) is %s: add `format: double` to the OpenAPI schema (money) or allowlist it as non-money", ts.Name.Name, strings.Join(fieldNames(f), ","), jsonName, sb.String())
		}
		return true
	})
	if checked == 0 {
		t.Fatal("found no float32 fields at all: the guard is not parsing api.gen.go correctly")
	}
}

func fieldNames(f *ast.Field) []string {
	var out []string
	for _, n := range f.Names {
		out = append(out, n.Name)
	}
	return out
}
