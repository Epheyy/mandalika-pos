const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(option('--root') || process.cwd());
const contexts = require('./jsyaml-context.cjs')(root);
const core = ['normal', 'merge', 'roundtrip', 'errors', 'schemas', 'load-all', 'merge-budget', 'empty-budget', 'omap', 'omap-source', 'limits-source', 'depth', 'default-merge'];
const cases = contexts.flatMap((_, i) => core.map(name => i + ':' + name)).concat(['legacy', 'flat', 'redocly', 'openapi']);
const limits = { securityMs: 5000, consumerMs: 60000, heapMiB: 192, stackKiB: 1024, outputBytes: 65536, fixtureBytes: 16384 };
function owned(dir) { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert(path.basename(dir).startsWith('mandalika-jsyaml-')); assert(!fs.lstatSync(dir).isSymbolicLink()); }
function bytes(dir) { return fs.readdirSync(dir, { withFileTypes: true }).reduce((s, x) => { assert(!x.isSymbolicLink()); const p = path.join(dir, x.name); return s + (x.isDirectory() ? bytes(p) : fs.statSync(p).size); }, 0); }
const chain = n => Array.from({ length: n }, (_, i) => `a${i}: &a${i} { ${i ? `<<: *a${i - 1}, ` : ''}k${i}: ${i} }`).join('\n') + '\n';
async function worker(id, dir) {
  owned(dir); process.chdir(dir); const index = id.includes(':') ? Number(id.split(':')[0]) : id === 'legacy' || id === 'flat' ? 0 : 1;
  const name = id.split(':').pop(), c = contexts[index], pr = createRequire(c.parent), yaml = pr('js-yaml');
  const load = (s, options) => { assert(Buffer.byteLength(s) <= limits.fixtureBytes); return yaml.load(s, options); };
  const unchanged = Object.getOwnPropertyDescriptors(Object.prototype); let detail = {};
  if (name === 'normal') {
    assert.deepEqual(load('name: "香水 🌸"\ntext: "a\\nb"\nvalues: [null, true, false, 3, -2.5]\n'), { name: '香水 🌸', text: 'a\nb', values: [null, true, false, 3, -2.5] });
  } else if (name === 'merge') {
    const got = load('a: &a {x: 1, same: first}\nb: &b {y: 2, same: second}\nout: {<<: [*a, *b], x: 9}\nalias: *a\n');
    assert.deepEqual(got.out, { x: 9, same: 'first', y: 2 }); assert.strictEqual(got.alias, got.a);
  } else if (name === 'roundtrip') {
    const input = { label: 'É 香水', active: true, count: 12, nested: [null, { price: 25.5 }] };
    assert.deepEqual(load(yaml.dump(input)), { label: 'É 香水', active: true, count: 12, nested: [null, { price: 25.5 }] });
  } else if (name === 'errors') {
    assert.throws(() => load('a: 1\na: 2\n'), /duplicated mapping key/); assert.throws(() => load('a: [\n'), e => e.name === 'YAMLException');
    assert.deepEqual(load('a: 1\na: 2\n', { json: true }), { a: 2 });
  } else if (name === 'schemas') {
    assert(load('date: 2020-01-02\n').date instanceof Date);
    assert.deepEqual(load('date: 2020-01-02\non: yes\n', { schema: yaml.JSON_SCHEMA }), { date: '2020-01-02', on: 'yes' });
    assert.deepEqual(load('!!binary SGk='), Uint8Array.from([72, 105]));
  } else if (name === 'load-all') {
    const docs = yaml.loadAll('a: 1\n---\nb: 2\n'); assert.deepEqual(docs, [{ a: 1 }, { b: 2 }]);
    assert.throws(() => load('a: 1\n---\nb: 2\n'), /single document/);
  } else if (['merge-budget', 'empty-budget', 'default-merge'].includes(name)) {
    const source = name === 'empty-budget' ? 'a: &a {}\nout: {<<: [*a, *a, *a, *a]}\n' : chain(name === 'default-merge' ? 145 : 4);
    const file = path.join(dir, 'budget.yaml'); fs.writeFileSync(file, source);
    let result = Symbol('not returned'); const sentinel = result;
    assert.throws(() => { result = load(source, name === 'default-merge' ? undefined : { maxTotalMergeKeys: 3 }); }, /merge keys exceeded maxTotalMergeKeys/);
    assert.strictEqual(result, sentinel); assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.deepEqual(load('ok: 1'), { ok: 1 });
    assert.deepEqual(load(chain(3), { maxTotalMergeKeys: 8 }).a2, { k0: 0, k1: 1, k2: 2 });
    detail = { inputBytes: Buffer.byteLength(source), partialResultPublished: false, originalBytesUnchanged: true, defaultLimit: name === 'default-merge' };
  } else if (name === 'omap') {
    const keys = ['__proto__', 'constructor', 'toString', ...Array.from({ length: 24 }, (_, i) => 'k' + i)];
    const source = '!!omap\n' + keys.map((k, i) => `- ${k}: ${i}`).join('\n');
    const value = load(source); assert.deepEqual(value.map(x => Object.keys(x)[0]), keys); assert.deepEqual(value.map(x => x[Object.keys(x)[0]]), keys.map((_, i) => i));
    assert.throws(() => load(source + '\n- __proto__: 99'), /cannot resolve/); assert.throws(() => load('!!omap\n- {a: 1, b: 2}'), /cannot resolve/);
  } else if (name === 'omap-source') {
    const source = fs.readFileSync(path.join(path.dirname(c.file), 'lib/type/omap.js'), 'utf8');
    assert(!source.includes('objectKeys.indexOf('), 'no repeated linear membership scan');
    assert(source.includes('_hasOwnProperty.call(objectKeys, pairKey)')); assert(source.includes('Object.defineProperty(objectKeys, pairKey'));
    detail = { sourceSupportedComplexity: true, noTimingOrMemoryClaim: true, noInventedSetRequirement: true };
  } else if (name === 'limits-source') {
    const source = fs.readFileSync(path.join(path.dirname(c.file), 'lib/loader.js'), 'utf8');
    assert(/this\.maxDepth[^\n]+: 100\b/.test(source)); assert(/this\.maxTotalMergeKeys[^\n]+: 10000\b/.test(source));
    const merge = source.slice(source.indexOf('function mergeMappings'), source.indexOf('function storeMappingPair'));
    assert.equal((merge.match(/chargeMergeWork\(state\)/g) || []).length, 2); assert(merge.indexOf('chargeMergeWork(state)') < merge.indexOf('Object.keys(source)'));
  } else if (name === 'depth') {
    assert.deepEqual(load('[ [1] ]'), [[1]]); assert.throws(() => load('['.repeat(105) + '1' + ']'.repeat(105)), /maxDepth/);
  } else if (name === 'legacy') {
    const file = path.join(dir, '.eslintrc.yaml'); fs.writeFileSync(file, 'root: true\nenv: {browser: true}\nparserOptions: {ecmaVersion: 2020}\nrules:\n  eqeqeq: [error, always]\n');
    const legacy = pr('./dist/eslintrc.cjs').Legacy;
    assert.deepEqual(legacy.loadConfigFile(file), { root: true, env: { browser: true }, parserOptions: { ecmaVersion: 2020 }, rules: { eqeqeq: ['error', 'always'] } });
    const config = new legacy.ConfigArrayFactory({ cwd: dir }).loadFile(file).extractConfig(path.join(dir, 'example.js'));
    assert.equal(config.env.browser, true); assert.equal(config.parserOptions.ecmaVersion, 2020); assert.deepEqual(config.rules.eqeqeq, ['error', 'always']);
    fs.writeFileSync(file, 'rules: ['); assert.throws(() => legacy.loadConfigFile(file), /Cannot read config file|unexpected/);
  } else if (name === 'flat') {
    const rr = createRequire(path.join(root, 'package.json')); const lint = new (rr('eslint').ESLint)({ cwd: root });
    const result = await lint.lintText('export function Example() { return <button>OK</button> }\n', { filePath: path.join(root, 'apps/pos/src/__audit_yaml__.tsx') });
    assert.equal(result[0].errorCount, 0, JSON.stringify(result[0].messages));
    detail = { flatConfigSmoke: true, notLegacyYamlReachability: true };
  } else if (name === 'redocly') {
    const red = pr('./lib/js-yaml/index.js');
    assert.deepEqual(red.parseYaml('date: 2020-01-02\nbase: &a {x: 1}\nout: {<<: *a, y: 2}\n'), { date: '2020-01-02', base: { x: 1 }, out: { x: 1, y: 2 } });
    assert.deepEqual(red.parseYaml(red.stringifyYaml({ label: '香水', amount: 10 })), { label: '香水', amount: 10 });
    assert.throws(() => red.parseYaml('a: 1\na: 2'), /duplicated mapping key/);
  } else if (name === 'openapi') {
    const red = pr('./lib/index.js'); const spec = 'openapi: 3.0.3\ninfo: {title: Synthetic 香水, version: 1.0.0}\npaths: {}\ncomponents:\n  schemas:\n    Item:\n      $ref: ./item.yaml\n';
    const file = path.join(dir, 'openapi.yaml'); fs.writeFileSync(file, spec); fs.writeFileSync(path.join(dir, 'item.yaml'), 'type: object\nproperties:\n  quantity: {type: integer, minimum: 0}\n  label: {type: string}\nrequired: [label]\n');
    const result = await red.bundle({ ref: file, config: await red.createConfig({}), dereference: true });
    assert.equal(result.problems.length, 0, JSON.stringify(result.problems)); assert.equal(result.bundle.parsed.info.title, 'Synthetic 香水');
    assert.deepEqual(result.bundle.parsed.components.schemas.Item, { type: 'object', properties: { quantity: { type: 'integer', minimum: 0 }, label: { type: 'string' } }, required: ['label'] });
    assert([...result.fileDependencies].some(x => x.endsWith('item.yaml')));
    assert.throws(() => red.makeDocumentFromString('openapi: [', file), e => e.name === 'Error' && /unexpected/.test(e.message) || e instanceof red.YamlParseError);
    assert.equal(fs.readFileSync(file, 'utf8'), spec); detail = { onlyOwnedLocalReferences: true, diagnosticsTested: true };
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), unchanged); assert(bytes(dir) <= limits.fixtureBytes);
  console.log(JSON.stringify({ id, status: 'pass', detail }));
}
if (option('--worker')) {
  assert(cases.includes(option('--worker'))); worker(option('--worker'), path.resolve(option('--dir'))).catch(e => { console.error(e); process.exitCode = 1; });
} else {
  const rr = createRequire(path.join(root, 'package.json')), lock = rr('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const expected = option('--baseline') === 'before' ? '4.1.1' : '4.3.2'; assert(contexts.every(c => c.version === expected)); assert.equal(new Set(contexts.map(c => c.file)).size, 1);
  assert.deepEqual(Object.keys(lock.packages).filter(x => x.startsWith('js-yaml@')), ['js-yaml@' + expected]);
  const results = [];
  for (const id of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandalika-jsyaml-')); let result;
    try {
      const child = spawnSync(process.execPath, ['--max-old-space-size=192', '--stack-size=1024', __filename, '--root', root, '--worker', id, '--dir', dir], { timeout: id.includes(':') ? limits.securityMs : limits.consumerMs, maxBuffer: limits.outputBytes, encoding: 'utf8' });
      let alive = false; if (child.pid) { try { process.kill(child.pid, 0); alive = true; } catch (e) { assert.equal(e.code, 'ESRCH'); } } assert(!alive); assert(bytes(dir) <= limits.fixtureBytes);
      result = { id, exit: child.status, signal: child.signal, error: child.error?.code, stdout: child.stdout, stderr: child.stderr, fixtureBytes: bytes(dir), process: 'reaped' };
    } finally { owned(dir); fs.rmSync(dir, { recursive: true }); assert(!fs.existsSync(dir)); }
    result.cleanup = 'verified'; results.push(result);
  }
  const report = { yamlContexts: contexts, limits, results }; if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); if (results.some(x => x.exit !== 0)) process.exitCode = 1;
}
