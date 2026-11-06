// Non-UI tools shared by the browser and desktop agents: project files, document reading and
// full-page text extraction. Results that can be long are returned as `output`, which the agent
// shows to the model once (next turn) instead of keeping it in the step history.

const fs = require('node:fs');
const path = require('node:path');
const { readDocument } = require('../documents');
const { toXlsx } = require('../documents/xlsx');
const { listFiles } = require('../automation/actions');

const TOOL_TYPES = new Set(['save_file', 'copy_file', 'read_file', 'read_document', 'read_page', 'list_files']);
const PAGE_CHUNK = 14_000;
// Files that save_file may open afterwards (open:true) with their default app. Never programs.
const OPENABLE = /\.(xlsx|csv|docx|hwp|hwpx|pdf|md|txt|json|html?)$/i;

/** The user's own folders that save_file/copy_file may write to: Desktop, Documents, Downloads, ... */
function defaultUserDirs() {
  try {
    const { app } = require('electron');
    return ['desktop', 'documents', 'downloads', 'pictures', 'videos'].map((n) => app.getPath(n));
  } catch {
    return []; // plain Node (tests)
  }
}

const inside = (dir, file) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Resolves a file name: plain names go into the work folder. Absolute paths can always be read;
 * written only inside the work folder or the user's folders (Desktop, Documents, Downloads, ...).
 */
function resolveIn(workdir, name, { forWrite = false, userDirs = [] } = {}) {
  const raw = String(name || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw new Error('file name is required');
  if (path.isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw)) {
    const allowed = (d) => d && (inside(d, raw) || path.resolve(d) === path.resolve(raw)); // the folder itself: copy_file target
    if (forWrite && ![workdir, ...userDirs].some(allowed)) {
      throw new Error(`can write only in the work folder or the user's folders (${userDirs.join(', ') || 'Desktop, Documents, Downloads'})`);
    }
    return raw;
  }
  const full = path.resolve(workdir, raw);
  if (!inside(workdir, full)) throw new Error('file name must stay inside the work folder');
  return full;
}

function openFile(file) {
  try {
    const { shell } = require('electron');
    if (shell?.openPath) shell.openPath(file);
    return !!shell?.openPath;
  } catch {
    return false;
  }
}

/** Full rendered text of the page and its frames (read-only); table cells joined with " | ". */
async function pageText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const t = await frame
      // innerText already lays tables out as tab-separated rows; make the columns explicit.
      .evaluate(() => (document.body ? document.body.innerText : '').replace(/\t+/g, ' | '))
      .catch(() => '');
    if (t && t.trim()) parts.push(frame === page.mainFrame() ? t : `\n[frame ${frame.url().slice(0, 80)}]\n${t}`);
  }
  return parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @returns {Promise<{summary:string, output?:string}>}
 */
async function runTool(action, { workdir, page, userDirs = defaultUserDirs() }) {
  const a = action || {};
  fs.mkdirSync(workdir, { recursive: true });
  const where = (file) => (inside(workdir, file) ? `in ${workdir}` : `at ${file}`);
  const opened = (file) => (a.open && OPENABLE.test(file) && openFile(file) ? ' and opened it' : '');
  switch (a.type) {
    case 'save_file': {
      const file = resolveIn(workdir, a.name || a.path, { forWrite: true, userDirs });
      const content = String(a.content ?? '');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (/\.xlsx$/i.test(file)) {
        // A real Excel file from Markdown tables / CSV: no Excel window, no mouse or keyboard.
        if (a.append) return { summary: 'FAILED: append is not supported for .xlsx; save the full table again' };
        const { buffer, sheets } = toXlsx(content, path.basename(file, '.xlsx'));
        fs.writeFileSync(file, buffer);
        return { summary: `saved Excel file ${path.basename(file)} (${sheets.map((s) => `${s.name}: ${Math.max(0, s.rows - 1)} rows`).join(', ')}) ${where(file)}${opened(file)}` };
      }
      if (/\.(docx|hwp|hwpx|pdf)$/i.test(file)) {
        // Word / 한글 / PDF documents from Markdown, made by Hangul in the background (no window).
        if (a.append) return { summary: 'FAILED: append is not supported for documents; save the full text again' };
        const { writeHwp } = require('../documents');
        const pdf = /\.pdf$/i.test(file);
        const out = pdf ? path.join(require('node:os').tmpdir(), `anb-doc-${Date.now()}.hwp`) : file;
        const r = await writeHwp(content, out, pdf ? { pdfPath: file } : {});
        if (pdf) fs.rmSync(out, { force: true });
        return { summary: `saved document ${path.basename(file)} (${r.pages || '?'} pages) ${where(file)}${opened(file)}` };
      }
      if (/\.csv$/i.test(file) && !a.append && !content.startsWith('\uFEFF')) {
        fs.writeFileSync(file, '\uFEFF' + content, 'utf8'); // BOM: Excel opens Korean CSV correctly
        return { summary: `saved ${path.basename(file)} (${content.length} chars) ${where(file)}${opened(file)}` };
      }
      if (a.append) fs.appendFileSync(file, content.endsWith('\n') ? content : content + '\n', 'utf8');
      else fs.writeFileSync(file, content, 'utf8');
      return { summary: `${a.append ? 'appended to' : 'saved'} ${path.basename(file)} (${content.length} chars) ${where(file)}${opened(file)}` };
    }
    case 'copy_file': {
      const from = resolveIn(workdir, a.from);
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return { summary: `FAILED: no such file ${from}` };
      let to = resolveIn(workdir, a.to, { forWrite: true, userDirs });
      if (fs.existsSync(to) && fs.statSync(to).isDirectory()) to = path.join(to, path.basename(from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      return { summary: `copied ${path.basename(from)} to ${to}${opened(to)}` };
    }
    case 'read_file':
    case 'read_document': {
      const file = resolveIn(workdir, a.name || a.path);
      const text = await readDocument(file, { maxChars: 40_000 });
      return { summary: `read ${path.basename(file)} (${text.length} chars; shown below once)`, output: `CONTENT OF ${file}:\n${text}` };
    }
    case 'read_page': {
      if (!page) return { summary: 'FAILED: no page to read' };
      const text = await pageText(page);
      const part = Math.max(1, Number(a.part) || 1);
      const total = Math.max(1, Math.ceil(text.length / PAGE_CHUNK));
      const chunk = text.slice((part - 1) * PAGE_CHUNK, part * PAGE_CHUNK);
      return {
        summary: `read page text part ${part}/${total} (${chunk.length} chars; shown below once)${part < total ? ` — use {"type":"read_page","part":${part + 1}} for more` : ''}`,
        output: `PAGE TEXT (part ${part}/${total}) of ${page.url().slice(0, 120)}:\n${chunk}`,
      };
    }
    case 'list_files': {
      const text = listFiles(a.dir || null);
      return { summary: 'listed files (shown below once)', output: `FILES:\n${text}\n\nWORK FOLDER ${workdir}:\n${fs.readdirSync(workdir).join('\n') || '(empty)'}` };
    }
    default:
      return { summary: `FAILED: unknown tool ${a.type}` };
  }
}

module.exports = { runTool, TOOL_TYPES, pageText, resolveIn, defaultUserDirs };
