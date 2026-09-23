// Resolve selected PostCSS through real workspace consumers, never a .pnpm cache path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
module.exports = function postcssContext(root) {
  const contexts = [];
  for (const app of ['pos', 'backoffice']) {
    const ar = createRequire(path.join(root, 'apps', app, 'package.json'));
    for (const entry of ['vite', 'vitest', '@tailwindcss/vite']) {
      const entryFile = ar.resolve(entry);
      const vr = entry === 'vite' ? ar : createRequire(entryFile);
      const viteFile = vr.resolve('vite/package.json');
      const vreq = createRequire(viteFile);
      const parentFile = fs.realpathSync(vreq.resolve('postcss/package.json'));
      const pr = createRequire(parentFile);
      const parent = JSON.parse(fs.readFileSync(parentFile));
      const nanoFile = fs.realpathSync(pr.resolve('nanoid/package.json'));
      const nano = JSON.parse(fs.readFileSync(nanoFile));
      const vite = JSON.parse(fs.readFileSync(viteFile));
      const semver = createRequire(path.join(root, 'package.json'))('semver');
      assert(semver.satisfies(parent.version, vite.dependencies.postcss));
      assert(semver.satisfies(nano.version, parent.dependencies.nanoid));
      contexts.push({ app, entry, entryFile, viteFile, viteVersion: vite.version,
        postcssRange: vite.dependencies.postcss, parentFile, postcssVersion: parent.version,
        nanoFile, nanoVersion: nano.version, nanoRange: parent.dependencies.nanoid });
    }
  }
  // Fail closed if the graph gains another copy requiring independent qualification.
  assert.equal(new Set(contexts.map(c => c.parentFile)).size, 1, 'Multiple selected PostCSS copies require qualification');
  assert.equal(new Set(contexts.map(c => c.nanoFile)).size, 1, 'Multiple selected Nano ID copies require qualification');
  return { parentFile: contexts[0].parentFile, contexts };
};
