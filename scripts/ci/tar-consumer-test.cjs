// Tiny local fixtures only. Every archive operation runs in a bounded child.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const root = path.resolve(option('--root') || process.cwd());
const parentManifest = fs.realpathSync(path.join(root, 'apps/pos/node_modules/@capacitor/cli/package.json'));
const parentRequire = createRequire(parentManifest);
const tarManifest = parentRequire.resolve('tar/package.json');
const manifest = JSON.parse(fs.readFileSync(tarManifest, 'utf8'));
const tar = parentRequire('tar');
const limits = { timeoutMs: 5000, heapMiB: 96, stackKiB: 512, outputBytes: 65536, fixtureBytes: 262144 };

function header(name, size, type = '0') {
  const b = Buffer.alloc(512);
  const oct = (value, offset, length) => b.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  b.write(name, 0, 100, 'utf8');
  oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8); oct(size, 124, 12); oct(0, 136, 12);
  b[156] = type.charCodeAt(0);
  b.write('ustar\0' + '00', 257, 8, 'ascii');
  return checksum(b);
}
function checksum(b) {
  b.fill(32, 148, 156);
  b.write([...b].reduce((a, v) => a + v, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return b;
}
function entry(name, data, type = '0') {
  return Buffer.concat([header(name, data.length, type), data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function archive(entries) {
  const b = Buffer.concat([...entries, Buffer.alloc(1024)]);
  assert(b.length <= 65536, 'fixture input bound');
  return b;
}
function bytesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    assert(!e.isSymbolicLink(), 'no fixture symlinks');
    const p = path.join(dir, e.name);
    return sum + (e.isDirectory() ? bytesUnder(p) : fs.statSync(p).size);
  }, 0);
}
async function worker(name, dir) {
  dir = path.resolve(dir);
  assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('mandalika-tar-'));
  assert(!fs.lstatSync(dir).isSymbolicLink(), 'owned fixture directory only');
  const file = path.join(dir, 'fixture.tar');
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const text = Buffer.from('Mandalika — wangi 🌺\n');
  const binary = Buffer.from([0, 1, 127, 128, 254, 255]);
  if (name === 'parent-extract') {
    fs.writeFileSync(file, gzipSync(archive([entry('App/readme.txt', text), entry('App/data.bin', binary)])));
    const helper = parentRequire('./dist/util/template.js');
    // This is the real installed helper used by add/update/migrate, not a mock.
    await helper.extractTemplate(file, out);
    assert.deepEqual(fs.readFileSync(path.join(out, 'App/readme.txt')), text);
    assert.deepEqual(fs.readFileSync(path.join(out, 'App/data.bin')), binary);
    assert.deepEqual(fs.readdirSync(path.join(out, 'App')).sort(), ['data.bin', 'readme.txt']);
    return { helper: 'extractTemplate', options: ['file', 'cwd'], contentAndPaths: 'preserved' };
  }
  if (name === 'round-trip') {
    fs.mkdirSync(path.join(dir, 'App'));
    fs.writeFileSync(path.join(dir, 'App/readme.txt'), text);
    await tar.create({ file, cwd: dir, gzip: true }, ['App']);
    const listed = [];
    await tar.list({ file, onReadEntry: e => listed.push(e.path) }, ['App']);
    assert(listed.includes('App/readme.txt'));
    await tar.extract({ file, cwd: out });
    assert.deepEqual(fs.readFileSync(path.join(out, 'App/readme.txt')), text);
    return { listed, content: 'preserved' };
  }
  if (name === 'negative-replace' || name === 'negative-list') {
    const b = header('negative', 0);
    b.fill(255, 124, 134); b[134] = 254; b[135] = 0; // base-256 -512
    fs.writeFileSync(file, checksum(b));
    fs.writeFileSync(path.join(dir, 'add.txt'), 'x');
    const warnings = [];
    try {
      if (name === 'negative-replace') tar.replace({ file, cwd: dir, sync: true }, ['add.txt']);
      else tar.list({ file, sync: true, onwarn: code => warnings.push(code) });
      return { terminated: true, handling: 'completed', warnings };
    } catch (error) {
      assert(!(error instanceof RangeError), 'not an uncontrolled stack overflow');
      return { terminated: true, handling: 'rejected', code: error.code || error.name };
    }
  }
  if (name === 'long-path-selection') {
    const longPath = Buffer.from('a/'.repeat(4000) + 'leaf\0');
    fs.writeFileSync(file, archive([entry('././@LongLink', longPath, 'L'), entry('placeholder', Buffer.alloc(0))]));
    const listed = [];
    tar.list({ file, sync: true, onReadEntry: e => listed.push(e.path) }, ['not-present']);
    assert.equal(listed.length, 0);
    return { pathSegments: 4001, selected: 0, terminated: true };
  }
  if (name === 'small-ratio-limit') {
    // Finite 32KiB payload, not a streaming bomb or host disk-exhaustion probe.
    const input = archive([entry('small.txt', Buffer.alloc(32768))]);
    const compressed = gzipSync(input);
    fs.writeFileSync(file, compressed);
    let rejection;
    try { await tar.extract({ file, cwd: out, maxDecompressionRatio: 2 }); }
    catch (error) { rejection = error; }
    assert(rejection && /max decompression ratio exceeded/.test(rejection.message), 'configured ratio must abort');
    return { inputBytes: input.length, gzipBytes: compressed.length, maxDecompressionRatio: 2, rejected: true };
  }
  throw new Error('Unknown fixture');
}
async function main() {
  if (option('--worker')) {
    const result = await worker(option('--worker'), option('--temp'));
    console.log(JSON.stringify(result));
    return;
  }
  const workspaceRequire = createRequire(path.join(root, 'package.json'));
  const lock = workspaceRequire('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  const parent = JSON.parse(fs.readFileSync(parentManifest, 'utf8'));
  const report = {
    parent: { name: parent.name, version: parent.version, range: parent.dependencies.tar, manifest: parentManifest },
    tar: { name: manifest.name, version: manifest.version, manifest: tarManifest, entry: parentRequire.resolve('tar'),
      entrySha256: createHash('sha256').update(fs.readFileSync(parentRequire.resolve('tar'))).digest('hex') },
    lockedTar: Object.keys(lock.packages).filter(k => k.startsWith('tar@')),
    limits, cases: [], cleanup: [],
  };
  let passed = manifest.name === 'tar' && manifest.version === '7.5.21'
    && report.lockedTar.length === 1 && report.lockedTar[0] === 'tar@7.5.21'
    && workspaceRequire('semver').satisfies(manifest.version, parent.dependencies.tar);
  for (const name of ['parent-extract', 'round-trip', 'negative-replace', 'negative-list', 'long-path-selection', 'small-ratio-limit']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandalika-tar-'));
    assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('mandalika-tar-'));
    try {
      const args = ['--max-old-space-size=96', '--stack-size=512', __filename, '--worker', name, '--root', root, '--temp', dir];
      const result = spawnSync(process.execPath, args, {
        cwd: dir, timeout: limits.timeoutMs, maxBuffer: limits.outputBytes, encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' }, windowsHide: true,
      });
      const size = bytesUnder(dir);
      const ok = result.status === 0 && !result.error && size <= limits.fixtureBytes;
      passed &&= ok;
      report.cases.push({ name, command: [process.execPath, ...args], cwd: dir, exit: result.status,
        signal: result.signal, error: result.error?.code, status: ok ? 'pass' : 'fail', fixtureBytes: size,
        stdout: result.stdout, stderr: result.stderr });
    } finally {
      // Only the just-created, verified owned directory is removed.
      fs.rmSync(dir, { recursive: true, force: true });
      assert(!fs.existsSync(dir));
      report.cleanup.push({ fixture: name, removed: true });
    }
  }
  report.status = passed ? 'pass' : 'fail';
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  process.exitCode = passed ? 0 : 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
