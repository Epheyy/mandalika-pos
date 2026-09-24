const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
module.exports = root => {
  const rr = createRequire(path.join(root, 'package.json')), semver = rr('semver'), contexts = [];
  for (const app of ['pos', 'backoffice']) {
    const file = path.join(root, 'apps', app, 'package.json'), ar = createRequire(file), manifest = JSON.parse(fs.readFileSync(file));
    for (const entry of ['vite', 'vitest', '@tailwindcss/vite', '@vitejs/plugin-react']) {
      const entryFile = ar.resolve(entry), er = createRequire(entryFile);
      const viteFile = fs.realpathSync((entry === 'vite' ? ar : er).resolve('vite/package.json'));
      const vr = createRequire(viteFile), vite = JSON.parse(fs.readFileSync(viteFile));
      let entryManifest;
      if (entry !== 'vite') {
        let dir = path.dirname(entryFile);
        while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).name !== entry) { const parent = path.dirname(dir); assert.notEqual(parent, dir); dir = parent; }
        entryManifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
      }
      const range = entry === 'vite' ? manifest.devDependencies.vite : entryManifest.peerDependencies?.vite || entryManifest.dependencies?.vite;
      assert(range && semver.satisfies(vite.version, range), entry + ' Vite range');
      const children = Object.fromEntries(Object.entries(vite.dependencies).map(([name, range]) => {
        let childFile;
        try { childFile = vr.resolve(name + '/package.json'); } catch (error) {
          if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
          let dir = path.dirname(vr.resolve(name));
          while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).name !== name) { const parent = path.dirname(dir); assert.notEqual(parent, dir); dir = parent; }
          childFile = path.join(dir, 'package.json');
        }
        const child = JSON.parse(fs.readFileSync(childFile));
        assert(semver.satisfies(child.version, range), name + ' range'); return [name, { file: childFile, version: child.version, range }];
      }));
      contexts.push({ app, entry, entryFile, range, viteFile, version: vite.version, engines: vite.engines, children });
    }
  }
  assert.equal(new Set(contexts.map(c => c.viteFile)).size, 1, 'Multiple selected Vite copies need qualification');
  const postcss = require('./postcss-context.cjs')(root).contexts;
  assert(postcss.every(c => c.postcssVersion === '8.5.23' && c.nanoVersion === '3.3.18'));
  const rolldown = contexts[0].children.rolldown;
  const rd = createRequire(rolldown.file);
  const platform = process.platform === 'win32' ? 'win32-' + process.arch + '-msvc' : process.platform === 'linux' ? 'linux-' + process.arch + (process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl') : process.platform + '-' + process.arch;
  const packageName = '@rolldown/binding-' + platform;
  const nativeFile = fs.realpathSync(rd.resolve(packageName));
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(nativeFile)).digest('hex');
  return { contexts, postcss, native: { packageName, version: rolldown.version, file: nativeFile, sha256: digest } };
};
