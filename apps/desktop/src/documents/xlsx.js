// Excel (.xlsx) files written directly (no Excel, no mouse/keyboard): Markdown tables or CSV
// become sheets with a bold, frozen, filterable header row and fitted column widths.

const { zipSync, strToU8 } = require('fflate');
const { t } = require('../i18n');

const esc = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Column letters: 0 -> A, 25 -> Z, 26 -> AA. */
function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Plain numbers ("1,234", "-5", "3.14", "12%") become numbers; IDs like "007" or "R26-1" stay text. */
function cellValue(raw) {
  const t = String(raw ?? '').trim();
  if (/^=[A-Za-z(]/.test(t) && t.length < 1000) return { formula: t.slice(1) };
  const m = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?)$/.exec(t);
  if (!m || (/^-?0\d/.test(t.replace(/,/g, '')) && !m[3]) || t.replace(/\D/g, '').length > 15) return { text: t };
  const n = Number(`${m[1]}${m[2].replace(/,/g, '')}${m[3] || ''}`);
  if (m[4]) return { num: n / 100, style: 3 };
  // Keep the decimals that were written (1571.0 stays 1,571.0); thousands separators for big numbers.
  const decimals = m[3] ? m[3].length - 1 : 0;
  if (decimals === 1) return { num: n, style: 5 };
  if (decimals === 2) return { num: n, style: 6 };
  return { num: n, style: !decimals && (m[2].includes(',') || Math.abs(n) >= 10000) ? 2 : 0 };
}

const width = (s) => [...String(s)].reduce((w, c) => w + (/[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(c) ? 2 : 1), 0);

function sheetXml(rows, headerRows = new Set([0])) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(6, ...rows.map((r) => width(r[c] ?? '') + 2))));
  const body = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${colName(ci)}${ri + 1}`;
          if (headerRows.has(ri)) return v === '' ? '' : `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
          const cv = cellValue(v);
          if (cv.formula) return `<c r="${ref}"><f>${esc(cv.formula)}</f></c>`;
          if (cv.num !== undefined) return `<c r="${ref}"${cv.style ? ` s="${cv.style}"` : ''}><v>${cv.num}</v></c>`;
          return cv.text ? `<c r="${ref}" t="inlineStr" s="4"><is><t xml:space="preserve">${esc(cv.text)}</t></is></c>` : '';
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const last = `${colName(cols - 1)}${Math.max(1, rows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0">${rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${body}</sheetData>${rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : ''}
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.0"/><numFmt numFmtId="166" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF0FF"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFD4D4D8"/></left><right style="thin"><color rgb="FFD4D4D8"/></right><top style="thin"><color rgb="FFD4D4D8"/></top><bottom style="thin"><color rgb="FFD4D4D8"/></bottom></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="7">
<xf borderId="1" applyBorder="1"/>
<xf fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="3" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="164" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf borderId="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="165" borderId="1" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="166" borderId="1" applyNumberFormat="1" applyBorder="1"/>
</cellXfs>
</styleSheet>`;

/** sheets: [{name, rows: string[][]}] -> .xlsx bytes */
function buildXlsx(sheets) {
  const used = new Set();
  const named = sheets.map((s, i) => {
    let base = String(s.name || t('시트{n}', { n: i + 1 })).replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || t('시트{n}', { n: i + 1 });
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} ${k}`;
    used.add(name.toLowerCase());
    return { name, rows: s.rows.length ? s.rows : [[t('(빈 표)')]], headerRows: s.headerRows };
  });
  // Excel wants a hidden _FilterDatabase name for every sheet with an autofilter.
  const filters = named
    .map((s, i) => {
      if (s.rows.length < 2) return '';
      const cols = Math.max(1, ...s.rows.map((r) => r.length));
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name).replace(/'/g, "''")}'!$A$1:$${colName(cols - 1)}$${s.rows.length}</definedName>`;
    })
    .join('');
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES,
  };
  named.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows, s.headerRows || new Set([0]))));
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 }));
}

const clean = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/<br\s*\/?>/gi, '\n').trim();

/** "시트1 '광역시 인구면적'" / "Sheet 2: 순위" -> "광역시 인구면적" / "순위" */
function sheetTitle(h) {
  return clean(h)
    .replace(/^(?:시트|sheet)\s*\d*\s*[:.)\-–]?\s*/i, '')
    .replace(/^\d+(?:[.-]\d+)*[.)]?\s+/, '')
    .replace(/^['"“‘「]+|['"”’」]+$/g, '')
    .trim();
}

/**
 * Markdown -> sheets. Every "## heading" with tables under it is one sheet named after the heading;
 * several tables under one heading are stacked with a blank row between (each header bold).
 * Text outside tables (notes, sources, caveats) goes to a final "메모" sheet.
 */
function markdownSheets(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const sheets = [];
  const notes = [];
  let current = null;
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) {
      heading = sheetTitle(h[1]);
      current = null;
      continue;
    }
    if (!/^\|.*\|$/.test(t)) {
      if (t && !/^-{3,}$/.test(t)) notes.push([clean(t.replace(/^[-*•]\s+|^>\s?/, ''))]);
      continue;
    }
    const rows = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
      const cells = lines[i].trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => clean(c.replace(/\\\|/g, '|')));
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      i++;
    }
    i--;
    if (!rows.length) continue;
    if (!current) {
      current = { name: heading || t('표{n}', { n: sheets.length + 1 }), rows: [], headerRows: new Set() };
      sheets.push(current);
    } else current.rows.push([]); // blank row between stacked tables
    current.headerRows.add(current.rows.length);
    current.rows.push(...rows);
  }
  const text = notes.filter((n) => n[0]);
  if (sheets.length && text.length) sheets.push({ name: t('메모'), rows: [[t('메모')], ...text], headerRows: new Set([0]) });
  return sheets;
}

/** CSV (comma, tab or semicolon separated; quoted fields) -> rows. */
function csvRows(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split('\n')[0] || '';
  const sep = first.includes('\t') ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Content the model gave for an .xlsx (Markdown tables, else CSV/TSV) -> .xlsx bytes. */
function toXlsx(content, fallbackName = '시트1') {
  let sheets = markdownSheets(content);
  if (!sheets.length) sheets = [{ name: fallbackName, rows: csvRows(content) }];
  return { buffer: buildXlsx(sheets), sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })) };
}

module.exports = { toXlsx, buildXlsx, markdownSheets, csvRows, cellValue, colName, sheetTitle };
