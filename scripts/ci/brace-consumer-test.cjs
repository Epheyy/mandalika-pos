// Finite synthetic patterns only; every consumer case runs in a bounded child.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(option('--root') || process.cwd());
const rootRequire = createRequire(path.join(root, 'package.json'));
const versions = { '3.1.5': '1.1.18', '5.1.9': '2.1.4', '10.2.5': '5.0.9' };
const oldVersions = { '3.1.5': '1.1.14', '5.1.9': '2.1.0', '10.2.5': '5.0.6' };
const limits = { timeoutMs: 5000, heapMiB: 96, stackKiB: 512, outputBytes: 65536, fixtureBytes: 65536 };
const kinds = ['benign', 'matching', 'count-budget', 'length-budget', 'intermediate-budget', 'repeated-literal'];
const cases = Object.keys(versions).flatMap(v => kinds.map(k => `${v}/${k}`)).concat('glob', 'esm');
function consumer(version) {
  const file = fs.realpathSync(path.join(root, `node_modules/.pnpm/minimatch@${version}/node_modules/minimatch/package.json`));
  const parentRequire = createRequire(file);
  const parent = JSON.parse(fs.readFileSync(file));
  const braceFile = parentRequire.resolve('brace-expansion/package.json');
  const brace = JSON.parse(fs.readFileSync(braceFile));
  const api = parentRequire('brace-expansion');
  const minimatch = parentRequire('./' + parent.main);
  assert.equal(typeof api, version === '10.2.5' ? 'object' : 'function');
  const expand = version === '10.2.5' ? api.expand : api;
  assert.equal(typeof expand, 'function');
  return { file, parent, braceFile, brace, expand, minimatch };
}
const vectors = [
  ['src/{a,b}.ts', ['src/a.ts', 'src/b.ts']],
  ['x{a,{b,c}}y', ['xay', 'xby', 'xcy']],
  ['{1..3}', ['1', '2', '3']], ['{c..a}', ['c', 'b', 'a']],
  ['{-2..1}', ['-2', '-1', '0', '1']], ['{01..03}', ['01', '02', '03']],
  ['{a..e..2}', ['a', 'c', 'e']], ['{a,a,b}', ['a', 'a', 'b']],
  ['{,a,}', ['a']], ['x{,a}y', ['xy', 'xay']],
  ['literal{brace}', ['literal{brace}']], ['x\\{a,b\\}', ['x{a,b}']],
  ['{a\\,b,c}', ['a,b', 'c']], ['${a,b}', ['${a,b}']],
  ['a{},b}c', ['a}c', 'abc']], ['{},a}b', ['{},a}b']],
];
function bytesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    assert(!e.isSymbolicLink()); const p = path.join(dir, e.name);
    return sum + (e.isDirectory() ? bytesUnder(p) : fs.statSync(p).size);
  }, 0);
}
async function worker(name, dir) {
  assert(cases.includes(name));
  assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('mandalika-brace-'));
  assert(!fs.lstatSync(dir).isSymbolicLink());
  let detail = {};
  if (name === 'glob') {
    // Glob is reached through the actual Capacitor -> rimraf parent, never run rimraf.
    const cap = createRequire(fs.realpathSync(path.join(root, 'apps/pos/node_modules/@capacitor/cli/package.json')));
    const rimraf = createRequire(cap.resolve('rimraf/package.json'));
    const glob = rimraf('glob');
    for (const file of ['src/a.ts', 'src/b.ts', 'src/a.js', 'test/a.ts', 'src/sub/c.ts']) {
      const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'synthetic');
    }
    const before = bytesUnder(dir);
    const selected = glob.globSync('src/{a,b}.ts', { cwd: dir, nodir: true }).map(p => p.split(path.sep).join('/')).sort();
    assert.deepEqual(selected, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual((await glob.glob('{src,test}/**/*.ts', { cwd: dir, nodir: true })).map(p => p.split(path.sep).join('/')).sort(),
      ['src/a.ts', 'src/b.ts', 'src/sub/c.ts', 'test/a.ts']);
    assert.equal(bytesUnder(dir), before, 'selection cannot mutate fixtures');
    detail = { selected, bytesBefore: before, bytesAfter: bytesUnder(dir) };
  } else if (name === 'esm') {
    const c = consumer('10.2.5');
    const module = await import(pathToFileURL(path.resolve(path.dirname(c.file), c.parent.exports['.'].import.default)).href);
    const brace = await import(pathToFileURL(path.resolve(path.dirname(c.braceFile), c.brace.exports['.'].import.default)).href);
    assert.deepEqual(module.braceExpand('{a,b}'), ['a', 'b']);
    assert.deepEqual(brace.expand('{1..3}'), ['1', '2', '3']);
    assert(module.minimatch('src/b.ts', 'src/{a,b}.ts'));
  } else {
    const [version, kind] = name.split('/');
    const { expand, minimatch } = consumer(version);
    if (kind === 'benign') {
      for (const [pattern, expected] of vectors) {
        assert.deepEqual(expand(pattern), expected, `direct ${pattern}`);
        assert.deepEqual(minimatch.braceExpand(pattern), expected, `parent ${pattern}`);
      }
      detail = { vectors: vectors.length, duplicatesAndOrderPreserved: true };
    } else if (kind === 'matching') {
      const match = typeof minimatch === 'function' ? minimatch : minimatch.minimatch;
      assert.deepEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.js'].filter(p => match(p, 'src/{a,b}.ts')), ['src/a.ts', 'src/b.ts']);
      assert.deepEqual(minimatch.braceExpand('{a,b}', { nobrace: true }), ['{a,b}']);
      const m = new minimatch.Minimatch('{a,a,b}');
      assert(m.match('a') && m.match('b') && !m.match('c'));
      if (version === '10.2.5') assert.deepEqual(minimatch.braceExpand('{1..8}', { braceExpandMax: 2 }), ['1', '2']);
    } else if (kind === 'count-budget') {
      // Exercise the documented optional count budget without a large allocation.
      assert.deepEqual(expand('{1..16}', { max: 3 }), ['1', '2', '3']);
      assert.deepEqual(expand('{a,,b}', { max: 2 }), ['a', 'b']);
      detail = { truncated: true, notCompleteSelection: true };
    } else if (kind === 'length-budget') {
      const actual = expand('{aa,bb,cc,dd}', { max: 16, maxLength: 4 });
      assert.deepEqual(actual, ['aa', 'bb']);
      assert.equal(actual.reduce((n, s) => n + s.length, 0), 4);
      detail = { truncated: true, maxLength: 4 };
    } else if (kind === 'intermediate-budget') {
      // At most256 alternatives even on the old API: no large product or OOM probe.
      const actual = expand('{1..16}{a..p}', { max: 2, maxLength: 4 });
      assert(actual.length > 0 && actual.length <= 2);
      assert(actual.reduce((n, s) => n + s.length, 0) <= 4);
      assert(actual.every(s => /^\d+[a-p]$/.test(s)));
      detail = { actual, internalAllocationNotMeasured: true, maxUnboundedAlternatives: 256 };
    } else if (kind === 'repeated-literal') {
      // 84-byte published input class. Parent gives5s, then kills this child.
      const pattern = 'a' + Array(28).fill('{}').join(',');
      assert(pattern.length < 90);
      assert.deepEqual(expand(pattern), [pattern]);
      detail = { patternBytes: pattern.length };
    }
  }
  assert(bytesUnder(dir) <= limits.fixtureBytes);
  console.log(JSON.stringify({ name, status: 'pass', detail }));
}
if (option('--worker')) {
  worker(option('--worker'), path.resolve(option('--dir'))).catch(e => { console.error(e); process.exitCode = 1; });
} else {
  const expected = option('--baseline') === 'before' ? oldVersions : versions;
  const parents = Object.keys(versions).map(v => {
    const c = consumer(v);
    assert.equal(c.brace.version, expected[v]);
    assert(rootRequire('semver').satisfies(c.brace.version, c.parent.dependencies['brace-expansion']));
    return { parent: `minimatch@${v}`, range: c.parent.dependencies['brace-expansion'],
      selected: c.brace.version, path: c.braceFile, api: v === '10.2.5' ? 'named expand; CJS/ESM' : 'callable CJS' };
  });
  const lock = rootRequire('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(k => k.startsWith('brace-expansion@')).sort(),
    Object.values(expected).map(v => `brace-expansion@${v}`).sort());
  const results = [];
  for (const name of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandalika-brace-'));
    let result;
    try {
      const child = spawnSync(process.execPath, [`--max-old-space-size=${limits.heapMiB}`, `--stack-size=${limits.stackKiB}`,
        __filename, '--root', root, '--worker', name, '--dir', dir], { timeout: limits.timeoutMs, maxBuffer: limits.outputBytes, encoding: 'utf8' });
      result = { name, exit: child.status, signal: child.signal, error: child.error?.code,
        stdout: child.stdout, stderr: child.stderr, fixtureBytes: bytesUnder(dir) };
      assert(result.fixtureBytes <= limits.fixtureBytes);
    } finally {
      assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('mandalika-brace-'));
      assert(!fs.lstatSync(dir).isSymbolicLink());
      fs.rmSync(dir, { recursive: true }); assert(!fs.existsSync(dir));
    }
    result.cleanup = 'verified'; results.push(result);
  }
  const report = { parents, limits, results };
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (results.some(r => r.exit !== 0)) process.exitCode = 1;
}
