// Shared platform paths used by the app, downloader and tests.
const path = require('node:path');
const os = require('node:os');

function chromiumLayout(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return { target: 'win64', folder: 'chrome-win64', executable: 'chrome.exe' };
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    const target = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    return { target, folder: `chrome-${target}`, executable: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' };
  }
  throw new Error(`Bundled Chromium is not supported on ${platform}/${arch}`);
}

function bundledBrowser(root, platform = process.platform, arch = process.arch) {
  if (!['win32', 'darwin'].includes(platform)) return null;
  const layout = chromiumLayout(platform, arch);
  return path.join(root, 'vendor', layout.folder, layout.executable);
}

function appDataBase(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

// Finder launches do not inherit the user's interactive shell PATH.
function macPath(current = '', home = os.homedir()) {
  return [...new Set([path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...current.split(':').filter(Boolean), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
}

module.exports = { chromiumLayout, bundledBrowser, appDataBase, macPath };
