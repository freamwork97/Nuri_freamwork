const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseJsonObject } = require('../src/workflow/json');
const { validatePlan } = require('../src/workflow/autopilot');
const { markdownToSpec } = require('../src/documents');
const { resolveIn } = require('../src/agent/tools');
const { uniquePath, sanitize } = require('../src/downloads');

test('parseJsonObject: fences, chatter, braces inside strings', () => {
  const obj = parseJsonObject('계획입니다\n```json\n{"title":"a {b}","steps":[{"id":1}]}\n```\n끝 {x}');
  assert.deepStrictEqual(obj, { title: 'a {b}', steps: [{ id: 1 }] });
  assert.throws(() => parseJsonObject('no json'), /JSON/);
  assert.throws(() => parseJsonObject('{"a": "unterminated"'), /완결/);
});

test('validatePlan: unknown tools, document outputs, missing outputs, step cap', () => {
  const plan = validatePlan({
    title: '나라장터 제안서',
    steps: [
      { tool: 'browser', title: '검색', instruction: 'g2b 검색', output: '01_목록.md' },
      { tool: 'hack', title: '이상한 도구', output: 'x/y:z.md' },
      { tool: 'document', title: '제안서', inputs: ['01_목록.md'], output: '03_제안서.md' },
      { tool: 'analyze', title: '분석' },
      { tool: 'ask', title: '질문' },
    ],
  });
  assert.strictEqual(plan.steps.length, 5);
  assert.deepStrictEqual(plan.steps.map((s) => s.id), [1, 2, 3, 4, 5]);
  assert.strictEqual(plan.steps[1].tool, 'browser', 'unknown tool falls back to browser');
  assert.strictEqual(plan.steps[1].output, 'x_y_z.md', 'path separators are stripped');
  assert.strictEqual(plan.steps[2].output, '03_제안서.hwp');
  assert.deepStrictEqual(plan.steps[2].inputs, ['01_목록.md']);
  assert.strictEqual(plan.steps[3].output, '04_analyze.md');
  assert.strictEqual(plan.steps[4].output, '');
  assert.strictEqual(validatePlan({ steps: Array.from({ length: 20 }, () => ({ tool: 'analyze' })) }).steps.length, 10);
  assert.throws(() => validatePlan({ steps: [] }), /단계/);
});

test('markdownToSpec: title, headings, bullets, tables, page breaks', () => {
  const spec = markdownToSpec(`# 제안서 제목
## 1. 사업 개요
본문 **강조** 문장
이어지는 줄

- 항목 하나
- 항목 \`둘\`

| 구분 | 내용 |
|---|:---:|
| 기간 | 6개월 |

---pagebreak---
### 세부
> 인용`);
  assert.strictEqual(spec.title, '제안서 제목');
  assert.deepStrictEqual(spec.blocks.map((b) => b.type), ['heading', 'paragraph', 'bullets', 'table', 'pagebreak', 'heading', 'paragraph']);
  assert.deepStrictEqual(spec.blocks[0], { type: 'heading', level: 1, text: '1. 사업 개요' });
  assert.strictEqual(spec.blocks[1].text, '본문 강조 문장\n이어지는 줄');
  assert.deepStrictEqual(spec.blocks[2].items, ['항목 하나', '항목 둘']);
  assert.deepStrictEqual(spec.blocks[3], { type: 'table', headers: ['구분', '내용'], rows: [['기간', '6개월']] });
  assert.strictEqual(spec.blocks[5].level, 2);
  assert.strictEqual(spec.blocks[6].text, '인용');
});

test('resolveIn: stays inside the work folder', () => {
  const work = path.join(os.tmpdir(), 'anb-work');
  assert.strictEqual(resolveIn(work, '01_목록.md'), path.join(work, '01_목록.md'));
  assert.strictEqual(resolveIn(work, 'sub/a.md'), path.join(work, 'sub', 'a.md'));
  assert.throws(() => resolveIn(work, '../evil.md'), /inside/);
  assert.throws(() => resolveIn(work, '../anb-work2/x.md'), /inside/, 'sibling folder with the same prefix');
  assert.throws(() => resolveIn(work, '.'), /inside/);
  assert.throws(() => resolveIn(work, '/etc/passwd', { forWrite: true }), /work folder/);
  assert.strictEqual(resolveIn(work, 'C:\\Users\\x\\a.pdf'), 'C:\\Users\\x\\a.pdf', 'absolute paths are readable');
  assert.throws(() => resolveIn(work, ''), /required/);
});

