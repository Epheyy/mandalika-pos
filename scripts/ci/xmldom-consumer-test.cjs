// Finite synthetic inputs in bounded children; no native toolchain or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const option = name => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = path.resolve(option('--root') || process.cwd());
const capPath = fs.realpathSync(path.join(root, 'apps/pos/node_modules/@capacitor/cli/package.json'));
const capRequire = createRequire(capPath);
const plistPath = capRequire.resolve('plist/package.json');
const plistRequire = createRequire(plistPath);
const xmlPath = plistRequire.resolve('@xmldom/xmldom/package.json');
const xmlManifest = JSON.parse(fs.readFileSync(xmlPath, 'utf8'));
const plist = capRequire('plist');
const { DOMParser, DOMImplementation, XMLSerializer } = plistRequire('@xmldom/xmldom');
const limits = { timeoutMs: 5000, heapMiB: 96, stackKiB: 512, outputBytes: 65536, fixtureBytes: 65536 };
const cases = ['plist-typed', 'capacitor-helper', 'creation-names', 'strict-names',
  'strict-pi', 'strict-doctype', 'strict-entity', 'end-tag-diagnostic',
  'namespace-attributes-normalize', 'html-raw-text'];
const typed = () => ({ title: 'Mandalika & <wangi> "🌺"', empty: '', array: [true, false, 0, -7, 1.25, 'é'],
  nested: { value: '香り' }, date: new Date('2026-01-02T03:04:05Z'), data: Buffer.from([0, 1, 127, 255]),
  emptyArray: [], emptyDict: {}, emptyData: Buffer.alloc(0) });
