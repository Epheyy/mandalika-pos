# Reorganisation helper tools (companion to 2026-10-22-reorg-and-erp-demo-plan.md)

Stdlib-only Go tools used by the R1–R5 dry run. **Keep them outside the repo** (build in a scratch directory); committing them would make the reorg more than moves (decision D3). Source copied verbatim from the planning notes of 2026-10-21; the dry run used exactly this code.

## declhash (stdlib only). Build it in its own directory with go.mod `module declhash` / `go 1.26`, using `go build -o declhash`. Usage: `declhash <pkgdir>...`. The splitter and lister below need the same two-line go.mod in their own directories.
```go
// declhash prints one line per top-level declaration of the non-test .go files in
// each package dir given: "D <pkg> <kind> <recv.>name sha256" over the exact bytes
// from the doc comment start to the decl end, and "C <pkg> sha256 <first line>" for
// every comment group that is neither a doc comment nor inside a decl (floating
// comments: package docs, section banners, the A42 note). File names are NOT printed,
// so a pure move between files of one package yields identical sorted output.
package main

import (
	"crypto/sha256"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	var lines []string
	for _, dir := range os.Args[1:] {
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		for _, fn := range files {
			if strings.HasSuffix(fn, "_test.go") {
				continue
			}
			src, err := os.ReadFile(fn)
			if err != nil {
				panic(err)
			}
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, fn, src, parser.ParseComments)
			if err != nil {
				panic(err)
			}
			pkg := f.Name.Name
			off := func(p token.Pos) int { return fset.Position(p).Offset }
			h := func(a, b token.Pos) string {
				return fmt.Sprintf("%x", sha256.Sum256(src[off(a):off(b)]))[:16]
			}
			type span struct{ a, b token.Pos }
			var spans []span
			for _, d := range f.Decls {
				start, kind, name := d.Pos(), "", ""
				switch x := d.(type) {
				case *ast.FuncDecl:
					kind, name = "func", x.Name.Name
					if x.Doc != nil {
						start = x.Doc.Pos()
					}
					if x.Recv != nil && len(x.Recv.List) > 0 {
						t := x.Recv.List[0].Type
						if s, ok := t.(*ast.StarExpr); ok {
							t = s.X
						}
						if id, ok := t.(*ast.Ident); ok {
							name = id.Name + "." + name
						}
					}
				case *ast.GenDecl:
					kind = x.Tok.String()
					if x.Doc != nil {
						start = x.Doc.Pos()
					}
					var ns []string
					for _, sp := range x.Specs {
						switch s := sp.(type) {
						case *ast.TypeSpec:
							ns = append(ns, s.Name.Name)
						case *ast.ValueSpec:
							for _, n := range s.Names {
								ns = append(ns, n.Name)
							}
						}
					}
					name = strings.Join(ns, ",")
				}
				spans = append(spans, span{start, d.End()})
				if kind == "import" {
					continue // imports are recomputed per file, not compared
				}
				lines = append(lines, fmt.Sprintf("D %s %s %s %s", pkg, kind, name, h(start, d.End())))
			}
			for _, cg := range f.Comments {
				inside := cg == f.Doc
				for _, s := range spans {
					if cg.Pos() >= s.a && cg.End() <= s.b {
						inside = true
					}
				}
				if inside {
					continue
				}
				first := strings.SplitN(cg.Text(), "\n", 2)[0]
				lines = append(lines, fmt.Sprintf("C %s %s %s", pkg, h(cg.Pos(), cg.End()), first))
			}
			if f.Doc != nil {
				lines = append(lines, fmt.Sprintf("P %s %s", pkg, h(f.Doc.Pos(), f.Doc.End())))
			}
		}
	}
	sort.Strings(lines)
	fmt.Println(strings.Join(lines, "\n"))
}
```

