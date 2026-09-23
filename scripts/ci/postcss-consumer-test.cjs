// Only tiny owned synthetic maps; the observer delegates every read to the real fs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(option('--root') || process.cwd());
const { parentFile, contexts } = require('./postcss-context.cjs')(root);
const pr = createRequire(parentFile);
const cases = ['same-directory', 'nested-directory', 'traversal', 'no-from-absolute', 'no-from-relative',
  'non-map', 'missing', 'invalid', 'map-false', 'inline', 'explicit-object', 'explicit-path', 'prev-false', 'css', 'vite'];
const limits = { timeoutMs: 5000, viteTimeoutMs: 10000, heapMiB: 96, stackKiB: 512, outputBytes: 65536, fixtureBytes: 32768 };
function owned(dir) {
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  assert(path.basename(dir).startsWith('mandalika-postcss-'));
  assert(!fs.lstatSync(dir).isSymbolicLink());
}
function bytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    assert(!entry.isSymbolicLink()); const file = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? bytes(file) : fs.statSync(file).size);
  }, 0);
}
async function worker(name, dir) {
  assert(cases.includes(name)); owned(dir);
  const base = path.join(dir, 'base'), outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(base, 'nested'), { recursive: true }); fs.mkdirSync(outside);
  const map = marker => ({ version: 3, file: 'input.css', sources: ['original.css'], names: [],
    mappings: 'AAAA', sourcesContent: [marker] });
  const localMap = map('SYNTHETIC_LOCAL'), outsideMap = map('SYNTHETIC_OUTSIDE');
  const local = path.join(base, 'input.css.map'), nested = path.join(base, 'nested', 'input.css.map');
  const sibling = path.join(outside, 'outside.map');
  fs.writeFileSync(local, JSON.stringify(localMap)); fs.writeFileSync(nested, JSON.stringify(localMap));
  fs.writeFileSync(sibling, JSON.stringify(outsideMap));
  fs.writeFileSync(path.join(base, 'wrong.txt'), JSON.stringify(outsideMap));
  fs.writeFileSync(path.join(base, 'invalid.map'), 'not JSON');
  const css = 'a { color: red }'; const from = path.join(base, 'input.css');
  fs.writeFileSync(from, css); process.chdir(base);
  const reads = []; const originalRead = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (typeof file === 'string') {
      const resolved = path.resolve(file);
      if (resolved.startsWith(dir + path.sep) && /\.(map|txt)$/.test(resolved)) reads.push(path.relative(dir, resolved));
    }
    return Reflect.apply(originalRead, this, [file, ...args]);
  };
  let detail = {};
  try {
    const postcss = pr('./lib/postcss.js');
    if (name === 'css') {
      const text = '/* café 香 */\n@media screen { a { --tone: red; color: var(--tone); } }';
      const tree = postcss.parse(text, { from }); assert.equal(tree.toString(), text);
      assert.equal(tree.nodes[1].source.start.line, 2);
      assert.equal((await postcss([]).process(text, { from })).css, text);
      const result = await postcss([{ postcssPlugin: 'owned-tone', Declaration(d) {
        if (d.prop === '--tone') d.value = 'blue';
      } }]).process(text, { from });
      assert.equal(result.css, text.replace('--tone: red', '--tone: blue'));
      assert.throws(() => postcss.parse('a {\n color red;\n}', { from }), err =>
        err.name === 'CssSyntaxError' && err.line === 2 && err.column === 2 && err.input.file === from);
    } else if (name === 'vite') {
      fs.writeFileSync(path.join(base, 'index.html'), '<link rel="stylesheet" href="/input.css"><p>Synthetic</p>');
      fs.writeFileSync(from, '/* café 香 */ a { color: red; --tone: green; }');
      const ar = createRequire(path.join(root, 'apps/pos/package.json'));
      const vite = await import(pathToFileURL(ar.resolve('vite')).href);
      let calls = 0; const sources = [];
      const result = await vite.build({ configFile: false, root: base, logLevel: 'silent',
        css: { postcss: { plugins: [{ postcssPlugin: 'owned-vite-color', Declaration(d) {
          sources.push(d.source.input.from); if (d.prop === 'color') { calls++; d.value = 'blue'; }
        } }] } }, build: { write: false, minify: false, cssMinify: false, sourcemap: true, emptyOutDir: false } });
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(x => x.output);
      const cssOutput = outputs.find(x => x.type === 'asset' && x.fileName.endsWith('.css'));
      assert(cssOutput); const text = String(cssOutput.source);
      assert.match(text, /color: blue/); assert.match(text, /--tone: green/); assert.match(text, /café 香/);
      assert(calls >= 1 && calls <= 4); assert(sources.every(s => path.resolve(s) === from), JSON.stringify(sources));
      detail = { pluginCalls: calls, from: path.relative(dir, sources[0]), css: text, write: false };
    } else {
      let annotation = 'input.css.map', opts = { from }, shouldRead = true, marker = 'SYNTHETIC_LOCAL';
      if (name === 'nested-directory') annotation = 'nested/input.css.map';
      else if (name === 'traversal') { annotation = '../outside/outside.map'; shouldRead = false; }
      else if (name === 'no-from-absolute') { annotation = sibling; opts = {}; shouldRead = false; }
      else if (name === 'no-from-relative') { annotation = '../outside/outside.map'; opts = {}; shouldRead = false; }
      else if (name === 'non-map') { annotation = 'wrong.txt'; shouldRead = false; }
      else if (name === 'missing') { annotation = 'missing.map'; shouldRead = false; }
      else if (name === 'invalid') { annotation = 'invalid.map'; marker = undefined; }
      else if (name === 'map-false') { annotation = '../outside/outside.map'; opts.map = false; shouldRead = false; }
      else if (name === 'prev-false') { opts.map = { prev: false }; shouldRead = false; }
      else if (name === 'inline') { annotation = 'data:application/json;base64,' + Buffer.from(JSON.stringify(localMap)).toString('base64'); shouldRead = false; }
      else if (name === 'explicit-object') { opts.map = { prev: outsideMap }; marker = 'SYNTHETIC_OUTSIDE'; shouldRead = false; }
      else if (name === 'explicit-path') { opts.map = { prev: () => sibling }; marker = 'SYNTHETIC_OUTSIDE'; }
      const input = new postcss.Input(css + '\n/*# sourceMappingURL=' + annotation + ' */', opts);
      const previous = input.map;
      const forbidden = ['traversal', 'no-from-absolute', 'no-from-relative', 'non-map', 'missing', 'map-false', 'prev-false'].includes(name);
      const result = await postcss([]).process(css + '\n/*# sourceMappingURL=' + annotation + ' */', opts);
      const inlineOutput = result.css.match(/sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)/);
      const emitted = result.map?.toString() || (inlineOutput ? Buffer.from(inlineOutput[1], 'base64').toString() : result.css);
      detail = { previousLoaded: Boolean(previous), emittedContainsOutside: emitted.includes('SYNTHETIC_OUTSIDE'),
        emittedContainsLocal: emitted.includes('SYNTHETIC_LOCAL') };
      if (forbidden) {
        assert.equal(reads.length, 0, 'automatic rejected map must not be read');
        assert.equal(previous, undefined); assert(!emitted.includes('SYNTHETIC_OUTSIDE'));
      } else if (name === 'invalid') {
        assert(reads.some(p => p.endsWith('invalid.map'))); assert.equal(previous, undefined);
      } else {
        assert(previous); const consumer = previous.consumer();
        assert.equal(consumer.sourceContentFor('original.css'), marker);
        assert.deepEqual(consumer.originalPositionFor({ line: 1, column: 0 }), { source: 'original.css', line: 1, column: 0, name: null });
        assert(emitted.includes(marker));
        assert.equal(reads.length > 0, shouldRead);
      }
    }
    assert(bytes(dir) <= limits.fixtureBytes);
  } finally {
    fs.readFileSync = originalRead;
    console.log(JSON.stringify({ name, reads, detail, fixtureBytes: bytes(dir) }));
  }
}
if (option('--worker')) {
  worker(option('--worker'), path.resolve(option('--dir'))).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const expected = option('--baseline') === 'before' ? '8.5.14' : '8.5.23';
  assert(contexts.every(c => c.postcssVersion === expected && c.nanoVersion === '3.3.18'));
  const rr = createRequire(path.join(root, 'package.json'));
  const lock = rr('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(k => k.startsWith('postcss@')), [`postcss@${expected}`]);
  const results = [];
  for (const name of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandalika-postcss-'));
    let result;
    try {
      const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--stack-size=512', __filename,
        '--root', root, '--worker', name, '--dir', dir], { timeout: name === 'vite' ? limits.viteTimeoutMs : limits.timeoutMs,
        maxBuffer: limits.outputBytes, encoding: 'utf8' });
      let live = false;
      if (child.pid) { try { process.kill(child.pid, 0); live = true; } catch (error) { assert.equal(error.code, 'ESRCH'); } }
      assert.equal(live, false); assert(bytes(dir) <= limits.fixtureBytes);
      result = { name, exit: child.status, signal: child.signal, error: child.error?.code,
        stdout: child.stdout, stderr: child.stderr, fixtureBytes: bytes(dir), process: 'reaped' };
    } finally {
      owned(dir); fs.rmSync(dir, { recursive: true }); assert(!fs.existsSync(dir));
    }
    result.cleanup = 'verified'; results.push(result);
  }
  const report = { contexts, limits, results };
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); if (results.some(r => r.exit !== 0)) process.exitCode = 1;
}
