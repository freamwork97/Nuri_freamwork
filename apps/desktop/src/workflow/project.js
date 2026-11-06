// A project folder per autopilot task: workspace/projects/<date>_<slug>/ holding the plan,
// step outputs, downloads and final documents, so every result can be opened afterwards.

const fs = require('node:fs');
const path = require('node:path');
const { WORKSPACE_DIR } = require('../config');
const { t, locale } = require('../i18n');

const PROJECTS_DIR = path.join(WORKSPACE_DIR, 'projects');
const LOG_DIR = '_log'; // the app's own records stay out of the user's results

function slugify(text) {
  return String(text || 'task')
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, '_')
    .slice(0, 40)
    .replace(/_+$/, '') || 'task';
}

function createProject(goal) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  let dir = path.join(PROJECTS_DIR, `${stamp}_${slugify(goal)}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(PROJECTS_DIR, `${stamp}_${slugify(goal)}_${i}`);
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  fs.mkdirSync(path.join(dir, LOG_DIR));
  const project = { dir, goal, createdAt: d.toISOString() };
  fs.writeFileSync(path.join(dir, LOG_DIR, 'README.md'), `# ${goal}\n\n${t('생성')}: ${d.toLocaleString(locale())}\n`, 'utf8');
  return project;
}

function writeJson(project, name, data) {
  fs.writeFileSync(path.join(project.dir, LOG_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

function appendLog(project, text) {
  fs.appendFileSync(path.join(project.dir, LOG_DIR, 'README.md'), `\n${text}\n`, 'utf8');
}

/** Files in the project (recursive, relative paths), newest first. */
function listProjectFiles(project) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== LOG_DIR) walk(full);
      }
      else out.push({ rel: path.relative(project.dir, full), full, mtime: fs.statSync(full).mtimeMs, size: fs.statSync(full).size });
    }
  };
  walk(project.dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}

module.exports = { createProject, writeJson, appendLog, listProjectFiles, slugify, PROJECTS_DIR };
