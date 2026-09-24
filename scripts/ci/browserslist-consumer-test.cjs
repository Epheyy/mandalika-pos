// Finite public-API fixtures only. No upstream mutation or large memory probe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const option = n => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(option('--root') || process.cwd());
const context = require('./browserslist-context.cjs')(root);
const cases = ['helper', 'explicit', 'config-env', 'stats-normal', 'reserved-proto', 'reserved-constructor',
  'reserved-toString', 'file-normal', 'file-reserved', 'result-cache', 'parse-cache', 'cache-controls', 'cache-source', 'targets', 'eslint'];
const limits = { timeoutMs: 5000, consumerTimeoutMs: 60000, heapMiB: 128, stackKiB: 512, outputBytes: 65536, fixtureBytes: 16384, distinctQueries: 503 };
function owned(dir) {
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert(path.basename(dir).startsWith('mandalika-browserslist-'));
  assert(!fs.lstatSync(dir).isSymbolicLink());
}
function bytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, x) => {
    assert(!x.isSymbolicLink()); const p = path.join(dir, x.name);
    return sum + (x.isDirectory() ? bytes(p) : fs.statSync(p).size);
  }, 0);
}
async function worker(name, dir) {
  owned(dir); assert(cases.includes(name));
  for (const key of Object.keys(process.env)) if (key.startsWith('BROWSERSLIST_') || key === 'BROWSERSLIST' || key === 'NODE_ENV') delete process.env[key];
  process.env.BROWSERSLIST_ROOT_PATH = dir; process.chdir(dir);
  const hr = createRequire(context.helperFile), br = createRequire(context.file);
  const bl = hr('browserslist'), targets = hr('./lib/index.js').default;
  const opts = { path: dir }, config = path.join(dir, '.browserslistrc');
  const normal = { chrome: { 100: 80 }, firefox: { 100: 20 } };
  let detail = {};
  if (name === 'helper') {
    assert.deepEqual(targets({ browsers: ['chrome 100', 'firefox 100'] }, { ignoreBrowserslistConfig: true }), { chrome: '100.0.0', firefox: '100.0.0' });
    assert.deepEqual(targets({ chrome: '100', node: '18' }, { ignoreBrowserslistConfig: true }), { chrome: '100.0.0', node: '18.0.0' });
    const babel = createRequire(context.babelFile)('./lib/index.js');
    const result = babel.transformSync('const answer = 42;', { configFile: false, babelrc: false, targets: { chrome: '100' } });
    assert.equal(result.code, 'const answer = 42;');
  } else if (name === 'explicit') {
    assert.deepEqual(bl(['chrome 100', 'chrome 101', 'firefox 100', 'chrome 100', 'not chrome 101'], opts), ['chrome 100', 'firefox 100']);
    assert.deepEqual(bl('chrome 100, chrome 101, firefox 100', opts), ['chrome 101', 'chrome 100', 'firefox 100']);
    assert.throws(() => bl('synthetic_unknown_browser 9', opts), error => error.name === 'BrowserslistError');
  } else if (name === 'config-env') {
    fs.writeFileSync(config, '[production]\nchrome 100\n[development]\nfirefox 100\n');
    assert.deepEqual(bl(undefined, { ...opts, env: 'production' }), ['chrome 100']);
    assert.deepEqual(bl(undefined, { ...opts, env: 'development' }), ['firefox 100']);
    assert.deepEqual(targets({}, { configFile: config, configPath: dir, browserslistEnv: 'production' }), { chrome: '100.0.0' });
    process.env.BROWSERSLIST_ENV = 'development'; assert.deepEqual(bl(undefined, opts), ['firefox 100']);
    delete process.env.BROWSERSLIST_ENV; process.env.NODE_ENV = 'production'; assert.deepEqual(bl(undefined, opts), ['chrome 100']);
  } else if (name === 'stats-normal' || name === 'file-normal') {
    let stats = normal;
    if (name === 'file-normal') { stats = path.join(dir, 'browserslist-stats.json'); fs.writeFileSync(stats, JSON.stringify(normal)); }
    assert.deepEqual(bl('> 30% in my stats', { ...opts, stats }), ['chrome 100']);
    assert.deepEqual(bl('> 10% in my stats', { ...opts, stats }), ['chrome 100', 'firefox 100']);
  } else if (name.startsWith('reserved-') || name === 'file-reserved') {
    const key = name === 'reserved-constructor' ? 'constructor' : name === 'reserved-toString' ? 'toString' : '__proto__';
    const stats = JSON.parse('{"' + key + '":{"onekey":5},"chrome":{"100":80}}');
    const before = JSON.stringify(stats), descriptors = Object.getOwnPropertyDescriptors(Object.prototype), sentinel = {};
    try {
      if (name === 'file-reserved') {
        fs.writeFileSync(path.join(dir, 'browserslist-stats.json'), JSON.stringify(stats));
        assert.deepEqual(bl('chrome 100', opts), ['chrome 100']);
      } else assert.deepEqual(bl('chrome 100', { ...opts, stats }), ['chrome 100']);
    } finally {
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), descriptors);
      assert.equal(Object.getPrototypeOf(sentinel), Object.prototype); assert.equal(sentinel.onekey, undefined);
      assert.equal(JSON.stringify(stats), before); detail = { key, prototypeSentinelUnchanged: true, inputUnchanged: true };
      console.log(JSON.stringify({ name, detail }));
    }
  } else if (name === 'result-cache' || name === 'parse-cache') {
    const query = 'chrome 100';
    const call = name === 'result-cache' ? q => bl(q, { ...opts, stats: normal }) : q => bl.parse(q, opts);
    const first = call(query); assert.strictEqual(call(query), first, 'resident cache entry reused');
    for (let i = 1; i <= 501; i++) {
      const value = call('> ' + (i / 1000).toFixed(3) + '% in my stats');
      assert(value.length <= 2);
    }
    const again = call(query); assert.deepEqual(again, first); assert.notStrictEqual(again, first, 'entry evicted and recomputed after 500 bound');
    assert.strictEqual(call(query), again); detail = { distinctQueries: 502, residentReuse: true, evictionObserved: true, internalSizeNotInstrumented: true };
  } else if (name === 'cache-controls') {
    process.env.BROWSERSLIST_DISABLE_CACHE = '1';
    assert.notStrictEqual(bl('chrome 100', opts), bl('chrome 100', opts));
    assert.notStrictEqual(bl.parse('chrome 100', opts), bl.parse('chrome 100', opts));
    delete process.env.BROWSERSLIST_DISABLE_CACHE;
    fs.writeFileSync(config, 'chrome 100\n'); assert.deepEqual(bl(undefined, opts), ['chrome 100']);
    fs.writeFileSync(config, 'firefox 100\n'); bl.clearCaches(); assert.deepEqual(bl(undefined, opts), ['firefox 100']);
    detail = { childOnlyDisableControl: true, productionCacheUnchanged: true, configClearControl: true };
  } else if (name === 'cache-source') {
    const source = fs.readFileSync(path.join(path.dirname(context.file), 'index.js'), 'utf8');
    assert(/var CACHE_MAX_ENTRIES = 500/.test(source), 'publisher 500 entry cache bound');
    assert.match(source, /map\.size >= CACHE_MAX_ENTRIES/);
    assert.match(source, /map\.delete\(map\.keys\(\)\.next\(\)\.value\)/);
    assert.match(source, /boundedCacheSet\(cache, cacheKey, result\)/);
    assert.match(source, /boundedCacheSet\(parseCache, cacheKey, result\)/);
    detail = { sourceSupportedBound: 500, resultAndParseUseSameBound: true, noInternalInstrumentation: true };
  } else if (name === 'targets') {
    process.env.BROWSERSLIST_ROOT_PATH = root;
    const projects = {};
    for (const project of ['.', 'apps/pos', 'apps/backoffice']) {
      const configPath = path.join(root, project);
      projects[project] = { config: bl.loadConfig({ path: configPath }) || null,
        babelTargets: targets({}, { configPath }), defaultTargets: bl(undefined, { path: configPath }) };
    }
    process.env.BROWSERSLIST_ROOT_PATH = dir;
    const queries = ['defaults', 'last 2 chrome versions', 'maintained node versions', '> 1%', 'baseline widely available on 2025-01-01'];
    detail = { projects, samples: Object.fromEntries(queries.map(q => [q, { browsers: bl(q, opts), babel: targets({ browsers: q }, { ignoreBrowserslistConfig: true }) }])) };
  } else if (name === 'eslint') {
    const rr = createRequire(path.join(root, 'package.json'));
    const eslint = new (rr('eslint').ESLint)({ cwd: root });
    const results = await eslint.lintText('export function Example() { return <button>OK</button> }\n', { filePath: path.join(root, 'apps/pos/src/__audit_synthetic__.tsx') });
    assert.equal(results.length, 1); assert.equal(results[0].errorCount, 0, JSON.stringify(results[0].messages));
    detail = { actualRepositoryConfig: true, errorCount: 0, warningCount: results[0].warningCount };
  }
  assert(bytes(dir) <= limits.fixtureBytes); console.log(JSON.stringify({ name, status: 'pass', detail }));
}
if (option('--worker')) {
  worker(option('--worker'), path.resolve(option('--dir'))).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  assert.equal(context.version, option('--baseline') === 'before' ? '4.28.2' : '4.28.7');
  const rr = createRequire(path.join(root, 'package.json'));
  const lock = rr('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(k => k.startsWith('browserslist@')), ['browserslist@' + context.version]);
  const results = [];
  for (const name of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandalika-browserslist-')); let result;
    try {
      const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--stack-size=512', __filename, '--root', root,
        '--worker', name, '--dir', dir], { timeout: ['eslint', 'helper'].includes(name) ? limits.consumerTimeoutMs : limits.timeoutMs, maxBuffer: limits.outputBytes, encoding: 'utf8' });
      let live = false; if (child.pid) { try { process.kill(child.pid, 0); live = true; } catch (error) { assert.equal(error.code, 'ESRCH'); } }
      assert(!live); assert(bytes(dir) <= limits.fixtureBytes);
      result = { name, exit: child.status, signal: child.signal, error: child.error?.code, stdout: child.stdout, stderr: child.stderr, fixtureBytes: bytes(dir), process: 'reaped' };
    } finally { owned(dir); fs.rmSync(dir, { recursive: true }); assert(!fs.existsSync(dir)); }
    result.cleanup = 'verified'; results.push(result);
  }
  const report = { context, limits, results };
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); if (results.some(x => x.exit !== 0)) process.exitCode = 1;
}
