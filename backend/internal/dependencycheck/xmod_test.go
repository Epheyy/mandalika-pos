// Package dependencycheck contains test-only dependency regressions. Production
// code does not import sumdb. These fixtures never use HTTP, disk caches or real keys.
package dependencycheck

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"testing"

	"golang.org/x/mod/modfile"
	"golang.org/x/mod/module"
	"golang.org/x/mod/semver"
	"golang.org/x/mod/sumdb"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

type hashStore []tlog.Hash

func (s hashStore) ReadHashes(indexes []int64) ([]tlog.Hash, error) {
	out := make([]tlog.Hash, len(indexes))
	for i, index := range indexes {
		if index < 0 || index >= int64(len(s)) {
			return nil, fmt.Errorf("synthetic hash index outside tree")
		}
		out[i] = s[index]
	}
	return out, nil
}

type memoryOps struct {
	mu                    sync.Mutex
	remote, config, cache map[string][]byte
}

func (o *memoryOps) ReadRemote(path string) ([]byte, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	data, ok := o.remote[path]
	if !ok {
		return nil, fmt.Errorf("no synthetic response for %q", path)
	}
	return bytes.Clone(data), nil
}
func (o *memoryOps) ReadConfig(name string) ([]byte, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return bytes.Clone(o.config[name]), nil
}
func (o *memoryOps) WriteConfig(name string, old, next []byte) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !bytes.Equal(old, o.config[name]) {
		return sumdb.ErrWriteConflict
	}
	o.config[name] = bytes.Clone(next)
	return nil
}
func (o *memoryOps) ReadCache(name string) ([]byte, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	data, ok := o.cache[name]
	if !ok {
		return nil, fmt.Errorf("synthetic cache miss")
	}
	return bytes.Clone(data), nil
}
func (o *memoryOps) WriteCache(name string, data []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.cache[name] = bytes.Clone(data)
}
func (*memoryOps) Log(string)           {}
func (*memoryOps) SecurityError(string) {}

// The upstream GO-2026-6180 regression appends unrelated hash text to a valid
// signed tree, outside the authenticated record. All service effects here are maps.
func lookupFixture(t *testing.T, unrelated bool) (*sumdb.Client, *memoryOps, string) {
	t.Helper()
	secret, public, err := note.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{42}, 128)), "synthetic.test")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := note.NewSigner(secret)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("owned synthetic module; not a real module archive"))
	hash := "h1:" + base64.StdEncoding.EncodeToString(digest[:])
	line := "example.test/good v1.0.0 " + hash
	data := []byte(line + "\n")
	stored, err := tlog.StoredHashes(0, data, hashStore(nil))
	if err != nil {
		t.Fatal(err)
	}
	root, err := tlog.TreeHash(1, hashStore(stored))
	if err != nil {
		t.Fatal(err)
	}
	text := tlog.FormatTree(tlog.Tree{N: 1, Hash: root})
	if unrelated {
		text = append(text, []byte("example.test/bad v1.0.0 "+hash+"\n")...)
	}
	signed, err := note.Sign(&note.Note{Text: string(text)}, signer)
	if err != nil {
		t.Fatal(err)
	}
	record, err := tlog.FormatRecord(0, data)
	if err != nil {
		t.Fatal(err)
	}
	ops := &memoryOps{remote: map[string][]byte{}, config: map[string][]byte{"key": []byte(public)}, cache: map[string][]byte{}}
	ops.remote["/lookup/example.test/good@v1.0.0"] = append(record, signed...)
	ops.remote["/lookup/example.test/bad@v1.0.0"] = bytes.Clone(ops.remote["/lookup/example.test/good@v1.0.0"])
	for _, tile := range tlog.NewTiles(2, 0, 1) {
		body, err := tlog.ReadTileData(tile, hashStore(stored))
		if err != nil {
			t.Fatal(err)
		}
		ops.remote["/"+tile.Path()] = body
	}
	size := 0
	for _, b := range ops.remote {
		size += len(b)
	}
	if size > 64<<10 {
		t.Fatal("fixture exceeds 64 KiB")
	}
	client := sumdb.NewClient(ops)
	client.SetTileHeight(2)
	return client, ops, line
}

func TestXModLookupValid(t *testing.T) {
	client, _, want := lookupFixture(t, false)
	for range 2 {
		got, err := client.Lookup("example.test/good", "v1.0.0")
		if err != nil || len(got) != 1 || got[0] != want {
			t.Fatalf("valid authenticated lookup: %q, %v", got, err)
		}
	}
}

func TestXModLookupRejectsUnauthenticatedLines(t *testing.T) {
	client, ops, _ := lookupFixture(t, true)
	for i := range 3 {
		// Exercise remote, in-client cache, then reconstructed in-memory disk cache.
		if i == 2 {
			client = sumdb.NewClient(ops)
			client.SetTileHeight(2)
		}
		got, err := client.Lookup("example.test/bad", "v1.0.0")
		if err != nil {
			t.Fatalf("valid signed fixture setup failed: %v", err)
		}
		if len(got) != 0 {
			t.Fatalf("unauthenticated unrelated hash accepted as authority (pass %d)", i)
		}
	}
}

