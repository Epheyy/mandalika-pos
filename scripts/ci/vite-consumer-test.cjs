// Real synthetic Vite server. UNC inputs are used only in an extracted pure predicate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const option = n => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
const root = path.resolve(option('--root') || process.cwd());
const { contexts, postcss, native } = require('./vite-context.cjs')(root);
const viteDir = path.dirname(contexts[0].viteFile), vr = createRequire(contexts[0].viteFile);
const cases = ['server', 'file-guard-source', 'editor-pure-guard'];
const limits = { childMs: 45000, startupMs: 10000, requestMs: 3000, heapMiB: 256, outputBytes: 131072, responseBytes: 262144, fixtureBytes: 262144, guardMs: 1000 };
const fixtureRoot = fs.realpathSync.native(os.tmpdir());
const marker = 'SYNTHETIC_DENIED_VT_CONTENT_7f26';
function owned(dir) { assert.equal(path.dirname(dir), fixtureRoot); assert(path.basename(dir).startsWith('mandalika-vite-')); assert(!fs.lstatSync(dir).isSymbolicLink()); assert(!dir.startsWith('\\\\')); }
function bytes(dir) { return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, x) => { assert(!x.isSymbolicLink()); const p = path.join(dir, x.name); return sum + (x.isDirectory() ? bytes(p) : fs.statSync(p).size); }, 0); }
function bound(promise, ms, name) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ' timeout')), ms); })]).finally(() => clearTimeout(timer)); }
async function freePort() { const s = net.createServer(); await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); }); const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port; }
async function closed(port) { return new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); s.setTimeout(1000, () => { s.destroy(); resolve(false); }); }); }
function request(port, route) { return new Promise((resolve, reject) => { const req = http.get({ host: '127.0.0.1', port, path: route, timeout: limits.requestMs }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > limits.responseBytes) req.destroy(new Error('response cap')); }); res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject); }); req.on('timeout', () => req.destroy(new Error('request timeout'))); req.on('error', reject); }); }
function platformFile(file) {
  assert(path.dirname(file).startsWith(fixtureRoot) && !file.startsWith('\\\\'));
  const code = 'import ctypes,json,pathlib,sys\np=str(pathlib.Path(sys.argv[1]).resolve());k=ctypes.windll.kernel32;b=ctypes.create_unicode_buffer(32768);n=k.GetShortPathNameW(p,b,len(b));v=ctypes.create_unicode_buffer(64);ok=k.GetVolumeInformationW(pathlib.Path(p).anchor,None,0,None,None,None,v,len(v));print(json.dumps({"shortPath":b.value if n else None,"shortError":ctypes.GetLastError() if not n else None,"filesystem":v.value if ok else None}))';
  const result = spawnSync('python', ['-c', code, file], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
async function serverTest(dir) {
  const source = { 'main.ts': 'import "./style.css"; import icon from "./icon.svg"; export const value: number = 42; export { icon }; if (import.meta.hot) import.meta.hot.accept();', 'entry.tsx': 'export const element = <button>synthetic</button>;', 'style.css': '.synthetic { color: red; }', 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><title>synthetic</title></svg>', 'allowed.txt': 'VT_ALLOWED_CONTENT', '.env.audit': marker, 'denied-long-file-name.pem': marker, '.env': 'VITE_VT_SHOULD_NOT_LOAD=synthetic', 'vite.config.js': 'throw new Error("fixture config must not load")' };
  for (const [name, value] of Object.entries(source)) fs.writeFileSync(path.join(dir, name), value);
  const vite = await import(pathToFileURL(vr.resolve('vite')).href), port = await freePort(); let server, socket;
  const evidence = { platform: process.platform, port, routes: [], violations: [], windows: { status: process.platform === 'win32' ? 'pending' : 'platform-not-applicable', note: 'Linux is not Windows ADS/8.3 proof' } };
  try {
    server = await bound(vite.createServer({ root: dir, configFile: false, envFile: false, envDir: false, publicDir: false, appType: 'custom', oxc: { jsx: { runtime: 'classic' } }, cacheDir: path.join(dir, '.cache'), logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port, strictPort: true, open: false, fs: { strict: true, allow: [dir] } } }), limits.startupMs, 'createServer');
    await bound(server.listen(), limits.startupMs, 'listen');
    assert.equal(server.httpServer.address().address, '127.0.0.1'); assert.equal(server.httpServer.address().port, port);
    assert.equal(server.config.configFile, undefined); assert.equal(server.config.envDir, false); assert.equal(server.config.env.VITE_VT_SHOULD_NOT_LOAD, undefined);
    assert.equal(server.config.server.strictPort, true); assert.equal(server.config.server.open, false); assert.equal(server.config.server.fs.strict, true); assert.equal(server.config.server.proxy, undefined);
    const allow = server.config.server.fs.allow.map(x => path.resolve(x));
    const internalClient = path.join(viteDir, 'dist/client'); assert(allow.every(x => x === path.resolve(dir) || x === path.resolve(internalClient)), JSON.stringify(allow));
    assert(server.config.server.fs.deny.includes('.env') && server.config.server.fs.deny.includes('.env.*'));
    evidence.settings = { configFile: false, envDir: false, envFile: false, proxy: false, host: '127.0.0.1', strictPort: true, fsStrict: true, allow: ['owned fixture', 'Vite internal client appended by framework'], deny: server.config.server.fs.deny };
    for (const [route, expected] of [['/allowed.txt', 'VT_ALLOWED_CONTENT'], ['/main.ts', '42'], ['/entry.tsx', 'synthetic'], ['/style.css', 'color: red'], ['/icon.svg', '<svg']]) {
      const r = await request(port, route); assert.equal(r.status, 200, route + ': ' + r.body.slice(0, 1800)); assert(r.body.includes(expected), route); evidence.routes.push({ route, status: r.status, allowedControl: true });
    }
    assert(require.cache[native.file], 'actual Rolldown native binding loaded'); evidence.nativeBinding = native;
    const transformed = await server.transformRequest('/main.ts'); assert(transformed.map && transformed.map.sources.length); assert(transformed.code.includes('import.meta.hot'));
    socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`, 'vite-hmr');
    await bound(new Promise((resolve, reject) => { socket.addEventListener('message', ev => { if (JSON.parse(ev.data).type === 'connected') resolve(); }); socket.addEventListener('error', () => reject(new Error('HMR connect failed'))); }), 5000, 'HMR'); evidence.hmrConnected = true;
    const denied = async (route, vector) => {
      const response = await request(port, route); const leaked = response.body.includes(marker);
      evidence.routes.push({ route, vector, status: response.status, bytes: Buffer.byteLength(response.body), leaked }); if (leaked) evidence.violations.push({ route, vector });
    };
    const routes = async (name, vector) => { for (const suffix of ['', '?raw', '?import', '?raw&import']) await denied('/' + encodeURI(name) + suffix, vector); await denied('/@fs/' + encodeURI(path.join(dir, name).replaceAll('\\', '/')) + '?raw', vector + '-fs'); };
    for (const name of ['.env.audit', 'denied-long-file-name.pem']) await routes(name, 'ordinary-denied');
    if (process.platform === 'win32') {
      evidence.windows = { status: 'qualified', files: [] };
      for (const name of ['.env.audit', 'denied-long-file-name.pem']) {
        const file = path.join(dir, name), facts = platformFile(file); assert.equal(facts.filesystem, 'NTFS', 'ADS requires actual NTFS qualification');
        assert.equal(fs.readFileSync(file + '::$DATA', 'utf8'), marker); facts.adsDefaultStreamVerified = true;
        await routes(name + '::$DATA', 'ntfs-ads'); await denied('/' + encodeURIComponent(name + '::$DATA') + '?raw', 'encoded-ntfs-ads');
        const alias = facts.shortPath && path.basename(facts.shortPath);
        if (alias && alias !== name && alias.includes('~')) { assert.equal(fs.readFileSync(path.join(dir, alias), 'utf8'), marker); facts.shortAliasVerified = alias; await routes(alias, 'real-short-alias'); }
        else facts.shortAliasStatus = 'unavailable: no distinct generated short alias';
        evidence.windows.files.push({ name, ...facts });
      }
    }
    for (const [url, mod] of server.environments.client.moduleGraph.urlToModuleMap) {
      if (mod.transformResult?.code.includes(marker)) evidence.violations.push({ route: url, vector: 'transform-cache' });
    }
  } finally {
    if (socket) socket.close(); if (server) await bound(server.close(), 5000, 'server close');
    evidence.portClosed = await closed(port); assert(evidence.portClosed); assert(bytes(dir) <= limits.fixtureBytes);
    console.log(JSON.stringify({ name: 'server', evidence }));
  }
  assert.equal(evidence.violations.length, 0, JSON.stringify(evidence.violations));
}
async function worker(name, dir) {
  owned(dir); process.chdir(dir);
  if (name === 'server') return serverTest(dir);
  const file = path.join(viteDir, 'dist/node/chunks/node.js'), source = fs.readFileSync(file, 'utf8'), digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (name === 'file-guard-source') {
    const start = source.indexOf('function isFileLoadingAllowed'), body = source.slice(start, source.indexOf('\nfunction ', start + 1));
    assert(body.includes('isWindows && filePath.includes("~")')); assert(body.includes('filePath.slice(2) : filePath).includes(":")'));
    assert(body.indexOf('includes("~")') < body.indexOf('fsDenyGlob')); assert(body.indexOf('includes(":")') < body.indexOf('safeModulePaths'));
    console.log(JSON.stringify({ name, digest, sourceOnly: true }));
  } else {
    const start = source.indexOf('function launchEditor(file, specifiedEditor, onErrorCallback)'), untilIO = source.indexOf('if (!fs', start), prefix = source.slice(start, untilIO);
    const guard = prefix.split('\n').find(x => x.includes('UNC paths are not supported'));
    assert(guard, 'bundled editor UNC rejection precedes filesystem I/O');
    const expression = guard.match(/if \((.*)\) return onErrorCallback/)[1];
    assert(!/fs|childProcess|require|import|fetch/.test(expression));
    for (const fileName of ['\\\\synthetic.invalid\\owned\\dummy.js', '//synthetic.invalid/owned/dummy.js', '\\\\?\\UNC\\synthetic.invalid\\owned\\dummy.js']) {
      assert.equal(vm.runInNewContext(expression, { process: { platform: 'win32' }, path$7: path.win32, fileName }, { timeout: limits.guardMs }), true);
    }
    assert.equal(vm.runInNewContext(expression, { process: { platform: 'win32' }, path$7: path.win32, fileName: 'C:\\owned\\dummy.js' }, { timeout: limits.guardMs }), false);
    console.log(JSON.stringify({ name, digest, extractedPureGuard: expression, simulatedPlatformPredicateOnly: true, uncFilesystemCalls: 0, editorSpawns: 0, notEndToEndCredentialLeakTest: true }));
  }
}
if (option('--worker')) {
  assert(cases.includes(option('--worker'))); worker(option('--worker'), path.resolve(option('--dir'))).catch(e => { console.error(e); process.exitCode = 1; });
} else {
  const expected = option('--baseline') === 'before' ? '8.0.13' : '8.0.16'; assert(contexts.every(c => c.version === expected));
  const results = [];
  for (const name of cases) {
    const dir = fs.mkdtempSync(path.join(fixtureRoot, 'mandalika-vite-')); let result;
    try {
      const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--stack-size=1024', __filename, '--root', root, '--worker', name, '--dir', dir], { timeout: limits.childMs, maxBuffer: limits.outputBytes, encoding: 'utf8' });
      let alive = false; if (child.pid) { try { process.kill(child.pid, 0); alive = true; } catch (e) { assert.equal(e.code, 'ESRCH'); } } assert(!alive); assert(bytes(dir) <= limits.fixtureBytes);
      result = { name, exit: child.status, signal: child.signal, error: child.error?.code, stdout: child.stdout, stderr: child.stderr, fixtureBytes: bytes(dir), process: 'reaped' };
      const lines = (child.stdout || '').trim().split('\n'); for (const line of lines) { try { const r = JSON.parse(line); if (r.evidence?.port) assert(awaitClosedSync(r.evidence.port)); } catch (e) { if (!(e instanceof SyntaxError)) throw e; } }
    } finally { owned(dir); fs.rmSync(dir, { recursive: true }); assert(!fs.existsSync(dir)); }
    result.cleanup = 'verified'; results.push(result);
  }
  const report = { viteContexts: contexts, postcss, native, platform: process.platform, limits, results };
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); if (results.some(x => x.exit !== 0)) process.exitCode = 1;
}
function awaitClosedSync(port) { const result = spawnSync(process.execPath, ['-e', 'const s=require("net").connect({host:"127.0.0.1",port:Number(process.argv[1])});s.once("connect",()=>{s.destroy();process.exitCode=1});s.once("error",()=>{});s.setTimeout(1000,()=>{s.destroy();process.exitCode=1})', String(port)], { timeout: 2000 }); return result.status === 0; }