## splitter. Usage: `splitter <src.go> <assigned.tsv>`; run it from the internal/ directory. It refuses to overwrite existing files. The decl lister used for the ranges follows it.
```go
// splitter: move whole top-level decls of one Go file into sibling files.
// usage: splitter <src.go> <assigned.tsv>   (tsv: target \t startLine-endLine \t kind \t name)
// Decl bytes (doc comment .. end) are copied verbatim. Floating comments: kept with the
// next decl unless they are "// ──" section banners (dropped), except a banner whose
// text contains "shared helpers". Imports: each output starts from the source import
// block; unused specs are pruned; go/format is applied.
package main

import (
	"bufio"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	src := os.Args[1]
	b, err := os.ReadFile(src)
	must(err)
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, src, b, parser.ParseComments)
	must(err)
	off := func(p token.Pos) int { return fset.Position(p).Offset }

	// target by decl start line
	target := map[int]string{}
	af, err := os.Open(os.Args[2])
	must(err)
	sc := bufio.NewScanner(af)
	for sc.Scan() {
		p := strings.Split(sc.Text(), "\t")
		ln, _ := strconv.Atoi(strings.Split(p[1], "-")[0])
		target[ln] = p[0]
	}
	var imp *ast.GenDecl
	type piece struct{ start, end int }
	out := map[string][]string{}
	var order []string
	add := func(t, s string) {
		if _, ok := out[t]; !ok {
			order = append(order, t)
		}
		out[t] = append(out[t], s)
	}
	attached := map[*ast.CommentGroup]bool{}
	if f.Doc != nil {
		attached[f.Doc] = true
	}
	var decls []ast.Decl
	for _, d := range f.Decls {
		if g, ok := d.(*ast.GenDecl); ok && g.Tok == token.IMPORT {
			imp = g
			continue
		}
		decls = append(decls, d)
		switch x := d.(type) {
		case *ast.FuncDecl:
			if x.Doc != nil {
				attached[x.Doc] = true
			}
		case *ast.GenDecl:
			if x.Doc != nil {
				attached[x.Doc] = true
			}
		}
	}
	start := func(d ast.Decl) token.Pos {
		switch x := d.(type) {
		case *ast.FuncDecl:
			if x.Doc != nil {
				return x.Doc.Pos()
			}
		case *ast.GenDecl:
			if x.Doc != nil {
				return x.Doc.Pos()
			}
		}
		return d.Pos()
	}
	// floating comments between decls -> pending for next decl
	ci := 0
	cgs := f.Comments
	for _, d := range decls {
		ds := start(d)
		var pre []string
		for ci < len(cgs) && cgs[ci].Pos() < ds {
			cg := cgs[ci]
			ci++
			if attached[cg] || cg.Pos() < imp.End() || cg.Pos() < d.Pos() && cg.Pos() >= ds {
				continue
			}
			txt := string(b[off(cg.Pos()):off(cg.End())])
			if strings.HasPrefix(txt, "// ──") && !strings.Contains(txt, "shared helpers") {
				continue
			}
			pre = append(pre, txt)
		}
		// skip comments inside the decl
		for ci < len(cgs) && cgs[ci].Pos() < d.End() {
			ci++
		}
		t := target[fset.Position(ds).Line]
		if t == "" {
			panic(fmt.Sprintf("no target for line %d", fset.Position(ds).Line))
		}
		for _, p := range pre {
			add(t, p)
		}
		add(t, string(b[off(ds):off(d.End())]))
	}
	impText := string(b[off(imp.Pos()):off(imp.End())])
	header := string(b[:off(imp.Pos())]) // package doc + clause, source file only
	pkgLine := "package " + f.Name.Name + "\n\n"
	base := filepath.Base(src)
	dir := filepath.Dir(src)
	for _, t := range order {
		h := pkgLine
		if t == base {
			h = header
		}
		body := strings.Join(out[t], "\n\n") + "\n"
		code := h + pruneImports(impText, body) + "\n\n" + body
		fm, err := format.Source([]byte(code))
		if err != nil {
			panic(t + ": " + err.Error())
		}
		p := filepath.Join(dir, t)
		if t != base {
			if _, err := os.Stat(p); err == nil {
				panic("refusing to overwrite existing " + p)
			}
		}
		must(os.WriteFile(p, fm, 0o644))
	}
	if _, ok := out[base]; !ok {
		must(os.Remove(src))
	}
}

var specRe = regexp.MustCompile(`^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s+)?"([^"]+)"`)
var verRe = regexp.MustCompile(`^v[0-9]+$`)

func pruneImports(block, body string) string {
	bf, err := parser.ParseFile(token.NewFileSet(), "", "package p\n"+body, 0)
	if err != nil {
		panic(err)
	}
	used := map[string]bool{}
	ast.Inspect(bf, func(n ast.Node) bool {
		if s, ok := n.(*ast.SelectorExpr); ok {
			if id, ok := s.X.(*ast.Ident); ok {
				used[id.Name] = true
			}
		}
		return true
	})
	var keep []string
	for _, ln := range strings.Split(block, "\n") {
		m := specRe.FindStringSubmatch(ln)
		if m == nil || strings.HasPrefix(strings.TrimSpace(ln), "import") {
			keep = append(keep, ln)
			continue
		}
		name := m[1]
		if name == "" {
			parts := strings.Split(m[2], "/")
			name = parts[len(parts)-1]
			if verRe.MatchString(name) && len(parts) > 1 {
				name = parts[len(parts)-2]
			}
		}
		if used[name] {
			keep = append(keep, ln)
		}
	}
	return strings.Join(keep, "\n")
}
```

```go
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

func main() {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, os.Args[1], nil, parser.ParseComments)
	if err != nil {
		panic(err)
	}
	for _, d := range f.Decls {
		start := d.Pos()
		var kind, name string
		switch x := d.(type) {
		case *ast.FuncDecl:
			if x.Doc != nil {
				start = x.Doc.Pos()
			}
			kind = "func"
			name = x.Name.Name
			if x.Recv != nil && len(x.Recv.List) > 0 {
				t := x.Recv.List[0].Type
				if s, ok := t.(*ast.StarExpr); ok {
					t = s.X
				}
				if id, ok := t.(*ast.Ident); ok {
					name = "(" + id.Name + ")." + name
				}
			}
		case *ast.GenDecl:
			if x.Doc != nil {
				start = x.Doc.Pos()
			}
			kind = strings.ToLower(x.Tok.String())
			if kind == "import" {
				continue
			}
			var ns []string
			for _, sp := range x.Specs {
				switch s := sp.(type) {
				case *ast.TypeSpec:
					ns = append(ns, s.Name.Name)
				case *ast.ValueSpec:
					for _, n := range s.Names {
						ns = append(ns, n.Name)
					}
				}
			}
			name = strings.Join(ns, ",")
		}
		fmt.Printf("%d-%d\t%s\t%s\n", fset.Position(start).Line, fset.Position(d.End()).Line, kind, name)
	}
}
```
