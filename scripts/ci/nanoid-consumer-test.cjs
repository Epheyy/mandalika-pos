// Tiny synthetic inputs; risky API boundaries run only in supervised children.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(option('--root') || process.cwd());
const rr = createRequire(path.join(root, 'package.json'));
const { parentFile, contexts } = require('./postcss-context.cjs')(root);
const pr = createRequire(parentFile);
const parent = JSON.parse(fs.readFileSync(parentFile));
const file = pr.resolve('nanoid/package.json');
const manifest = JSON.parse(fs.readFileSync(file));
const base = path.dirname(file);
const limits = { timeoutMs: 5000, heapMiB: 96, stackKiB: 512, outputBytes: 65536, maxIdLength: 64 };
const cases = ['input', 'parse-errors', 'process-map', 'positive-cjs', 'positive-esm',
  'negative-direct', 'negative-custom-default', 'negative-custom-override',
  'zero-custom-default', 'zero-custom-override', 'zero-random-default', 'zero-random-override',
  'async-positive', 'async-zero-default', 'async-zero-override', 'browser'];
function shape(id, length, alphabet = /^[\w-]*$/) {
  assert.equal(typeof id, 'string'); assert.equal(id.length, length); assert.match(id, alphabet);
}
async function worker(name) {
  assert(cases.includes(name));
  const non = pr('nanoid/non-secure'), secure = pr('nanoid');
  const postcss = pr('./lib/postcss.js');
  if (name === 'input') {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const input = new postcss.Input('a { color: red }');
      assert.match(input.id, /^<input css [\w-]{6}>$/); assert.equal(input.from, input.id);
      assert.equal(input.toJSON().id, input.id); ids.push(input.id);
    }
    // Detect a cached constant, not an entropy/collision-quality test.
    assert(new Set(ids).size > 1);
    const input = new postcss.Input('a {}', { from: 'synthetic.css' });
    assert.equal(input.from, path.resolve('synthetic.css')); assert.equal(input.id, undefined);
  } else if (name === 'parse-errors') {
    const css = '/* café 香 */\na {\n  color: red;\n}';
    const tree = postcss.parse(css); assert.equal(tree.toString(), css);
    const decl = tree.nodes[1].nodes[0]; assert.equal(decl.source.start.line, 3);
    assert.equal(decl.source.start.column, 3); assert.equal(decl.source.input.css, css);
    assert.match(decl.source.input.from, /^<input css [\w-]{6}>$/);
    const error = decl.error('synthetic'); assert.equal(error.line, 3); assert.equal(error.column, 3);
    assert.equal(error.input.source, css);
    assert.throws(() => postcss.parse('a {\n color red;\n}', { from: 'bad.css' }), err =>
      err.name === 'CssSyntaxError' && err.line === 2 && err.column === 2 && err.input.file === path.resolve('bad.css'));
  } else if (name === 'process-map') {
    const css = '/* café 香 */\na { color: red; }';
    assert.equal((await postcss([]).process(css, { from: undefined })).css, css);
    const result = await postcss([{ postcssPlugin: 'synthetic-color', Declaration(decl) {
      if (decl.prop === 'color') decl.value = 'blue';
    } }]).process(css, { from: 'input.css', to: 'output.css', map: { inline: false, annotation: false } });
    assert.equal(result.css, '/* café 香 */\na { color: blue; }');
    const map = result.map.toJSON(); assert.deepEqual(map.sources, ['input.css']);
    assert.deepEqual(map.sourcesContent, [css]); assert.equal(map.file, 'output.css');
    const consumer = new (pr('source-map-js').SourceMapConsumer)(map);
    const origin = consumer.originalPositionFor({ line: 2, column: 4 });
    assert.equal(origin.source, 'input.css'); assert.equal(origin.line, 2); assert.equal(origin.column, 4);
    const anonymous = await postcss([]).process(css, { from: undefined, map: { inline: false, annotation: false } });
    assert.deepEqual(anonymous.map.toJSON().sourcesContent, [css]);
    assert.deepEqual(anonymous.map.toJSON().sources, ['<no source>']);
    assert.match(anonymous.root.source.input.id, /^<input css [\w-]{6}>$/);
  } else if (name.startsWith('positive-')) {
    const apis = name === 'positive-cjs' ? [secure, non] : [
      await import(pathToFileURL(path.join(base, 'index.js')).href),
      await import(pathToFileURL(path.join(base, 'non-secure/index.js')).href)];
    for (const api of apis) {
      shape(api.nanoid(), 21); shape(api.nanoid(6), 6); shape(api.nanoid(0), 0);
      const make = api.customAlphabet('abc', 8); shape(make(), 8, /^[abc]*$/); shape(make(4), 4, /^[abc]*$/);
      shape(api.customAlphabet('abc')(), 21, /^[abc]*$/);
    }
  } else if (name === 'negative-direct') assert.equal(non.nanoid(-1), '');
  else if (name === 'negative-custom-default') assert.equal(non.customAlphabet('abc', -1)(), '');
  else if (name === 'negative-custom-override') assert.equal(non.customAlphabet('abc', 8)(-1), '');
  else if (name.startsWith('zero-')) {
    const size = name.endsWith('default') ? 0 : 8;
    // Finite deterministic test bytes; never supplied to production randomness.
    const make = name.includes('random') ? secure.customRandom('abc', size, n => {
      assert(n >= 0 && n <= 64); return new Uint8Array(n);
    }) : secure.customAlphabet('abc', size);
    assert.equal(name.endsWith('default') ? make() : make(0), '');
  } else if (name.startsWith('async-')) {
    const api = pr('nanoid/async');
    if (name === 'async-positive') {
      shape(await api.nanoid(), 21); shape(await api.nanoid(6), 6); shape(await api.nanoid(0), 0);
      shape(await api.customAlphabet('abc', 8)(), 8, /^[abc]*$/);
      const esm = await import(pathToFileURL(path.join(base, 'async/index.js')).href);
      shape(await esm.customAlphabet('abc', 8)(4), 4, /^[abc]*$/);
    } else assert.equal(name.endsWith('default') ? await api.customAlphabet('abc', 0)() : await api.customAlphabet('abc', 8)(0), '');
  } else if (name === 'browser') {
    // Published browser implementations under Node Web Crypto, not device qualification.
    const api = await import(pathToFileURL(path.join(base, 'index.browser.js')).href);
    shape(api.nanoid(6), 6); assert.equal(api.customAlphabet('abc', 0)(), '');
    assert.equal(api.customAlphabet('abc', 8)(0), '');
    const asyncApi = await import(pathToFileURL(path.join(base, 'async/index.browser.js')).href);
    shape(await asyncApi.nanoid(6), 6); assert.equal(await asyncApi.customAlphabet('abc', 0)(), '');
  }
  console.log(JSON.stringify({ name, status: 'pass' }));
}
if (option('--worker')) {
  worker(option('--worker')).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  assert.equal(manifest.name, 'nanoid');
  assert.equal(manifest.version, option('--baseline') === 'before' ? '3.3.12' : '3.3.18');
  assert(rr('semver').satisfies(manifest.version, parent.dependencies.nanoid));
  assert.match(fs.readFileSync(path.join(path.dirname(parentFile), 'lib/input.js'), 'utf8'), /nanoid\(6\)/);
  const lock = rr('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(k => k.startsWith('nanoid@')), [`nanoid@${manifest.version}`]);
  const results = cases.map(name => {
    const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--stack-size=512', __filename,
      '--root', root, '--worker', name], { timeout: limits.timeoutMs, maxBuffer: limits.outputBytes, encoding: 'utf8' });
    let live = false;
    if (child.pid) { try { process.kill(child.pid, 0); live = true; } catch (error) { assert.equal(error.code, 'ESRCH'); } }
    assert.equal(live, false, 'supervised child must be reaped');
    return { name, exit: child.status, signal: child.signal, error: child.error?.code,
      stdout: child.stdout, stderr: child.stderr, cleanup: 'child-reaped; no disk fixtures' };
  });
  const report = { parent: parent.name, contexts, range: parent.dependencies.nanoid, selected: manifest.version,
    manifest: file, actualCaller: 'non-secure CJS constant6; not attacker-controlled size', limits, results };
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (results.some(r => r.exit !== 0)) process.exitCode = 1;
}
