// Version and resolution checks only; no new dependencies, no network.
// DOMPurify needs a DOM (window) to sanitize, and the repo has no jsdom/happy-dom,
// so no sanitize() regression runs here. The only consumer of jsPDF in this repo
// (apps/backoffice/src/screens/transfers/docs/render.ts) calls addImage/output and
// never jsPDF.html(), the one path that uses dompurify.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const root = path.resolve(option('--root') || process.cwd());
const expected = option('--expected-version') || '3.4.17';
const parentManifest = fs.realpathSync(path.join(root, 'apps/backoffice/node_modules/jspdf/package.json'));
const parentRequire = createRequire(parentManifest);
// dompurify's "exports" hides package.json, so locate the manifest beside jsPDF's installed copy
// (pnpm sibling link) and prove the runtime entry resolves to that same directory.
const dompurifyManifest = fs.realpathSync(path.join(path.dirname(parentManifest), '..', 'dompurify', 'package.json'));
assert(fs.realpathSync(parentRequire.resolve('dompurify')).startsWith(path.dirname(dompurifyManifest) + path.sep));
const manifest = JSON.parse(fs.readFileSync(dompurifyManifest, 'utf8'));
const parent = JSON.parse(fs.readFileSync(parentManifest, 'utf8'));
const rootRequire = createRequire(path.join(root, 'package.json'));
const semver = rootRequire('semver');

// Resolved from jsPDF's actual manifest, at or above the fixed version (GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr).
assert.equal(manifest.name, 'dompurify');
assert(semver.gte(manifest.version, '3.4.17'), `dompurify ${manifest.version} is below 3.4.17`);
assert.equal(manifest.version, expected);
// Override stays inside the parent's declared range.
assert(semver.satisfies(manifest.version, parent.optionalDependencies.dompurify));
// Lock holds exactly one dompurify, no stale vulnerable copy.
const lock = rootRequire('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
assert.deepEqual(Object.keys(lock.packages).filter(k => k.startsWith('dompurify@')), [`dompurify@${expected}`]);
assert.equal(lock.overrides['jspdf@4.2.1>dompurify'], expected);
// Entry point loads. Without a DOM (plain Node) it is an unsupported factory, so only its shape and version are checked.
const DOMPurify = parentRequire('dompurify');
assert.equal(typeof DOMPurify, 'function');
assert.equal(DOMPurify.version, expected);
assert.equal(DOMPurify.isSupported, false);
assert.equal(typeof DOMPurify(), 'function');

console.log(JSON.stringify({ status: 'pass', jspdf: parent.version, jspdfRange: parent.optionalDependencies.dompurify,
  dompurify: manifest.version, manifest: dompurifyManifest }, null, 2));
