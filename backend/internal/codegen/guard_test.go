package codegen

import (
	"bytes"
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const validSpec = `{"openapi":"3.0.3","info":{"title":"Owned test","version":"1"},"paths":{},"components":{"schemas":{"Node":{"type":"object","properties":{"next":{"$ref":"#/components/schemas/Node"}}}}}}`
const simpleConfig = "package: fixture\noutput: out.go\ngenerate:\n  models: true\noutput-options:\n  skip-prune: true\n"

func fixture(t *testing.T, spec string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "api"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, b := range map[string]string{"api/spec.json": spec, "api/config.yaml": simpleConfig, "out.go": "package fixture\n// old complete file\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(b), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestGuardValidRecursiveAndDeterministic(t *testing.T) {
	r := fixture(t, validSpec)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := Run(ctx, r, "api/spec.json", "api/config.yaml", false, Generate); err != nil {
			t.Fatal(err)
		}
	}
	if err := Run(ctx, r, "api/spec.json", "api/config.yaml", true, Generate); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r, "out.go"), []byte("package fixture\n// drift\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Run(ctx, r, "api/spec.json", "api/config.yaml", true, Generate); err == nil {
		t.Fatal("drift passed")
	}
	b, _ := os.ReadFile(filepath.Join(r, "out.go"))
	if !bytes.Contains(b, []byte("drift")) {
		t.Fatal("check mode rewrote output")
	}
}

func TestGuardBoundaryRejectsKOObservations(t *testing.T) {
	unused := `{"openapi":"3.0.3","info":{"title":"Owned","version":"1"},"paths":{},"components":{"schemas":{"A":{"$ref":"#/components/schemas/A/additionalProperties"}}}}`
	used := strings.Replace(unused, `"paths":{}`, `"paths":{"/a":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"$ref":"#/components/schemas/A"}}}}}}}}`, 1)
	for name, spec := range map[string]string{"KO-unused": unused, "KO-reachable": used, "missing": strings.Replace(validSpec, "#/components/schemas/Node", "#/components/schemas/Missing", 1), "malformed": "{", "remote": strings.Replace(validSpec, "#/components/schemas/Node", "https://example.invalid/never-fetch.json", 1), "escape": strings.Replace(validSpec, "#/components/schemas/Node", "../outside.json", 1)} {
		t.Run(name, func(t *testing.T) {
			r := fixture(t, spec)
			before, _ := os.ReadFile(filepath.Join(r, "out.go"))
			err := Run(context.Background(), r, "api/spec.json", "api/config.yaml", false, Generate)
			if err == nil {
				t.Fatal("invalid spec published")
			}
			after, _ := os.ReadFile(filepath.Join(r, "out.go"))
			if !bytes.Equal(before, after) {
				t.Fatal("old output changed")
			}
		})
	}
}

func TestGuardLocalReferenceSnapshot(t *testing.T) {
	r := fixture(t, strings.Replace(validSpec, "#/components/schemas/Node", "child.json#/components/schemas/Node", 1))
	if err := os.WriteFile(filepath.Join(r, "api/child.json"), []byte(validSpec), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r, "api/config.yaml"), []byte(simpleConfig+"import-mapping:\n  child.json: '-'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := Run(context.Background(), r, "api/spec.json", "api/config.yaml", false, Generate); err != nil {
		t.Fatal(err)
	}
}

func TestGuardPreservesOutputOnFailures(t *testing.T) {
	for _, kind := range []string{"generator", "output-parse", "output-init", "output-package", "publish", "cancel", "timeout", "input-race", "config-race", "reference-race", "output-race"} {
		t.Run(kind, func(t *testing.T) {
			r := fixture(t, validSpec)
			before, _ := os.ReadFile(filepath.Join(r, "out.go"))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			replace := os.Rename
			if kind == "publish" {
				replace = func(string, string) error { return errors.New("controlled publication failure") }
			}
			generate := func(ctx context.Context, s Snapshot) ([]byte, error) {
				switch kind {
				case "generator":
					return nil, errors.New("controlled generator failure")
				case "output-parse":
					return []byte("not Go"), nil
				case "output-init":
					return []byte("package fixture\nfunc init(){}"), nil
				case "output-package":
					return []byte("package wrong"), nil
				case "cancel":
					cancel()
				case "timeout":
					<-ctx.Done()
				case "input-race":
					if err := os.WriteFile(filepath.Join(r, "api/spec.json"), []byte("{}"), 0600); err != nil {
						t.Fatal(err)
					}
				case "config-race":
					if err := os.WriteFile(filepath.Join(r, "api/config.yaml"), []byte(simpleConfig+"# changed\n"), 0600); err != nil {
						t.Fatal(err)
					}
				case "reference-race":
					if err := os.WriteFile(filepath.Join(r, "api/new.json"), []byte("{}"), 0600); err != nil {
						t.Fatal(err)
					}
				case "output-race":
					before = []byte("package fixture\n// another writer\n")
					if err := os.WriteFile(filepath.Join(r, "out.go"), before, 0600); err != nil {
						t.Fatal(err)
					}
				}
				return []byte("package fixture\n// new output\n"), nil
			}
			if kind == "timeout" {
				var deadline context.CancelFunc
				ctx, deadline = context.WithTimeout(ctx, 10*time.Millisecond)
				defer deadline()
			}
			if err := run(ctx, r, "api/spec.json", "api/config.yaml", false, generate, replace); err == nil {
				t.Fatal("failure allowed publication")
			}
			after, _ := os.ReadFile(filepath.Join(r, "out.go"))
			if !bytes.Equal(before, after) {
				t.Fatal("old/other writer output destroyed")
			}
			for _, pattern := range []string{".codegen.lock", ".codegen-*.go"} {
				matches, _ := filepath.Glob(filepath.Join(r, pattern))
				if len(matches) != 0 {
					t.Fatal("owned temporary state left", matches)
				}
			}
		})
	}
}