type tileReader struct {
	store        hashStore
	tamper       bool
	saved, reads int
}

func (*tileReader) Height() int { return 2 }
func (r *tileReader) ReadTiles(tiles []tlog.Tile) ([][]byte, error) {
	if len(tiles) > 16 {
		return nil, fmt.Errorf("too many synthetic tiles")
	}
	r.reads += len(tiles)
	out := make([][]byte, len(tiles))
	for i, tile := range tiles {
		data, err := tlog.ReadTileData(tile, r.store)
		if err != nil {
			return nil, err
		}
		if len(data) > 64<<10 {
			return nil, fmt.Errorf("tile exceeds fixture budget")
		}
		out[i] = bytes.Clone(data)
		if r.tamper && tile.L == 0 && tile.N == 0 {
			clear(out[i][:tlog.HashSize])
		}
	}
	return out, nil
}
func (r *tileReader) SaveTiles(tiles []tlog.Tile, _ [][]byte) { r.saved += len(tiles) }

func tileFixture(t *testing.T, tamper bool) (tlog.Tree, *tileReader) {
	t.Helper()
	var store hashStore
	// Fifteen leaves at height two reproduce the upstream subtree/unique-tile
	// count mismatch using public APIs; no unexported package internals are copied.
	for n := int64(0); n < 15; n++ {
		hashes, err := tlog.StoredHashes(n, []byte(fmt.Sprintf("synthetic leaf %d", n)), store)
		if err != nil {
			t.Fatal(err)
		}
		store = append(store, hashes...)
	}
	root, err := tlog.TreeHash(15, store)
	if err != nil {
		t.Fatal(err)
	}
	if len(store)*tlog.HashSize > 64<<10 {
		t.Fatal("tree exceeds fixture budget")
	}
	return tlog.Tree{N: 15, Hash: root}, &tileReader{store: store, tamper: tamper}
}

func TestXModTileValid(t *testing.T) {
	tree, source := tileFixture(t, false)
	indexes := make([]int64, len(source.store))
	for i := range indexes {
		indexes[i] = int64(i)
	}
	got, err := tlog.TileHashReader(tree, source).ReadHashes(indexes)
	if err != nil || len(got) != len(source.store) {
		t.Fatalf("valid tree: %v", err)
	}
	for i := range got {
		if got[i] != source.store[i] {
			t.Fatalf("wrong authenticated hash %d", i)
		}
	}
	if source.saved == 0 {
		t.Fatal("valid tiles were not cached")
	}
}

func TestXModTileRejectsTamperedAncestry(t *testing.T) {
	tree, source := tileFixture(t, true)
	got, err := tlog.TileHashReader(tree, source).ReadHashes([]int64{tlog.StoredHashIndex(0, 0)})
	if err == nil {
		t.Fatal("tampered leaf accepted without authenticating its parent")
	}
	if len(got) != 0 || source.saved != 0 {
		t.Fatal("invalid tiles published or cached")
	}
	if !strings.Contains(err.Error(), "inconsistent tile") || source.reads == 0 {
		t.Fatalf("unexpected failure instead of authentication rejection: %v", err)
	}
}

func TestXModConsumerParsing(t *testing.T) {
	f, err := modfile.Parse("synthetic.mod", []byte("module example.test/app\n\ngo 1.26.0\n\nrequire example.test/lib/v2 v2.3.4\n"), nil)
	if err != nil || f.Module.Mod.Path != "example.test/app" || len(f.Require) != 1 || f.Require[0].Mod.Version != "v2.3.4" {
		t.Fatalf("modfile control: %v", err)
	}
	formatted, err := f.Format()
	if err != nil || !bytes.Contains(formatted, []byte("require example.test/lib/v2 v2.3.4")) {
		t.Fatal("modfile formatting changed")
	}
	if _, err := modfile.Parse("bad.mod", []byte("module\n"), nil); err == nil {
		t.Fatal("malformed module accepted")
	}
	if err := module.Check("example.test/lib/v2", "v2.3.4"); err != nil {
		t.Fatal(err)
	}
	if err := module.Check("example.test/lib/v2", "v1.0.0"); err == nil {
		t.Fatal("major/path mismatch accepted")
	}
	escaped, err := module.EscapePath("example.test/Owned")
	if err != nil || escaped != "example.test/!owned" {
		t.Fatal("module escape changed")
	}
	plain, err := module.UnescapePath(escaped)
	if err != nil || plain != "example.test/Owned" {
		t.Fatal("module unescape changed")
	}
	if semver.Compare("v2.3.4-rc.1", "v2.3.4") >= 0 || semver.Canonical("v2.3.4+build") != "v2.3.4" {
		t.Fatal("semver control changed")
	}
}
