// Document tools for the agents: read common office/PDF files as text, and write Hangul (HWP)
// documents from Markdown through the installed Hancom Office (native/hwp.ps1, COM automation).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { unzipSync, strFromU8 } = require('fflate');
const { t } = require('../i18n');

const HWP_SCRIPT = path.join(require('../config').NATIVE_DIR, 'hwp.ps1');
const MAX_READ = 60_000;

const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

function unzipText(file, filter) {
  const files = unzipSync(fs.readFileSync(file), { filter: (f) => filter(f.name) });
  return Object.keys(files)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => ({ name, xml: strFromU8(files[name]) }));
}

function docxText(file) {
  return unzipText(file, (n) => n === 'word/document.xml')
    .map(({ xml }) =>
      xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>') // a cell's last paragraph: stay on the row
        .replace(/<\/w:tc>/g, ' | ')
        .replace(/<\/w:tr>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    )
    .map(decodeXml)
    .join('\n');
}

function hwpxText(file) {
  return unzipText(file, (n) => /^Contents\/section\d+\.xml$/.test(n))
    .map(({ xml }) => xml.replace(/<\/hp:p>/g, '\n').replace(/<\/hp:tc>/g, ' | ').replace(/<hp:t>/g, '').replace(/<[^>]+>/g, ''))
    .map(decodeXml)
    .join('\n');
}

function xlsxText(file) {
  const parts = unzipText(file, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const sst = parts.find((p) => p.name === 'xl/sharedStrings.xml');
  const strings = sst ? [...sst.xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml(m[1].replace(/<[^>]+>/g, ''))) : [];
  const out = [];
  for (const sheet of parts.filter((p) => p.name.includes('worksheets'))) {
    out.push(`# ${path.basename(sheet.name, '.xml')}`);
    for (const row of sheet.xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] || '')?.[1] ?? '';
        return /t="s"/.test(c[1]) ? strings[+v] ?? '' : decodeXml(v);
      });
      out.push(cells.join('\t'));
    }
  }
  return out.join('\n');
}

async function pdfText(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages && pages.join('').length < MAX_READ; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    let lastY = null;
    const lines = [];
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = '';
      }
      line += item.str;
      lastY = y;
    }
    lines.push(line);
    pages.push(`--- ${i}쪽 ---\n${lines.join('\n')}`);
  }
  await doc.destroy();
  return pages.join('\n');
}

function runHwp(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error(t('한글(HWP) 자동화는 Windows에서만 동작합니다')));
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HWP_SCRIPT, ...args], { windowsHide: true });
    p.stdin.end();
    let out = '';
    let err = '';
    let hwpPid = 0; // the automation Hwp.exe (reported first by hwp.ps1); killed on timeout
    const timer = setTimeout(() => {
      p.kill();
      // A hung Hangul instance may hold a dialog on the user's screen: end it too.
      if (hwpPid) spawn('taskkill', ['/F', '/PID', String(hwpPid)], { windowsHide: true }).on('error', () => {});
      reject(new Error(t('한글 자동화 시간 초과')));
    }, timeoutMs);
    p.stdout.on('data', (d) => {
      out += d;
      const m = /\{"pid":(\d+)\}/.exec(out);
      if (m) hwpPid = Number(m[1]);
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop() || '';
      try {
        const r = JSON.parse(line);
        if (r.ok) resolve(r);
        else reject(new Error(t('한글 자동화 실패: {error}', { error: r.error })));
      } catch {
        reject(new Error(t('한글 자동화 응답 오류: {out}', { out: (out + err).slice(0, 300) })));
      }
    });
  });
}

