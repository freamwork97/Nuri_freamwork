// Compacts Playwright's AI aria snapshot (mode: 'ai', boxes: true) for the LLM.
// A raw snapshot of a portal page is ~85KB; we keep only what is near the viewport,
// drop structural noise and long URLs, and re-indent. Pure function: unit-testable.

const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'slider', 'spinbutton', 'treeitem',
]);
const NOISE_ROLES = new Set(['generic', 'none', 'presentation']);
const TABLE_ROLES = new Set(['table', 'grid', 'treegrid', 'rowgroup', 'row']);

const BOX_RE = /\s*\[box=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)\]/;
const REF_RE = /\[ref=([a-z0-9]+)\]/i;

function shortenUrl(url) {
  const u = url.replace(/^"|"$/g, '');
  if (u.length <= 80) return u;
  try {
    const parsed = new URL(u);
    return (parsed.origin + parsed.pathname).slice(0, 80) + (parsed.search ? '?…' : '');
  } catch {
    return u.slice(0, 80) + '…';
  }
}

function truncateQuoted(s) {
  return s.replace(/"([^"]{90,})"/g, (_m, inner) => `"${inner.slice(0, 80)}…"`);
}

/**
 * @param {string} raw      snapshot from page.ariaSnapshot({ mode: 'ai', boxes: true })
 * @param {{width:number,height:number}} viewport
 * @param {{maxChars?:number, screens?:number, maxOffscreen?:number}} opts
 * @returns {{ text:string, refs:Map<string,{role:string,name:string,box:object|null}>, visibleRefs:Array, truncated:number,
 *            offscreen:Array<{ref:string,role:string,name:string,where:'above'|'below'|'side'}> }}
 *
 * Visibility is judged per node from its OWN box. A container's box says nothing reliable about
 * its children (fixed headers, scrolled inner panes, transforms): sites like 나라장터 report the
 * root container far above the viewport while everything inside is on screen.
 */
function compactSnapshot(raw, viewport, opts = {}) {
  const maxChars = opts.maxChars ?? 12000;
  const screens = opts.screens ?? 2;
  const vh = viewport.height || 800;
  const vw = viewport.width || 1200;
  const bottom = screens * vh;

  // ---- pass 1: parse into nodes with absolute boxes ----
  const nodes = [];
  const stack = []; // indices of open ancestors
  for (const line of String(raw || '').split('\n')) {
    const m = /^(\s*)- (.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && nodes[stack[stack.length - 1]].indent >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : -1;
    let body = m[2];
    // iframe children report frame-relative boxes: add the offsets of enclosing iframes.
    let offX = 0;
    let offY = 0;
    for (const i of stack) {
      if (nodes[i].frame) {
        offX += nodes[i].box.x;
        offY += nodes[i].box.y;
      }
    }
    const bm = BOX_RE.exec(body);
    const box = bm ? { x: +bm[1] + offX, y: +bm[2] + offY, width: +bm[3], height: +bm[4] } : null;
    if (bm) body = body.replace(BOX_RE, '');
    const role = (/^([a-z]+)/i.exec(body) || [])[1] || '';
    const refMatch = REF_RE.exec(body);
    const nameMatch = /^[a-z]+ "([^"]*)"/i.exec(body);
    const node = {
      indent, parent, body, box, role,
      ref: refMatch ? refMatch[1] : null,
      name: nameMatch ? nameMatch[1] : '',
      frame: role === 'iframe' && !!box,
      pointer: /\[cursor=pointer\]/.test(body),
      hidden: !!box && (box.width <= 0 || box.height <= 0),
      visible: false,
      keep: false,
      depth: 0,
    };
    // Cells of data tables/grids count by their row's vertical position only: wide grids scroll
    // horizontally, and the agent needs every column (e.g. 공고명 scrolled out to the left).
    node.inTable = TABLE_ROLES.has(role) || (parent >= 0 && nodes[parent].inTable);
    const vertical = !!box && box.y + box.height > 0 && box.y <= bottom;
    const horizontal = !!box && box.x <= vw && box.x + box.width >= 0;
    node.visible = !!box && !node.hidden && vertical && (horizontal || node.inTable);
    nodes.push(node);
    if (/:\s*$/.test(body)) stack.push(nodes.length - 1);
  }

  // ---- pass 2: a node is kept if it is visible itself or has a visible descendant ----
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.visible) n.keep = true;
    if (n.keep && n.parent >= 0) nodes[n.parent].keep = true;
  }
  // Box-less lines (/url:, text:) belong to their parent: shown only when the parent itself is visible.
  for (const n of nodes) {
    if (!n.box && n.parent >= 0) n.keep = nodes[n.parent].visible || (nodes[n.parent].keep && !nodes[n.parent].box);
    else if (!n.box && n.parent < 0) n.keep = true;
  }

  // ---- pass 3: emit ----
  const out = [];
  let size = 0;
  let truncated = 0;
  const refs = new Map();
  const visibleRefs = [];
  const offscreen = [];
  const offscreenSeen = new Set();
  const noteOffscreen = (n, forceWhere) => {
    if (!n.ref || !n.name || !INTERACTIVE_ROLES.has(n.role) || !n.box || n.hidden) return;
    const key = `${n.role}|${n.name}`;
    if (offscreenSeen.has(key)) return;
    offscreenSeen.add(key);
    const where = forceWhere || (n.box.y + n.box.height <= 0 ? 'above' : n.box.y > bottom ? 'below' : 'side');
    offscreen.push({ ref: n.ref, role: n.role, name: n.name.slice(0, 50), where });
  };

  let skipUntil = -1;
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    if (n.ref) {
      refs.set(n.ref, { role: n.role, name: n.name, box: n.box });
      const interactive = INTERACTIVE_ROLES.has(n.role) || n.pointer;
      if (interactive && n.box && !n.hidden && n.box.y >= 0 && n.box.y < vh && n.box.x >= 0 && n.box.x < vw) {
        visibleRefs.push({ ref: n.ref, role: n.role, name: n.name, box: n.box });
      }
    }
    const parentDepth = n.parent >= 0 ? nodes[n.parent].childDepth ?? 0 : 0;
    n.childDepth = parentDepth;
    if (idx <= skipUntil) continue; // folded into a table row line
    if (!n.keep) {
      if (n.box && !n.hidden && !n.visible) noteOffscreen(n);
      continue;
    }

    // Structural noise: unnamed generic containers without inline text.
    let body = n.body;
    const inlineText = /:\s+\S/.test(body.replace(/^[^:]*\[[^\]]*\]/, ''));
    if (NOISE_ROLES.has(n.role) && !n.name && !inlineText) continue;
    // Wrapper kept only for its visible children, but itself off-screen and unnamed: skip the line.
    if (!n.visible && n.box && !n.name && !inlineText && !n.ref) continue;

    // Table rows become one line: "row [ref]: cell | cell | link "투찰" [ref=e9]" (much denser).
    if (n.role === 'row' && n.visible) {
      const folded = foldRow(nodes, idx);
      if (folded) {
        body = folded.line;
        skipUntil = folded.end;
      }
    }

    body = body.replace(/\s*\[cursor=pointer\]/g, '');
    if (body.startsWith('/url:')) body = '/url: ' + shortenUrl(body.slice(5).trim());
    if (n.role !== 'row') body = truncateQuoted(body);
    const limit = n.role === 'row' ? 600 : 160;
    if (body.length > limit) body = body.slice(0, limit - 10) + '…';

    const outLine = '  '.repeat(parentDepth) + '- ' + body;
    if (size + outLine.length > maxChars) {
      truncated++;
      noteOffscreen(n, 'below');
      continue;
    }
    out.push(outLine);
    size += outLine.length + 1;
    n.childDepth = parentDepth + 1;
  }

  return { text: out.join('\n'), refs, visibleRefs, truncated, offscreen: pickOffscreen(offscreen, opts.maxOffscreen ?? 80) };
}

