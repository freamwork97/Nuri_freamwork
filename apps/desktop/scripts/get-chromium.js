// Downloads the Chromium (Chrome for Testing) that ANB uses for Google sign-in and the Chromium
// session into vendor/chrome-win64. It is too big for the repository (one file is over 100 MB).
//   npm run get-chromium            -> <repo>/vendor/chrome-win64
//   node scripts/get-chromium.js <dir>  -> <dir>/chrome-win64

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { chromiumLayout } = require('../src/platform');
const VERSION = '156.0.8078.47';


async function main() {
  const { target, folder, executable } = chromiumLayout();
  const URL = `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${target}/chrome-${target}.zip`;
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'vendor'));
  const dir = path.join(out, folder);
  if (fs.existsSync(path.join(dir, `${VERSION}.manifest`)) && fs.existsSync(path.join(dir, executable))) {
    console.log(`Chromium ${VERSION} is already in ${dir}`);
    return;
  }
  const zip = path.join(os.tmpdir(), `chrome-${target}-${VERSION}.zip`);
  console.log(`Downloading Chromium ${VERSION} ...`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${URL}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const r = process.platform === 'darwin'
    ? spawnSync('/usr/bin/ditto', ['-x', '-k', zip, out], { stdio: 'inherit' })
    : spawnSync('tar', ['-xf', zip, '-C', out], { stdio: 'inherit' }); // tar.exe ships with Windows 10+
  fs.rmSync(zip, { force: true });
  if (r.status !== 0 || !fs.existsSync(path.join(dir, executable))) throw new Error('could not extract the zip');
  fs.writeFileSync(path.join(dir, `${VERSION}.manifest`), target);
  console.log(`Chromium ${VERSION} is ready in ${dir}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
