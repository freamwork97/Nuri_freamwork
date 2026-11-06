const fs = require('node:fs');
const path = require('node:path');
const { LOG_DIR, PROFILE } = require('./config');

const file = path.join(LOG_DIR, PROFILE ? `desktop-${PROFILE}.log` : 'desktop.log');
const MAX_BYTES = 5 * 1024 * 1024;

function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Simple rotation so the log can't grow forever.
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, line);
  } catch {
    /* logging must never break the app */
  }
}

module.exports = { log };
