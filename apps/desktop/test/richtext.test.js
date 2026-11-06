const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('../ui/js/richtext');

test('markdown tables become table blocks, the rest stays text', () => {
  const b = parse('Top 3:\n\n| # | Title | Points |\n|---|---|---:|\n| 1 | A | 34 |\n| 2 | B \\| x | 10 |\n\nNote: live data.');
  assert.deepStrictEqual(b.map((x) => x.type), ['text', 'table', 'text']);
  assert.strictEqual(b[0].text, 'Top 3:');
  assert.deepStrictEqual(b[1].head, ['#', 'Title', 'Points']);
  assert.strictEqual(b[1].rows.length, 2);
  assert.strictEqual(b[2].text, 'Note: live data.');
});

test('a line with pipes but no separator row is plain text', () => {
  const b = parse('a | b | c\n| not a table |');
  assert.deepStrictEqual(b.map((x) => x.type), ['text']);
});