test('Downloads: unique, sanitized file names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-dl-'));
  try {
    assert.strictEqual(uniquePath(dir, '공고.pdf'), path.join(dir, '공고.pdf'));
    fs.writeFileSync(path.join(dir, '공고.pdf'), '');
    fs.writeFileSync(path.join(dir, '공고 (1).pdf'), '');
    assert.strictEqual(uniquePath(dir, '공고.pdf'), path.join(dir, '공고 (2).pdf'));
    assert.strictEqual(sanitize('a/b\\c:d*?"<>|e.hwp'), 'a_b_c_d______e.hwp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zip: CP949 names decoded, paths cannot escape the extract folder', () => {
  const { zipSync } = require('fflate');
  const { extractZip, zipName } = require('../src/documents');
  const cp949 = Buffer.from([0xc1, 0xa6, 0xbe, 0xc8, 0xbf, 0xe4, 0xc3, 0xbb, 0xbc, 0xad]).toString('latin1'); // "제안요청서"
  assert.strictEqual(zipName(cp949 + '.hwp'), '제안요청서.hwp');
  assert.strictEqual(zipName('이미 유니코드.pdf'), '이미 유니코드.pdf');
  assert.strictEqual(zipName('plain.txt'), 'plain.txt');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-zip-'));
  try {
    const zip = path.join(dir, 'a.zip');
    fs.writeFileSync(zip, zipSync({ '../../evil.txt': Buffer.from('x'), 'sub/ok.txt': Buffer.from('hello'), 'C:/abs.txt': Buffer.from('y') }));
    const r = extractZip(zip);
    assert.strictEqual(r.dir, path.join(dir, 'a_압축해제'));
    for (const f of r.files) assert.ok(f.startsWith(r.dir + path.sep), f);
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'sub', 'ok.txt'), 'utf8'), 'hello');
    assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('xlsx: Markdown tables become sheets; numbers vs IDs; CSV; readable back', async () => {
  const { toXlsx, cellValue, colName, csvRows } = require('../src/documents/xlsx');
  const { readDocument } = require('../src/documents');
  const { saveResult } = require('../src/workflow/autopilot');
  const { runTool } = require('../src/agent/tools');
  assert.deepStrictEqual([colName(0), colName(25), colName(26), colName(701)], ['A', 'Z', 'AA', 'ZZ']);
  assert.deepStrictEqual(cellValue('235,970,000'), { num: 235970000, style: 2 });
  assert.deepStrictEqual(cellValue('007'), { text: '007' });
  assert.deepStrictEqual(cellValue('R26BK01781814-000'), { text: 'R26BK01781814-000' });
  assert.deepStrictEqual(cellValue('12.5%'), { num: 0.125, style: 3 });
  assert.deepStrictEqual(cellValue('1234567890123456'), { text: '1234567890123456' }, 'beyond Excel precision stays text');
  assert.deepStrictEqual(csvRows('a,"b,c","d ""q"""\n1,2,3\n'), [['a', 'b,c', 'd "q"'], ['1', '2', '3']]);
  assert.deepStrictEqual(csvRows('x\ty\n1\t2'), [['x', 'y'], ['1', '2']]);

  assert.deepStrictEqual(cellValue('1571.0'), { num: 1571, style: 5 });
  assert.deepStrictEqual(cellValue('=SUM(C2:C7)'), { formula: 'SUM(C2:C7)' });
  const { sheetTitle, markdownSheets } = require('../src/documents/xlsx');
  assert.strictEqual(sheetTitle("시트1 '광역시 인구면적'"), '광역시 인구면적');
  assert.strictEqual(sheetTitle('3-1. 값별 출처'), '값별 출처');
  const stacked = markdownSheets('## 시트1 요약\n| a | b |\n|---|---|\n| 1 | 2 |\n\n설명 줄\n\n| c |\n|---|\n| 3 |\n');
  assert.deepStrictEqual(stacked.map((x) => [x.name, x.rows, [...x.headerRows]]), [
    ['요약', [['a', 'b'], ['1', '2'], [], ['c'], ['3']], [0, 3]],
    ['메모', [['메모'], ['설명 줄']], [0]],
  ]);
  const md = '## 공고 목록\n| 공고번호 | 금액(원) |\n|---|---:|\n| R26-1 | 1,000 |\n| 00123 | 2,500 |\n\n## 기타\n| a | b |\n|---|---|\n| <b>x</b> & y | z |\n';
  const r = toXlsx(md);
  assert.deepStrictEqual(r.sheets, [{ name: '공고 목록', rows: 3 }, { name: '기타', rows: 2 }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-xlsx-'));
  try {
    const f = path.join(dir, '결과.xlsx');
    fs.writeFileSync(f, r.buffer);
    const text = await readDocument(f);
    assert.match(text, /공고번호\t금액\(원\)/);
    assert.match(text, /R26-1\t1000/);
    assert.match(text, /00123\t2500/);
    assert.match(text, /<b>x<\/b> & y/, 'special characters survive');
    assert.match(saveResult(path.join(dir, '02_표.xlsx'), md), /엑셀 저장: 02_표\.xlsx \(공고 목록 2행, 기타 1행\)/);
    assert.ok(fs.existsSync(path.join(dir, '02_표.md')), 'markdown copy for later steps');
    assert.strictEqual(saveResult(path.join(dir, 'a.md'), 'x'), '');
    const t = await runTool({ type: 'save_file', name: 'list.xlsx', content: '이름,점수\n김,90\n' }, { workdir: dir });
    assert.match(t.summary, /saved Excel file list\.xlsx \(list: 1 rows\)/);
    const c = await runTool({ type: 'save_file', name: 'list.csv', content: '이름,점수\n' }, { workdir: dir });
    assert.ok(fs.readFileSync(path.join(dir, 'list.csv'), 'utf8').startsWith('﻿'), c.summary);
    assert.match((await runTool({ type: 'save_file', name: 'list.xlsx', content: 'x', append: true }, { workdir: dir })).summary, /FAILED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const { validatePlan } = require('../src/workflow/autopilot');
  const plan = validatePlan({ steps: [{ tool: 'document', output: '보고서.docx' }, { tool: 'analyze', output: '목록.xlsx' }] });
  assert.deepStrictEqual(plan.steps.map((s) => s.output), ['보고서.docx', '목록.xlsx']);
});

test('limitPlan: what the user turned down does not count as asked', () => {
  const { validatePlan, limitPlan } = require('../src/workflow/autopilot');
  const steps = [{ tool: 'browser', title: '확인', instruction: 'x', output: '01_확인.md' }];
  const out = (goal) => limitPlan(validatePlan({ title: 't', steps }), goal).steps[0].output;
  assert.strictEqual(out('첨부 내용을 알려줘. 파일 저장은 하지 마.'), '');
  assert.strictEqual(out('파일 저장하지 말고 알려줘'), '');
  assert.strictEqual(out('보고서 쓰지 말고 표로 정리해'), '01_확인.md');
  assert.strictEqual(out('엑셀로 오늘까지 마감인 공고 뽑아줘'), '01_확인.md'); // "까지 마감" is no refusal
});

test('limitPlan: a document is asked for only with a word for making it', () => {
  const { validatePlan, limitPlan } = require('../src/workflow/autopilot');
  const steps = [{ tool: 'browser', title: '수집', instruction: 'x', output: '01_a.md' }, { tool: 'document', title: '문서', inputs: ['01_a.md'], output: '02_문서.hwp' }];
  const tools = (goal) => limitPlan(validatePlan({ title: 't', steps }), goal).steps.map((s) => s.tool).join();
  for (const goal of ['첨부 문서 제목이랑 분량 알려줘', '이 보고서 요약해줘', 'pdf 읽고 핵심만 말해줘', '이 문서에 뭐라고 나와 있어?']) assert.strictEqual(tools(goal), 'browser', goal);
  for (const goal of ['조사해서 보고서 만들어줘', '제안서 하나 작성해줘', '결과를 pdf로 줘', '한글 파일로 저장', '기획서 초안 부탁해', '문서 형식으로 뽑아줘']) assert.strictEqual(tools(goal), 'browser,document', goal);
});

test('limitPlan keeps only what the goal asked for', () => {
  const { validatePlan, limitPlan } = require('../src/workflow/autopilot');
  const steps = [
    { tool: 'ask', title: '확인', output: '01_요구사항.md' },
    { tool: 'browser', title: '수집', instruction: 'x', output: '02_목록.md' },
    { tool: 'analyze', title: '정리', inputs: ['02_목록.md'], output: '03_결과.md' },
    { tool: 'document', title: '문서', inputs: ['02_목록.md', '03_결과.md'], output: '04_문서.hwp' },
  ];
  const noFile = limitPlan(validatePlan({ title: 't', steps }), '유튜브 채널 프로필 사진 바꿔줘');
  assert.deepStrictEqual(noFile.steps.map((s) => [s.id, s.tool, s.output]), [[1, 'ask', ''], [2, 'browser', '']]);
  const doc = limitPlan(validatePlan({ title: 't', steps }), '조사해서 보고서 만들어줘');
  assert.deepStrictEqual(doc.steps.map((s) => s.output), ['', '02_목록.md', '03_결과.md', '04_문서.hwp']);
  assert.deepStrictEqual(doc.steps[3].inputs, ['02_목록.md', '03_결과.md']);
  const notes = limitPlan(validatePlan({ title: 't', steps }), '탭 열어줘\n\n[이 대화의 이전 작업 — 참고 자료]\n요청: 보고서 만들어줘');
  assert.ok(!notes.steps.some((s) => s.tool === 'document'), 'earlier tasks are not this request');
  const only = limitPlan(validatePlan({ title: 't', steps: [{ tool: 'document', output: 'a.hwp' }] }), '탭 열어줘');
  assert.deepStrictEqual(only.steps.map((s) => [s.tool, s.instruction, s.output]), [['browser', '탭 열어줘', '']]);
});
