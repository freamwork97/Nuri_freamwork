// Result text from the AI, shown with its Markdown tables as real tables and **bold** as bold.
// Everything is built as DOM nodes with textContent: the text never becomes HTML.
(function (root) {
  const ROW = /^\s*\|.*\|\s*$/;
  const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  /** Splits text into blocks: { type: 'text', text } and { type: 'table', head, rows }. */
  function parse(text) {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let buf = [];
    const flush = () => {
      if (buf.length) blocks.push({ type: 'text', text: buf.join('\n') });
      buf = [];
    };
    for (let i = 0; i < lines.length; i++) {
      if (ROW.test(lines[i]) && SEPARATOR.test(lines[i + 1] || '')) {
        const head = cells(lines[i]);
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && ROW.test(lines[j]); j++) rows.push(cells(lines[j]));
        flush();
        blocks.push({ type: 'table', head, rows });
        i = j - 1;
      } else buf.push(lines[i]);
    }
    flush();
    // No blank edges around tables.
    for (const b of blocks) if (b.type === 'text') b.text = b.text.replace(/^\n+|\n+$/g, '');
    return blocks.filter((b) => b.type === 'table' || b.text);
  }

  /** Appends `text` with **bold** runs to `parent`. */
  function inline(parent, text) {
    String(text).split(/(\*\*[^*\n]+\*\*)/g).forEach((part) => {
      if (/^\*\*[^*\n]+\*\*$/.test(part)) {
        const b = document.createElement('strong');
        b.textContent = part.slice(2, -2);
        parent.append(b);
      } else if (part) parent.append(document.createTextNode(part));
    });
  }

  /** A node showing the text with tables and bold. */
  function render(text) {
    const box = document.createElement('div');
    box.className = 'rich';
    for (const b of parse(text)) {
      if (b.type === 'text') {
        const p = document.createElement('div');
        p.className = 'rich-text';
        inline(p, b.text);
        box.append(p);
        continue;
      }
      const wrap = document.createElement('div');
      wrap.className = 'rich-table';
      const table = document.createElement('table');
      const tr = document.createElement('tr');
      for (const h of b.head) {
        const th = document.createElement('th');
        inline(th, h);
        tr.append(th);
      }
      const thead = document.createElement('thead');
      thead.append(tr);
      const tbody = document.createElement('tbody');
      for (const r of b.rows) {
        const row = document.createElement('tr');
        for (let k = 0; k < b.head.length; k++) {
          const td = document.createElement('td');
          inline(td, r[k] ?? '');
          row.append(td);
        }
        tbody.append(row);
      }
      table.append(thead, tbody);
      wrap.append(table);
      box.append(wrap);
    }
    return box;
  }

  const api = { parse, render };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NURI_RICH = api;
})(typeof self !== 'undefined' ? self : this);