/** Folds a table row and its cells into one line; returns null for rows with complex content. */
function foldRow(nodes, rowIdx) {
  const row = nodes[rowIdx];
  let end = rowIdx;
  while (end + 1 < nodes.length && nodes[end + 1].indent > row.indent) end++;
  if (end - rowIdx > 80) return null;
  const cells = [];
  for (let i = rowIdx + 1; i <= end; i++) {
    const c = nodes[i];
    if (c.parent !== rowIdx) continue;
    if (!/^(cell|gridcell|rowheader|columnheader)$/.test(c.role)) return null;
    const parts = [];
    if (c.name) parts.push(c.name);
    for (let j = i + 1; j <= end && nodes[j].indent > c.indent; j++) {
      const d = nodes[j];
      if (d.ref && (INTERACTIVE_ROLES.has(d.role) || d.pointer) && d.name) parts.push(`${d.role} "${d.name.slice(0, 40)}" [ref=${d.ref}]`);
      else if (!c.name) {
        const t = /:\s+(.+)$/.exec(d.body.replace(/\[[^\]]*\]/g, ''));
        if (t && !d.body.startsWith('/url:')) parts.push(t[1].replace(/^"|"$/g, ''));
      }
    }
    cells.push(parts.join(' ').trim() || '·');
  }
  if (!cells.length) return null;
  return { line: `row [ref=${row.ref}]: ${cells.join(' | ')}`, end };
}

/**
 * Long pages have hundreds of off-screen links (article text) that would crowd out what matters.
 * Keep controls (buttons, fields, tabs...) first, then links from the start and the end of the
 * page (navigation and footer), in document order.
 */
function pickOffscreen(list, max) {
  if (list.length <= max) return list;
  const controls = list.filter((o) => o.role !== 'link');
  const links = list.filter((o) => o.role === 'link');
  const roomForLinks = Math.max(20, max - Math.min(controls.length, max - 20));
  const head = Math.floor(roomForLinks * 0.4);
  const keep = new Set([...controls.slice(0, max - roomForLinks), ...links.slice(0, head), ...links.slice(links.length - (roomForLinks - head))]);
  return list.filter((o) => keep.has(o));
}

module.exports = { compactSnapshot, shortenUrl, INTERACTIVE_ROLES };
