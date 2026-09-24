const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
module.exports = root => {
  const rr = createRequire(path.join(root, 'package.json'));
  const eslint = rr.resolve('eslint/package.json');
  const api = createRequire(path.join(root, 'packages/api/package.json'));
  const generator = api.resolve('openapi-typescript');
  const parents = [createRequire(eslint).resolve('@eslint/eslintrc/package.json'),
    createRequire(generator).resolve('@redocly/openapi-core/package.json')];
  return parents.map(parent => {
    const pr = createRequire(parent), manifest = JSON.parse(fs.readFileSync(parent));
    const file = fs.realpathSync(pr.resolve('js-yaml/package.json'));
    const yaml = JSON.parse(fs.readFileSync(file));
    const declared = manifest.dependencies['js-yaml'];
    const rangeSatisfied = rr('semver').satisfies(yaml.version, declared);
    // Redocly publishes an exact legacy pin. Only this tested, scoped override is qualified.
    assert(rangeSatisfied || (manifest.name === '@redocly/openapi-core' && manifest.version === '1.34.14' && declared === '4.1.1' && yaml.version === '4.3.2'));
    const argumentParser = createRequire(file).resolve('argparse/package.json');
    assert(rr('semver').satisfies(JSON.parse(fs.readFileSync(argumentParser)).version, yaml.dependencies.argparse));
    return { parent, name: manifest.name, parentVersion: manifest.version, declared, rangeSatisfied,
      file, version: yaml.version, argumentParser, eslint, generator };
  });
};
