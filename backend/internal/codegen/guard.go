// Package codegen implements the project's offline, validated generation boundary.
// It is a build tool, not request-validation middleware or an arbitrary-spec sandbox.
package codegen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	upstream "github.com/oapi-codegen/oapi-codegen/v2/pkg/codegen"
	"go.yaml.in/yaml/v3"
)

const maxInput = 8 << 20
const maxOutput = 16 << 20

type configuration struct {
	upstream.Configuration `yaml:",inline"`
	Output                 string `yaml:"output"`
}

// Snapshot is an owned in-memory copy. The worker never opens a specification,
// template, overlay, environment file or remote reference from its filesystem.
type Snapshot struct {
	Spec   string
	Config string
	Files  map[string][]byte
}

func readConfig(s Snapshot) (configuration, error) {
	var c configuration
	d := yaml.NewDecoder(bytes.NewReader(s.Files[s.Config]))
	d.KnownFields(true)
	if err := d.Decode(&c); err != nil {
		return c, err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return c, errors.New("one configuration document required")
	}
	// These inputs have never been part of the project's canonical command. Fail
	// closed until a future reviewed snapshot contract explicitly supports them.
	if len(c.OutputOptions.UserTemplates) != 0 || c.OutputOptions.Overlay.Path != "" || len(c.AdditionalImports) != 0 {
		return c, errors.New("external templates/overlays/import mappings are unsupported")
	}
	for ref, target := range c.ImportMapping {
		if target != "-" || !relative(ref) || s.Files[path.Join(path.Dir(s.Spec), ref)] == nil {
			return c, errors.New("only frozen local self import mappings supported")
		}
	}
	c.Configuration = c.Configuration.UpdateDefaults()
	return c, c.Configuration.Validate()
}

func relative(p string) bool {
	return p != "." && p != "" && !filepath.IsAbs(p) && filepath.VolumeName(p) == "" && !strings.Contains(p, "\\") && p != ".." && !strings.HasPrefix(p, "../") && path.Clean(p) == p
}

// freeze includes all bounded regular JSON/YAML files under api, so transitive
// local references are immutable even if upstream resolves them lazily.
func freeze(root, spec, config string) (Snapshot, error) {
	s := Snapshot{Spec: spec, Config: config, Files: map[string][]byte{}}
	if !relative(spec) || !relative(config) || !strings.HasPrefix(spec, "api/") || !strings.HasPrefix(config, "api/") {
		return s, errors.New("inputs must be relative paths under api")
	}
	total := 0
	err := filepath.WalkDir(filepath.Join(root, "api"), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("symlink input refused")
		}
		if d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		if ext != ".yaml" && ext != ".yml" && ext != ".json" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > maxInput || len(s.Files) >= 128 {
			return errors.New("input bounds exceeded")
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(f, maxInput+1))
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		total += len(b)
		if total > maxInput {
			return errors.New("input bounds exceeded")
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		s.Files[filepath.ToSlash(rel)] = b
		return nil
	})
	if err == nil && (s.Files[spec] == nil || s.Files[config] == nil) {
		err = errors.New("required input missing")
	}
	return s, err
}

// Generate validates and generates the SAME in-memory document with no file
// output capability. Upstream's config.output/CLI precedence cannot publish.
func Generate(ctx context.Context, s Snapshot) ([]byte, error) {
	c, err := readConfig(s)
	if err != nil {
		return nil, err
	}
	loader := openapi3.NewLoader()
	loader.Context = ctx
	loader.IsExternalRefsAllowed = true
	loader.ReadFromURIFunc = func(_ *openapi3.Loader, u *url.URL) ([]byte, error) {
		if u.Scheme != "" || u.Host != "" || u.RawQuery != "" || !relative(u.Path) {
			return nil, errors.New("reference outside frozen local snapshot")
		}
		b, ok := s.Files[u.Path]
		if !ok {
			return nil, errors.New("reference absent from frozen snapshot")
		}
		return b, nil
	}
	doc, err := loader.LoadFromDataWithPath(s.Files[s.Spec], &url.URL{Path: s.Spec})
	if err != nil {
		return nil, fmt.Errorf("load: %w", err)
	}
	if err = doc.Validate(ctx); err != nil {
		return nil, fmt.Errorf("validate: %w", err)
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	// This is provenance for the real linked library, not an invented version.
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/oapi-codegen/oapi-codegen/v2" {
				v := dep.Version
				c.NoVCSVersionOverride = &v
			}
		}
	}
	code, err := upstream.Generate(doc, c.Configuration)
	if err != nil {
		return nil, fmt.Errorf("generate: %w", err)
	}
	return checkOutput([]byte(code), c.PackageName)
}

func checkOutput(b []byte, pkg string) ([]byte, error) {
	if len(b) == 0 || len(b) > maxOutput {
		return nil, errors.New("output bounds exceeded")
	}
	f, err := parser.ParseFile(token.NewFileSet(), "generated.go", b, parser.ParseComments|parser.AllErrors)
	if err != nil {
		return nil, err
	}
	if f.Name.Name != pkg {
		return nil, errors.New("unexpected generated package")
	}
	for _, decl := range f.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.Name == "init" {
			return nil, errors.New("generated init refused")
		}
	}
	for _, imp := range f.Imports {
		name, err := strconv.Unquote(imp.Path.Value)
		if err != nil || name == "os/exec" || name == "unsafe" {
			return nil, errors.New("unsafe generated import")
		}
	}
	return format.Source(b)
}