async function hwpText(file) {
  const tmp = path.join(os.tmpdir(), `anb-hwp-${Date.now()}.txt`);
  try {
    await runHwp(['read', file, tmp], 90_000);
    return fs.readFileSync(tmp, 'utf8');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const READABLE = new Set(['.pdf', '.docx', '.hwpx', '.hwp', '.xlsx', '.html', '.htm', '.txt', '.md', '.csv', '.json', '.xml']);
const MAX_ZIP_FILES = 200;
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

/** Zip entry names without the UTF-8 flag are usually CP949 (Korean Windows); fflate gives them as latin1. */
function zipName(name) {
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name;
  try {
    return new TextDecoder('euc-kr', { fatal: true }).decode(Buffer.from(name, 'latin1'));
  } catch {
    return name;
  }
}

/** Extracts a zip next to itself ("<name>_압축해제") safely; returns the extracted file paths. */
function extractZip(file) {
  const dir = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}_압축해제`);
  let count = 0;
  let bytes = 0;
  const entries = unzipSync(fs.readFileSync(file), {
    filter: (f) => !f.name.endsWith('/') && ++count <= MAX_ZIP_FILES && (bytes += f.originalSize) <= MAX_ZIP_BYTES,
  });
  const out = [];
  for (const [raw, data] of Object.entries(entries)) {
    // Each path segment is sanitized; "..", drive letters and absolute paths cannot escape `dir`.
    const parts = zipName(raw).split(/[\\/]+/).map((seg) => seg.replace(/[:*?"<>|\u0000-\u001f]/g, '_').trim()).filter((seg) => seg && seg !== '.' && seg !== '..');
    if (!parts.length) continue;
    const target = path.join(dir, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    out.push(target);
  }
  return { dir, files: out, skipped: Math.max(0, count - MAX_ZIP_FILES) };
}

async function zipText(file) {
  const { dir, files, skipped } = extractZip(file);
  const lines = [`[압축 파일] ${files.length}개 파일을 다음 폴더에 풀었습니다: ${dir}${skipped ? ` (${skipped}개는 개수 제한으로 생략)` : ''}`];
  for (const f of files) lines.push(`- ${f}`);
  // Inline the readable documents so analysts without tools also see them.
  for (const f of files.filter((x) => READABLE.has(path.extname(x).toLowerCase()))) {
    try {
      lines.push(`\n=== ${path.basename(f)} ===\n${await readDocument(f, { maxChars: 20_000 })}`);
    } catch (e) {
      lines.push(`\n=== ${path.basename(f)} ===\n(읽기 실패: ${e.message})`);
    }
  }
  return lines.join('\n');
}

/** Reads a document as plain text (truncated to maxChars). */
async function readDocument(file, { maxChars = MAX_READ } = {}) {
  if (!fs.existsSync(file)) throw new Error(t('파일이 없습니다: {file}', { file }));
  const ext = path.extname(file).toLowerCase();
  let text;
  switch (ext) {
    case '.pdf': text = await pdfText(file); break;
    case '.docx': text = docxText(file); break;
    case '.hwpx': text = hwpxText(file); break;
    case '.hwp': text = await hwpText(file); break;
    case '.xlsx': text = xlsxText(file); break;
    case '.html':
    case '.htm': text = fs.readFileSync(file, 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '); break;
    case '.zip': text = await zipText(file); break;
    default: {
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8192).includes(0)) throw new Error(t('텍스트로 읽을 수 없는 형식입니다 ({ext}). 지원: PDF, HWP, HWPX, DOCX, XLSX, ZIP, TXT', { ext: ext || t('확장자 없음') }));
      text = buf.toString('utf8');
    }
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(이하 ${text.length - maxChars}자 생략)` : text;
}

/**
 * Markdown -> hwp.ps1 spec. Supports: "# title" (first H1 = document title), "## / ###" headings,
 * paragraphs, "- " bullets, "| a | b |" tables, and "---pagebreak---" / "\pagebreak".
 */
function markdownToSpec(md, { title, subtitle } = {}) {
  const spec = { title: title || '', subtitle: subtitle || '', blocks: [] };
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (para.length) spec.blocks.push({ type: 'paragraph', text: para.join('\n') });
    para = [];
  };
  const clean = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    if (/^(---\s*pagebreak\s*---|\\pagebreak)$/i.test(t)) {
      flush();
      spec.blocks.push({ type: 'pagebreak' });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      if (h[1].length === 1 && !spec.title) spec.title = clean(h[2]);
      else spec.blocks.push({ type: 'heading', level: Math.max(1, h[1].length - 1), text: clean(h[2]) });
      continue;
    }
    if (/^[-*•]\s+/.test(t)) {
      flush();
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(clean(lines[i++].trim().replace(/^[-*•]\s+/, '')));
      i--;
      spec.blocks.push({ type: 'bullets', items });
      continue;
    }
    if (/^\|.*\|$/.test(t)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => clean(c));
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      if (rows.length) spec.blocks.push({ type: 'table', headers: rows[0], rows: rows.slice(1) });
      continue;
    }
    if (/^>\s?/.test(t)) {
      para.push(clean(t.replace(/^>\s?/, '')));
      continue;
    }
    para.push(clean(t));
  }
  flush();
  return spec;
}

/** Writes a Hangul document (.hwp or .hwpx) from Markdown; also a PDF when pdfPath is given. */
async function writeHwp(markdown, outPath, { pdfPath, title, subtitle } = {}) {
  const spec = markdownToSpec(markdown, { title, subtitle });
  const specFile = path.join(os.tmpdir(), `anb-spec-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
  try {
    const args = ['write', specFile, outPath];
    if (pdfPath) args.push(pdfPath);
    const r = await runHwp(args);
    return { path: outPath, pdf: r.pdf ? pdfPath : null, pages: r.pages, tables: r.tables, blocks: spec.blocks.length };
  } finally {
    fs.rmSync(specFile, { force: true });
  }
}

module.exports = { readDocument, writeHwp, markdownToSpec, docxText, hwpxText, xlsxText, extractZip, zipName };
