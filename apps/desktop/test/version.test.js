const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Nuri has one version: every package, the extension manifests and the engine say the same.
test('all parts of Nuri carry the same version', () => {
  const app = JSON.parse(read('apps/desktop/package.json')).version;
  const files = ['package.json', 'apps/desktop/extension/manifest.json', 'extension/manifest.json', ...fs.readdirSync(path.join(ROOT, 'packages')).map((d) => `packages/${d}/package.json`)];
  for (const f of files) assert.strictEqual(JSON.parse(read(f)).version, app, f);
  assert.match(read('packages/anb-orchestrator/src/version.ts'), new RegExp(`VERSION = '${app.replace(/\./g, '\\.')}'`));
});