type worker func(context.Context, Snapshot) ([]byte, error)

// Run serializes canonical writers. A crash may leave a lock requiring inspection;
// it is never stolen. Check mode compares without rewriting the checked-in file.
func Run(ctx context.Context, root, spec, config string, check bool, generate worker) error {
	return run(ctx, root, spec, config, check, generate, os.Rename)
}

func run(ctx context.Context, root, spec, config string, check bool, generate worker, replace func(string, string) error) error {
	var err error
	root, err = filepath.Abs(root)
	if err != nil {
		return err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	lock := filepath.Join(root, ".codegen.lock")
	if err := os.Mkdir(lock, 0700); err != nil {
		return fmt.Errorf("generation lock unavailable: %w", err)
	}
	defer os.Remove(lock) // only our empty lock; never delete a foreign/stale lock
	s, err := freeze(root, spec, config)
	if err != nil {
		return err
	}
	c, err := readConfig(s)
	if err != nil {
		return err
	}
	if !relative(c.Output) || strings.HasPrefix(c.Output, "api/") {
		return errors.New("output must be a relative non-input path")
	}
	dest := filepath.Join(root, filepath.FromSlash(c.Output))
	// Reject redirected output paths, including symlinked parent directories.
	parent, err := filepath.EvalSymlinks(filepath.Dir(dest))
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(filepath.Dir(dest))
	if err != nil || parent != abs {
		return errors.New("redirected output parent")
	}
	if info, err := os.Lstat(dest); err == nil && !info.Mode().IsRegular() {
		return errors.New("non-regular output refused")
	}
	old, err := os.ReadFile(dest)
	missing := errors.Is(err, os.ErrNotExist)
	if err != nil && !missing {
		return err
	}
	code, err := generate(ctx, s)
	if err != nil {
		return err
	}
	code, err = checkOutput(code, c.PackageName)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	now, err := freeze(root, spec, config)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(s, now) {
		return errors.New("inputs changed during generation; refusing stale publication")
	}
	current, err := os.ReadFile(dest)
	if (err != nil && !errors.Is(err, os.ErrNotExist)) || missing != errors.Is(err, os.ErrNotExist) || !bytes.Equal(old, current) {
		return errors.New("output changed during generation")
	}
	if check {
		if !bytes.Equal(old, code) || missing {
			return errors.New("generated contract drift; run make gen-go")
		}
		return nil
	}
	tmp, err := os.CreateTemp(parent, ".codegen-*.go")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(code); err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Chmod(tmp.Name(), 0644); err != nil {
		return err
	}
	// Recheck after the temp write. This is optimistic input freshness, not a
	// transaction with arbitrary editors or a power-loss durability guarantee.
	now, err = freeze(root, spec, config)
	if err != nil || !reflect.DeepEqual(s, now) {
		return errors.New("inputs changed before publication")
	}
	current, err = os.ReadFile(dest)
	if (err != nil && !errors.Is(err, os.ErrNotExist)) || missing != errors.Is(err, os.ErrNotExist) || !bytes.Equal(old, current) {
		return errors.New("output changed before publication")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// Single commit point on the destination filesystem. Cancellation after this
	// successful replacement may leave the new COMPLETE output; no rollback claim.
	return replace(tmp.Name(), dest)
}

type boundedBuffer struct {
	bytes.Buffer
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.max {
		return 0, errors.New("worker output limit")
	}
	return b.Buffer.Write(p)
}

// ProcessWorker runs only this executable's library worker, with frozen stdin.
// CommandContext kills and waits for it on cancellation/deadline; no descendants
// or external generator commands are launched by the worker.
func ProcessWorker(executable string) worker {
	return func(ctx context.Context, s Snapshot) ([]byte, error) {
		input, err := json.Marshal(s)
		if err != nil {
			return nil, err
		}
		cmd := exec.CommandContext(ctx, executable, "-worker")
		cmd.Stdin = bytes.NewReader(input)
		out := &boundedBuffer{max: maxOutput}
		stderr := &boundedBuffer{max: 64 << 10}
		cmd.Stdout, cmd.Stderr = out, stderr
		cmd.WaitDelay = 2 * time.Second
		if err = cmd.Run(); err != nil {
			return nil, fmt.Errorf("generation worker failed: %w: %s", err, stderr.String())
		}
		return out.Bytes(), nil
	}
}

// Worker reads one bounded snapshot. Memory/stack limits constrain accidental
// pathological input; the supervisor deadline is the hard wall-clock boundary.
func Worker(ctx context.Context, in io.Reader, out io.Writer) error {
	debug.SetMemoryLimit(256 << 20)
	debug.SetMaxStack(2 << 20)
	var s Snapshot
	b, err := io.ReadAll(io.LimitReader(in, 2*maxInput+1))
	if err != nil {
		return err
	}
	if len(b) > 2*maxInput {
		return errors.New("snapshot limit")
	}
	if err = json.Unmarshal(b, &s); err != nil {
		return err
	}
	code, err := Generate(ctx, s)
	if err != nil {
		return err
	}
	_, err = out.Write(code)
	return err
}