func TestGuardConcurrentWriterAndCommitPoint(t *testing.T) {
	r := fixture(t, validSpec)
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- Run(context.Background(), r, "api/spec.json", "api/config.yaml", false, func(context.Context, Snapshot) ([]byte, error) {
			close(started)
			<-release
			return []byte("package fixture\n// first\n"), nil
		})
	}()
	<-started
	if err := Run(context.Background(), r, "api/spec.json", "api/config.yaml", false, Generate); err == nil {
		t.Fatal("concurrent writer entered")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := run(ctx, r, "api/spec.json", "api/config.yaml", false, func(context.Context, Snapshot) ([]byte, error) { return []byte("package fixture\n// committed\n"), nil }, func(a, b string) error { err := os.Rename(a, b); cancel(); return err })
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(r, "out.go"))
	if !bytes.Contains(b, []byte("committed")) {
		t.Fatal("commit not preserved")
	}
}

func TestGuardOutputPrecedenceAndUnsupportedInputs(t *testing.T) {
	for _, extra := range []string{"output: ../outside.go\n", "output-options:\n  user-templates:\n    x: https://example.invalid/x\n", "output-options:\n  overlay:\n    path: remote.yaml\n", "unknown: true\n"} {
		r := fixture(t, validSpec)
		config := "package: fixture\ngenerate:\n  models: true\n" + extra
		if err := os.WriteFile(filepath.Join(r, "api/config.yaml"), []byte(config), 0600); err != nil {
			t.Fatal(err)
		}
		if err := Run(context.Background(), r, "api/spec.json", "api/config.yaml", false, Generate); err == nil {
			t.Fatal("unsupported config passed")
		}
	}
}

// Real child process failure/cancellation paths use the same ProcessWorker.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "-worker" {
		if os.Getenv("MANDALIKA_GUARD_TEST_CHILD") == "wait" {
			time.Sleep(10 * time.Second)
			os.Exit(0)
		}
		os.Exit(9)
	}
	os.Exit(m.Run())
}
func TestGuardWorkerProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MANDALIKA_GUARD_TEST_CHILD", "fail")
	if _, err := ProcessWorker(exe)(context.Background(), Snapshot{}); err == nil {
		t.Fatal("failed worker accepted")
	}
	t.Setenv("MANDALIKA_GUARD_TEST_CHILD", "wait")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := ProcessWorker(exe)(ctx, Snapshot{}); err == nil {
		t.Fatal("timed out worker accepted")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("child not bounded/reaped")
	}
}

func TestGuardInertEscaping(t *testing.T) {
	for _, name := range []string{"inert-enum", "inert-path", "inert-server"} {
		t.Run(name, func(t *testing.T) {
			b, err := os.ReadFile("testdata/" + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			cfg := "package: fixture\noutput: generated.go\ngenerate:\n  models: true\n  chi-server: true\n  embedded-spec: true\n  server-urls: true\noutput-options:\n  nullable-type: true\n"
			out, err := Generate(context.Background(), Snapshot{Spec: "api/spec.json", Config: "api/config.yaml", Files: map[string][]byte{"api/spec.json": b, "api/config.yaml": []byte(cfg)}})
			if err != nil {
				if !strings.Contains(err.Error(), "validate:") {
					t.Fatal(err)
				}
				t.Log("rejected by whole-document validation before generation")
				return
			}
			set := token.NewFileSet()
			file, err := parser.ParseFile(set, "inert.go", out, parser.ParseComments)
			if err != nil {
				t.Fatal(err)
			}
			type span struct{ start, end int }
			var spans []span
			ast.Inspect(file, func(n ast.Node) bool {
				switch n := n.(type) {
				case *ast.BasicLit:
					if n.Kind == token.STRING {
						spans = append(spans, span{set.Position(n.Pos()).Offset, set.Position(n.End()).Offset})
					}
				case *ast.Comment:
					spans = append(spans, span{set.Position(n.Pos()).Offset, set.Position(n.End()).Offset})
				}
				return true
			})
			found := 0
			for offset := 0; offset < len(out); {
				i := bytes.Index(out[offset:], []byte("KB_"))
				if i < 0 {
					break
				}
				i += offset
				safe := false
				for _, s := range spans {
					if i >= s.start && i < s.end {
						safe = true
					}
				}
				if !safe {
					t.Fatal("sentinel escaped string/comment")
				}
				found++
				offset = i + 3
			}
			if found == 0 {
				t.Fatal("fixture not emitted")
			}
			t.Log("AST inspected; generated code never compiled or executed")
		})
	}
}
