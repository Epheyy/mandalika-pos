const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
module.exports = function browserslistContext(root) {
  const rr = createRequire(path.join(root, 'package.json'));
  const hooksFile = rr.resolve('eslint-plugin-react-hooks');
  const hooks = createRequire(hooksFile);
  const babelFile = hooks.resolve('@babel/core/package.json');
  const babel = createRequire(babelFile);
  const helperFile = babel.resolve('@babel/helper-compilation-targets/package.json');
  const helper = createRequire(helperFile);
  const file = fs.realpathSync(helper.resolve('browserslist/package.json'));
  const br = createRequire(file);
  const manifest = JSON.parse(fs.readFileSync(file));
  const helperManifest = JSON.parse(fs.readFileSync(helperFile));
  assert(rr('semver').satisfies(manifest.version, helperManifest.dependencies.browserslist));
  const peerFile = br.resolve('update-browserslist-db/package.json');
  const peer = createRequire(peerFile);
  const peerManifest = JSON.parse(fs.readFileSync(peerFile));
  assert.equal(fs.realpathSync(peer.resolve('browserslist/package.json')), file);
  assert(rr('semver').satisfies(manifest.version, peerManifest.peerDependencies.browserslist));
  const children = Object.fromEntries(Object.keys(manifest.dependencies).map(name => {
    let childFile;
    try { childFile = br.resolve(name + '/package.json'); } catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      let dir = path.dirname(br.resolve(name));
      while (true) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate)).name === name) { childFile = candidate; break; }
        const parent = path.dirname(dir); assert.notEqual(parent, dir); dir = parent;
      }
    }
    const child = JSON.parse(fs.readFileSync(childFile));
    assert(rr('semver').satisfies(child.version, manifest.dependencies[name]));
    return [name, { version: child.version, range: manifest.dependencies[name], file: childFile }];
  }));
  return { hooksFile, babelFile, helperFile, file, version: manifest.version,
    helperRange: helperManifest.dependencies.browserslist, peerFile,
    peerRange: peerManifest.peerDependencies.browserslist, children };
};