const newDoc = () => new DOMImplementation().createDocument(null, 'root', null);
const serialize = (node, strict = true) => new XMLSerializer().serializeToString(node, { requireWellFormed: strict });
const invalid = fn => assert.throws(fn, { name: 'InvalidStateError' });
function bytesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
    assert(!e.isSymbolicLink(), 'fixture symlinks forbidden');
    const p = path.join(dir, e.name);
    return sum + (e.isDirectory() ? bytesUnder(p) : fs.statSync(p).size);
  }, 0);
}
async function worker(name, dir) {
  assert(cases.includes(name));
  assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('mandalika-xml-'));
  assert(!fs.lstatSync(dir).isSymbolicLink());
  const detail = {};
  if (name === 'plist-typed') {
    const expected = typed();
    const xml = plist.build(expected);
    assert.match(xml, /<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<!DOCTYPE plist PUBLIC/);
    assert.deepEqual(plist.parse(xml), expected);
    // Independent hand-authored input, not just a same-library round trip.
    assert.deepEqual(plist.parse('<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><!--test--><dict>\n<key>name</key><string>A &amp; B 🌺</string><key>count</key><integer>42</integer><key>ratio</key><real>1.5</real><key>enabled</key><true/><key>disabled</key><false/><key>when</key><date>2026-01-02T03:04:05Z</date><key>bytes</key><data>AAH/</data><key>empty</key><string/><key>list</key><array><integer>2</integer></array></dict></plist>'),
      { name: 'A & B 🌺', count: 42, ratio: 1.5, enabled: true, disabled: false,
        when: new Date('2026-01-02T03:04:05Z'), bytes: Buffer.from([0, 1, 255]), empty: '', list: [2] });
    assert.deepEqual(plist.parse(plist.build(expected, { pretty: false })), expected);
    detail.xml = xml;
  } else if (name === 'capacitor-helper') {
    const data = { CFBundleIdentifier: 'example.synthetic', CFBundleDisplayName: 'Wangi 🌺',
      LSRequiresIPhoneOS: true, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'], ...typed() };
    const file = path.join(dir, 'Info.plist');
    fs.writeFileSync(file, plist.build(data));
    const helper = capRequire('./dist/util/spm.js').addInfoPlistDebugIfNeeded;
    await helper({ ios: { nativeTargetDirAbs: dir } });
    assert.deepEqual(plist.parse(fs.readFileSync(file, 'utf8')), { ...data, CAPACITOR_DEBUG: '$(CAPACITOR_DEBUG)' });
    const first = fs.readFileSync(file);
    await helper({ ios: { nativeTargetDirAbs: dir } });
    assert.deepEqual(fs.readFileSync(file), first, 'second helper invocation preserves existing configuration');
    detail.helper = 'real addInfoPlistDebugIfNeeded; insert then existing-value no-op';
  } else if (name === 'creation-names') {
    const doc = newDoc();
    for (const bad of ['good\nbad', 'good\rbad']) {
      for (const create of [() => doc.createElementNS(null, bad), () => doc.createAttributeNS(null, bad),
        () => doc.createAttribute(bad), () => doc.implementation.createDocumentType(bad, '', '')]) {
        assert.throws(create, { name: 'InvalidCharacterError' });
      }
    }
  } else if (name === 'strict-names') {
    const doc = newDoc();
    const attr = doc.createAttribute('safe'); attr.value = 'value'; attr.name = attr.nodeName = 'safe\nbad';
    invalid(() => serialize(attr));
    const el = doc.createElement('safe'); el.tagName = el.nodeName = el.localName = 'safe\nbad';
    invalid(() => serialize(el));
    // Default serialization remains permissive; upgrading is not a global validator.
    assert.match(serialize(el, false), /safe\nbad/);
  } else if (name === 'strict-pi') {
    const doc = newDoc();
    for (const target of ['bad target', 'bad?>target', 'XML']) {
      const pi = doc.createProcessingInstruction('safe', 'data'); pi.target = target;
      invalid(() => serialize(pi));
    }
  } else if (name === 'strict-doctype') {
    const doc = newDoc();
    const dt = doc.implementation.createDocumentType('safe', '', ''); doc.insertBefore(dt, doc.documentElement); dt.name = 'bad name';
    invalid(() => serialize(dt));
    for (const field of ['publicId', 'systemId']) {
      const d = doc.implementation.createDocumentType('safe', '', ''); new DOMImplementation().createDocument(null, 'root', d); d[field] = 'safe\n"\'bad';
      invalid(() => serialize(d));
    }
  } else if (name === 'strict-entity') {
    const doc = newDoc();
    assert.throws(() => doc.createEntityReference('bad name'), { name: 'InvalidCharacterError' });
    const entity = doc.createEntityReference('safe'); entity.nodeName = 'bad name';
    invalid(() => serialize(entity));
  } else if (name === 'end-tag-diagnostic') {
    const reports = [];
    const doc = new DOMParser({ onError: (level, message) => reports.push({ level, message }) })
      .parseFromString('<root>ok</root\ntrailing>', 'text/xml');
    assert.equal(doc.documentElement.textContent, 'ok', 'recovered DOM is allowed');
    assert(reports.some(r => r.level === 'error'), 'malformed end tag must report an XML error');
    // Actual plist default parser reports to console yet returns the recovered value.
    assert.equal(plist.parse('<plist><string>ok</string\ntrailing></plist>'), 'ok');
    detail.reports = reports;
  } else if (name === 'namespace-attributes-normalize') {
    const xml = Array.from({ length: 32 }, (_, i) => `<n xmlns:p${i}="urn:${i}">`).join('') +
      '<leaf ' + Array.from({ length: 32 }, (_, i) => `a${i}="${i}"`).join(' ') + '/>' + '</n>'.repeat(32);
    assert(Buffer.byteLength(xml) < 4096);
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const leaf = doc.getElementsByTagName('leaf')[0];
    assert.equal(leaf.attributes.length, 32);
    for (let i = 0; i < 32; i++) { assert.equal(leaf.getAttribute(`a${i}`), String(i)); assert.equal(leaf.lookupNamespaceURI(`p${i}`), `urn:${i}`); }
    const adjacent = doc.createElement('adjacent');
    for (let i = 0; i < 128; i++) adjacent.appendChild(doc.createTextNode(String(i % 10)));
    adjacent.normalize();
    assert.equal(adjacent.childNodes.length, 1);
    assert.equal(adjacent.textContent, Array.from({ length: 128 }, (_, i) => String(i % 10)).join(''));
    detail.limits = { namespaceDepth: 32, attributes: 32, adjacentTexts: 128, noPerformanceRatioClaim: true };
  } else if (name === 'html-raw-text') {
    for (const xml of ['<html><script>tiny</SCRIPT></html>', '<html><script>tiny']) {
      const reports = [];
      const doc = new DOMParser({ onError: (level, message) => reports.push({ level, message }) }).parseFromString(xml, 'text/html');
      if (xml.includes('</SCRIPT>')) assert.equal(doc.getElementsByTagName('script')[0].textContent, 'tiny');
      else {
        assert.equal(doc.getElementsByTagName('script')[0].textContent, '');
        assert(reports.some(r => r.level === 'error'), 'missing close reports discarded extra content');
      }
      assert(serialize(doc, false).length < 256, 'finite input must not amplify output');
    }
  }
  assert(bytesUnder(dir) <= limits.fixtureBytes);
  console.log(JSON.stringify({ name, status: 'pass', detail }));
}
if (option('--worker')) {
  worker(option('--worker'), path.resolve(option('--dir'))).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const expected = option('--expected-version') || '0.9.12';
  assert.equal(xmlManifest.version, expected);
  const rootRequire = createRequire(path.join(root, 'package.json'));
  const cap = JSON.parse(fs.readFileSync(capPath));
  const parent = JSON.parse(fs.readFileSync(plistPath));
  assert(rootRequire('semver').satisfies(parent.version, cap.dependencies.plist));
  assert(rootRequire('semver').satisfies(xmlManifest.version, parent.dependencies['@xmldom/xmldom']));
  const lock = rootRequire('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter(k => k.startsWith('@xmldom/xmldom@')), [`@xmldom/xmldom@${expected}`]);
  const results = [];
  for (const name of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandalika-xml-'));
    let result;
    try {
      const child = spawnSync(process.execPath, [`--max-old-space-size=${limits.heapMiB}`, `--stack-size=${limits.stackKiB}`,
        __filename, '--root', root, '--worker', name, '--dir', dir], { encoding: 'utf8', timeout: limits.timeoutMs, maxBuffer: limits.outputBytes });
      result = { name, exit: child.status, signal: child.signal, error: child.error?.code,
        stdout: child.stdout, stderr: child.stderr, fixtureBytes: bytesUnder(dir) };
      assert(result.fixtureBytes <= limits.fixtureBytes);
    } finally {
      assert(path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('mandalika-xml-'));
      assert(!fs.lstatSync(dir).isSymbolicLink());
      fs.rmSync(dir, { recursive: true });
      assert(!fs.existsSync(dir));
    }
    result.cleanup = 'verified'; results.push(result);
  }
  const report = { parent: { capacitor: cap.version, plist: parent.version, plistRange: cap.dependencies.plist,
    xmldomRange: parent.dependencies['@xmldom/xmldom'], xmldom: xmlManifest.version, manifest: xmlPath }, limits, results };
  if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (results.some(r => r.exit !== 0)) process.exitCode = 1;
}
