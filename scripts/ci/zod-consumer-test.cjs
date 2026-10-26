// Version, resolution and behaviour checks only; no new dependencies, no network.
// zod reaches the repo only through eslint-plugin-react-hooks (a root lint devDependency),
// which validates its rule options with zod and formats errors with zod-validation-error.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const root = path.resolve(option('--root') || process.cwd());
const expected = option('--expected-version') || '4.6.6';
const parentManifest = fs.realpathSync(path.join(root, 'node_modules/eslint-plugin-react-hooks/package.json'));
const parentRequire = createRequire(parentManifest);
const parent = JSON.parse(fs.readFileSync(parentManifest, 'utf8'));
// Locate zod beside the plugin's installed copy (pnpm sibling link) and prove the runtime
// entry resolves to that same directory.
const zodManifest = fs.realpathSync(path.join(path.dirname(parentManifest), '..', 'zod', 'package.json'));
assert(fs.realpathSync(parentRequire.resolve('zod')).startsWith(path.dirname(zodManifest) + path.sep));
const manifest = JSON.parse(fs.readFileSync(zodManifest, 'utf8'));
const rootRequire = createRequire(path.join(root, 'package.json'));
const semver = rootRequire('semver');

// Resolved from the plugin's actual install, at or above the fixed version (GHSA-mrhx-c7xc-m3w5).
assert.equal(manifest.name, 'zod');
assert(semver.gte(manifest.version, '4.6.6'), `zod ${manifest.version} is below 4.6.6`);
assert.equal(manifest.version, expected);
// Override stays inside the parent's declared range.
assert(semver.satisfies(manifest.version, parent.dependencies.zod));
// Lock holds exactly one zod, no stale vulnerable copy.
const lock = rootRequire('yaml').parse(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'));
assert.deepEqual(Object.keys(lock.packages).filter(k => k.startsWith('zod@')), [`zod@${expected}`]);
assert.equal(lock.overrides['eslint-plugin-react-hooks@7.1.1>zod'], expected);

// zod-validation-error (the plugin's other zod consumer) must see the same zod.
const zveManifest = fs.realpathSync(path.join(path.dirname(parentManifest), '..', 'zod-validation-error', 'package.json'));
const zveRequire = createRequire(zveManifest);
assert.equal(fs.realpathSync(zveRequire.resolve('zod')), fs.realpathSync(parentRequire.resolve('zod')));

// Behaviour the plugin relies on: parse, safeParse failure, and error formatting.
const { z } = parentRequire('zod');
const schema = z.object({ additionalHooks: z.string().optional() }).strict();
assert.deepEqual(schema.parse({ additionalHooks: 'useX' }), { additionalHooks: 'useX' });
const bad = schema.safeParse({ unknownOption: true });
assert.equal(bad.success, false);
const { fromError } = zveRequire('zod-validation-error');
assert.match(fromError(bad.error).message, /unknownOption|Unrecognized/);

// The plugin itself loads with the overridden zod.
const plugin = parentRequire(parentManifest.replace(/package\.json$/, ''));
assert(plugin.rules && plugin.rules['rules-of-hooks'] && plugin.rules['exhaustive-deps']);
console.log(`zod consumer test: ok (zod ${manifest.version}, eslint-plugin-react-hooks ${parent.version})`);
