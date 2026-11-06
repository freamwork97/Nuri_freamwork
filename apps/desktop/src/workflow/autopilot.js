// Autopilot: plans a long, multi-tool task and runs it step by step.
//   browser  - the browser agent (search, read tables, download, fill forms, upload)
//   desktop  - the computer-use agent (any Windows program)
//   analyze  - an AI analyst over the collected files (filter, rank, extract requirements)
//   document - a complete Korean document written as Hangul .hwp + .pdf
//   ask      - a question to the user
// Every step reads/writes files in one project folder. Everything the user knows (company facts,
// keywords, preferences) comes from the goal text itself.

const fs = require('node:fs');
const path = require('node:path');
const { parseJsonObject } = require('./json');
const { t, forAi } = require('../i18n');
const { createProject, writeJson, appendLog, listProjectFiles } = require('./project');
const { readDocument, writeHwp } = require('../documents');
const { toXlsx } = require('../documents/xlsx');

const TOOLS = new Set(['browser', 'desktop', 'analyze', 'document', 'ask']);
const MAX_PLAN_STEPS = 10;

const PLANNER_SYSTEM = `You are the planner of a desktop automation app. Break the user's GOAL into a short plan of steps run by these tools:
- "browser": an autonomous agent driving the app's built-in Chrome inside the user's logged-in sessions. It searches sites, reads every row/column of result tables (read_page), opens detail pages, downloads attachments (saved automatically), reads PDF/HWP/DOCX files, fills forms, uploads files, and saves collected data to files with save_file.
- "desktop": an autonomous agent operating any Windows program with mouse and keyboard (Excel, the Hangul word processor GUI, file dialogs, other apps). It can read all text of a window exactly (tables, documents) and fill Open/Save file dialogs with a path. Use it only when a non-browser program is really needed (e.g. "save the list as an Excel file", "attach a file in a desktop app").
- "analyze": an AI analyst without tools: reads the input files plus the GOAL and writes ONE result file (filter, score, rank, compare, extract requirements, summarize, build tables). If its output ends with .xlsx the tables become a real Excel file (one sheet per table).
- "document": writes a complete, polished {LANG} document (proposal, report, letter, plan) and saves it as Hangul .hwp (or Word .docx when the goal asks for Word) plus .pdf. The instruction gives the purpose, outline and requirements; inputs give the facts.
- "ask": asks the user one question — only when the task truly cannot continue without it. Otherwise decide yourself and go on.

Rules:
- Do exactly what the GOAL asks and nothing else. Use the fewest steps that finish it: 1 step is normal, 8 is the limit. No preparation, requirement, checking, summary or report steps of your own.
- A question about earlier work ("어디까지 됐어?", "왜 안 돼?"), or a small request ("탭 열어줘"): one browser step that looks or acts and answers. Use the earlier conversation given with the GOAL.
- Each "instruction" must be self-contained and concrete: which site/URL, search terms derived from the GOAL (keywords, categories, region, budget the user gave), filters and dates, what to extract (columns, IDs, links, deadlines), how many items, where to stop.
- Make files only when the GOAL asks for a file or document. "analyze" and "document" steps are for that case; never add them on your own. Leave "output" empty for steps whose result is an action on a website or an answer. A step that a later step really depends on names an "output", and the later step lists it in "inputs".
- Research steps with an output save results as a markdown table that includes identifiers and links later steps need (e.g. 공고번호, 상세 URL, 마감일시, 첨부파일 경로).
- A "document" step's output must end with .hwp (or .docx for Word). Put facts it needs (selected item, requirements, user-given facts) in its inputs.
- Files are produced WITHOUT operating programs: Excel lists/tables = an "analyze" step with an .xlsx output (or a browser step saving .xlsx); Hangul/Word/PDF documents = "document" steps. Never plan a "desktop" step just to create, fill or save an Excel/Word/Hangul file; use "desktop" only to operate a program the goal is really about (e.g. a desktop app with no web version).
- Final irreversible actions (bid submission, payment, sending, publishing, uploading to an official system) only if the GOAL explicitly asks for them, as the last step; the instruction must say to stop right before the final submit button if anything is unclear. The app asks the user to approve the final click.
- Certificate logins (공동인증서/금융인증서) or passwords: the browser step asks the user to log in; mention that in its instruction.
- Research steps search with Google, not Naver. Naver is only a second source for Korean places and local information, unless the goal names it.
- Sites with Google sign-in: the user is already signed in to Google. Instruct the step to sign up or log in with Google by itself; never plan a step that waits for the user to log in there.
- Write titles in {LANG}. Reply with ONE JSON object only:
{"title":"<short {LANG} title>","steps":[{"id":1,"tool":"browser","title":"<short {LANG}>","instruction":"<detailed>","inputs":[],"output":"01_x.md"}]}`;

const ANALYST_SYSTEM = `You are a meticulous business analyst. Use only the given inputs and the facts in the goal; never invent facts.
Write the result in {LANG} Markdown (tables where useful). When you score or select, explain the criteria and the reasons briefly. Mark anything uncertain as "(확인 필요)".
Return only the document content.`;

const WRITER_SYSTEM = `You are an expert proposal and report writer, including Korean public-sector (공공기관/나라장터) work.
Write the COMPLETE document in {LANG} Markdown, ready to submit: "# " once for the document title, "## " for chapters, "### " for sections, "- " bullets, "| a | b |" tables (with a header row). Use a formal, concise 개조식 style with concrete numbers, schedules and staffing where the inputs support them.
Use company/author facts stated in the GOAL or inputs (no placeholders like [회사명]). Where required information is genuinely missing, write "(확인 필요: …)" instead of inventing it.
Follow the requested outline and any evaluation criteria / requirements found in the inputs (e.g. 제안요청서 목차, 평가항목). Return only the Markdown document.`;

/** Writes a step result; .xlsx outputs become real Excel files (plus a .md copy for later steps). */
function saveResult(file, text) {
  if (!/\.xlsx$/i.test(file)) {
    fs.writeFileSync(file, text, 'utf8');
    return '';
  }
  const { buffer, sheets } = toXlsx(text, path.basename(file, '.xlsx'));
  fs.writeFileSync(file, buffer);
  fs.writeFileSync(file.replace(/\.xlsx$/i, '.md'), text, 'utf8');
  return t('엑셀 저장: {name} ({sheets})', { name: path.basename(file), sheets: sheets.map((s) => t('{sheet} {n}행', { sheet: s.name, n: Math.max(0, s.rows - 1) })).join(', ') });
}

/** Extra instruction for analyze steps whose output becomes an Excel file. */
const XLSX_FORMAT = (name) => `

OUTPUT FORMAT: your reply IS the Excel file ${name} (converted automatically). Write the DATA itself, not a description or plan of the file, and no tables that explain formulas or cells.
- Each sheet = a "## <sheet name>" heading (just the name, e.g. "## 인구면적") followed by its table(s): a header row, one record per row, every row complete.
- Numeric columns hold plain numbers; put units like (원), (km²) in the header. Keep IDs/codes exactly as found.
- Totals/averages may be extra rows. Excel formulas such as =SUM(C2:C7) are allowed in cells (row 1 is the header).
- Sources and caveats: short bullet lines after the tables (they go to a 메모 sheet).`;

// What the user's own words ask for (the app's notes after them don't count).
// A document named without a word for making one ("문서 제목 알려줘") is something to read.
const WANTS_DOCUMENT = /(?:문서|보고서|제안서|기획서|계획서|리포트|hwp|한글\s*파일|워드|docx|pdf)(?:\s*(?:로|형식|형태)|\S*\s*(?:\S+\s+){0,2}?\S*(?:만들|작성|써|쓰|제작|뽑|저장|내보내|출력|생성|변환|부탁|필요))/i;
const WANTS_FILE = /파일로|파일\s*(만들|저장)|엑셀|xlsx|csv|저장해|정리해|표로|목록으로/i;
// "파일 저장은 하지 마", "보고서 쓰지 말고": what the user turned down is not a request.
const TURNED_DOWN = /(?:\S+\s+){0,2}\S*(?:지\s*마(?=세요|라|[\s.,!]|$)|지\s*말(?=고|아|것|라)|금지)\S*/g;

/** Drops what the plan added on its own: unrequested document/analysis steps and side files. */
function limitPlan(plan, goal) {
  const asked = String(goal).split('\n\n[')[0];
  const wanted = asked.replace(TURNED_DOWN, ' ');
  const wantsDoc = WANTS_DOCUMENT.test(wanted);
  const wantsFile = wantsDoc || WANTS_FILE.test(wanted);
  const kept = plan.steps.filter((s) => (s.tool === 'document' ? wantsDoc : s.tool !== 'analyze' || wantsFile));
  const steps = kept.length ? kept : [{ id: 1, tool: 'browser', title: plan.title, instruction: asked, inputs: [], output: '' }];
  const outputs = new Set(steps.map((s) => s.output));
  return {
    ...plan,
    steps: steps.map((s, i) => {
      const later = steps.slice(i + 1).some((n) => n.inputs.includes(s.output));
      const deliverable = i === steps.length - 1 && wantsFile;
      const makesFile = s.tool === 'document' || s.tool === 'analyze';
      return { ...s, id: i + 1, inputs: s.inputs.filter((f) => outputs.has(f)), output: later || deliverable || makesFile ? s.output : '' };
    }),
  };
}

function validatePlan(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps.slice(0, MAX_PLAN_STEPS) : [];
  if (!steps.length) throw new Error(t('계획에 단계가 없습니다'));
  return {
    title: String(plan.title || '').slice(0, 80) || t('자동 작업'),
    steps: steps.map((s, i) => {
      const tool = TOOLS.has(s.tool) ? s.tool : 'browser';
      let output = String(s.output || '').trim().replace(/[\\/:*?"<>|]/g, '_');
      if (tool === 'document' && !/\.(hwpx?|docx)$/i.test(output)) output = (output.replace(/\.\w+$/, '') || `${String(i + 1).padStart(2, '0')}_문서`) + '.hwp';
      if (!output && tool !== 'ask') output = `${String(i + 1).padStart(2, '0')}_${tool}.md`;
      return {
        id: i + 1,
        tool,
        title: String(s.title || t('{n}단계', { n: i + 1 })).slice(0, 60),
        instruction: String(s.instruction || s.title || '').slice(0, 4000),
        inputs: (Array.isArray(s.inputs) ? s.inputs : []).map(String).slice(0, 8),
        output,
      };
    }),
  };
}

// Added to the planner prompt for 예약 작업 runs.
const UNATTENDED_NOTE = 'UNATTENDED RUN (scheduled task): the user is away. Do not plan "ask" steps; make reasonable choices yourself and state the assumptions in the outputs. If the GOAL mentions a previous run, compare against its result files (give their absolute paths as inputs) so the outputs can mark what is new.';

class Autopilot {
  /** @param {import('../agent/agent').Agent} agent */
  constructor(agent) {
    this.agent = agent;
  }

  async oneShot({ provider, quality, system, prompt }) {
    // A fresh session per call: long prompts travel over stdin (CLI arguments are size-limited).
    const sessionId = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      return await this.agent.llm({ provider, quality, sessionId, system, prompt });
    } finally {
      this.agent.server.request('/v1/llm/session/close', { method: 'POST', body: { sessionId } }).catch(() => {});
    }
  }

  async plan(goal, provider) {
    const canDraw = provider === 'gpt' ? '\n\nImages: browser steps can generate original images themselves (generate_image). Tell them to do that instead of using image sites.' : '';
    const prompt = `GOAL: ${goal}\n\nToday: ${new Date().toLocaleDateString('ko-KR')}${canDraw}${this.agent.unattended ? `\n\n${UNATTENDED_NOTE}` : ''}`;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.oneShot({ provider, quality: 'accurate', system: forAi(PLANNER_SYSTEM), prompt: attempt ? `${prompt}\n\nYour previous reply was invalid (${lastError}). Reply with the JSON object only.` : prompt });
      try {
        return limitPlan(validatePlan(parseJsonObject(raw)), goal);
      } catch (e) {
        lastError = e.message;
      }
    }
    throw new Error(t('계획을 세우지 못했습니다: {error}', { error: lastError }));
  }

  /** Inputs as text for analysts/writers (documents converted to text). */
  async inputsText(project, names, maxEach = 25_000) {
    const parts = [];
    for (const name of names) {
      const file = path.isAbsolute(name) ? name : path.join(project.dir, name);
      if (!fs.existsSync(file)) {
        parts.push(`## 입력 파일: ${name}\n(파일 없음)`);
        continue;
      }
      try {
        parts.push(`## 입력 파일: ${name}\n${await readDocument(file, { maxChars: maxEach })}`);
      } catch (e) {
        parts.push(`## 입력 파일: ${name}\n(읽기 실패: ${e.message})`);
      }
    }
    return parts.join('\n\n');
  }

  agentGoal(project, plan, step, inputs) {
    const inputList = step.inputs.length ? step.inputs.map((n) => `- ${n}`).join('\n') : '(none)';
    return forAi(`[AUTOPILOT STEP ${step.id}/${plan.steps.length}] ${step.title}
OVERALL GOAL: ${project.goal}
THIS STEP (do only this): ${step.instruction}

INPUT FILES in the work folder (read_file for full details):
${inputList}
${inputs ? `\nINPUT EXCERPTS:\n${inputs.slice(0, 6000)}\n` : ''}
${step.output ? `OUTPUT: before done, save this step's result with {"type":"save_file","name":"${step.output}","content":"..."} (markdown; include IDs/links later steps need).` : ''}
Your done answer must summarize what was found/done in {LANG}.`);
  }

  async runStep(project, plan, step, { provider, quality }) {
    const agent = this.agent;
    switch (step.tool) {
      case 'browser':
      case 'desktop': {
        const inputs = step.inputs.length ? await this.inputsText(project, step.inputs, 3000) : '';
        const goal = this.agentGoal(project, plan, step, inputs);
        const answer = step.tool === 'browser'
          ? await agent.browserLoop(goal, provider, { quality, maxSteps: Math.max(60, agent.settings?.get('automation.browserMaxSteps') || 0) })
          : await agent.desktopLoop(goal, provider, { quality, maxSteps: Math.max(60, agent.settings?.get('automation.desktopMaxSteps') || 0) });
        if (answer === null) return null;
        const out = path.join(project.dir, step.output);
        if (step.output && !fs.existsSync(out)) saveResult(out, `# ${step.title}\n\n${answer}\n`);
        return answer;
      }
      case 'analyze': {
        agent.emitEvent('status', { text: t('{title} — 분석 중…', { title: step.title }) });
        const inputs = await this.inputsText(project, step.inputs);
        const text = await this.oneShot({
          provider,
          quality: 'accurate',
          system: forAi(ANALYST_SYSTEM),
          prompt: `TASK: ${step.instruction}\n\nOVERALL GOAL: ${project.goal}${/\.xlsx$/i.test(step.output) ? XLSX_FORMAT(step.output) : ''}\n\nINPUTS:\n${inputs || t('(없음)')}`,
        });
        const saved = saveResult(path.join(project.dir, step.output), text.trim() + '\n');
        return (saved ? `${saved}\n\n` : '') + text.slice(0, 1500);
      }
      case 'document': {
        agent.emitEvent('status', { text: t('{title} — 문서 작성 중… (1~3분)', { title: step.title }) });
        const inputs = await this.inputsText(project, step.inputs, 30_000);
        const md = (await this.oneShot({
          provider,
          quality: 'accurate',
          system: forAi(WRITER_SYSTEM),
          prompt: `DOCUMENT TO WRITE: ${step.instruction}\n\nOVERALL GOAL: ${project.goal}\n\nINPUTS:\n${inputs || t('(없음)')}\n\nToday: ${new Date().toISOString().slice(0, 10)}`,
        })).replace(/^```(?:markdown|md)?\s*|\s*```\s*$/g, '');
        if (!md.trim()) throw new Error(t('문서 내용이 비어 있습니다'));
        const base = step.output.replace(/\.(hwpx?|docx)$/i, '');
        fs.writeFileSync(path.join(project.dir, `${base}.md`), md, 'utf8');
        agent.emitEvent('status', { text: t('{title} — 문서 파일로 저장 중…', { title: step.title }) });
        const r = await writeHwp(md, path.join(project.dir, step.output), { pdfPath: path.join(project.dir, `${base}.pdf`) });
        return t('{kind} 문서 작성 완료: {name} ({pages}쪽, 표 {tables}개)', { kind: /\.docx$/i.test(step.output) ? t('워드') : t('한글'), name: step.output, pages: r.pages, tables: r.tables }) + (r.pdf ? `, PDF: ${base}.pdf` : '');
      }
      case 'ask': {
        const ans = await agent.askUser(step.instruction);
        if (ans === null) return null;
        if (step.output) fs.writeFileSync(path.join(project.dir, step.output), `${t('질문')}: ${step.instruction}\n${t('답변')}: ${ans}\n`, 'utf8');
        return t('사용자 답변: {answer}', { answer: ans });
      }
      default:
        throw new Error(t('알 수 없는 도구 {tool}', { tool: step.tool }));
    }
  }

  async run(goal, provider = 'claude', { quality = 'fast' } = {}) {
    const agent = this.agent;
    if (!agent.begin('autopilot', { goal, provider })) return;
    const saved = { workdir: agent.workdir, downloads: agent.downloads?.targetDir ?? null };
    let project;
    try {
      project = createProject(goal);
      agent.workdir = project.dir;
      if (agent.downloads) agent.downloads.targetDir = path.join(project.dir, 'downloads');
      agent.log('autopilot', provider, agent.unattended ? '(예약 작업)' : goal, project.dir);

      agent.emitEvent('status', { text: t('작업 계획을 세우는 중…') });
      const plan = await this.plan(goal, provider);
      writeJson(project, 'plan.json', plan);
      appendLog(project, `## 계획: ${plan.title}\n${plan.steps.map((s) => `${s.id}. [${s.tool}] ${s.title} → ${s.output || '-'}`).join('\n')}`);
      agent.emitEvent('plan', { title: plan.title, dir: project.dir, steps: plan.steps.map(({ id, tool, title, output }) => ({ id, tool, title, output })) });

      const results = [];
      for (let i = 0; i < plan.steps.length && !agent.stopped; i++) {
        const step = plan.steps[i];
        agent.emitEvent('plan_step', { index: i, status: 'running' });
        let answer;
        let skipped = false;
        for (let attempt = 1; ; attempt++) {
          try {
            answer = await this.runStep(project, plan, step, { provider, quality });
            break;
          } catch (e) {
            if (agent.stopped) break;
            agent.log('autopilot step failed', step.id, e.message);
            // 설정 > 자동화 > 오토파일럿 실패 시: retry once automatically, then skip.
            // Unattended (예약 작업): nobody is there to choose, so the same.
            if (agent.unattended || agent.settings?.get('automation.autopilotOnFail') === 'retry-skip') {
              if (attempt < 2) {
                agent.emitEvent('note', { text: t('{n}단계 실패, 자동으로 다시 시도합니다: {error}', { n: step.id, error: String(e.message).slice(0, 160) }) });
                continue;
              }
              answer = t('(건너뜀: {error})', { error: e.message });
              skipped = true;
              break;
            }
            const choice = await agent.askUser(t('{n}단계 "{title}"가 실패했습니다: {error}\n\n"재시도", "건너뛰기", "중지" 중 하나로 답해 주세요.', { n: step.id, title: step.title, error: e.message }));
            if (choice === null || /중지|stop/i.test(choice)) {
              agent.stopped = true;
              break;
            }
            if (/건너|skip/i.test(choice) || attempt >= 3) {
              answer = t('(건너뜀: {error})', { error: e.message });
              skipped = true;
              break;
            }
          }
        }
        if (agent.stopped || answer === null || answer === undefined) break;
        results.push({ step, answer });
        appendLog(project, `### ${step.id}. ${step.title}\n${answer}`);
        agent.emitEvent('plan_step', { index: i, status: skipped ? 'skipped' : 'done', summary: String(answer).slice(0, 600), output: step.output });
      }

      if (agent.stopped) {
        agent.emitEvent('stopped', {});
        return;
      }
      const files = listProjectFiles(project).slice(0, 30);
      const summary = results.map(({ step, answer }) => `${step.id}. ${step.title}: ${String(answer).split('\n')[0].slice(0, 200)}`).join('\n');
      agent.emitEvent('done', { answer: results.length === 1 ? String(results[0].answer) : `${t('{title} 완료', { title: plan.title })}\n\n${summary}`, dir: files.length ? project.dir : undefined, files: files.map((f) => ({ name: f.rel, path: f.full })) });
    } catch (e) {
      if (agent.stopped) agent.emitEvent('stopped', {});
      else {
        agent.log('autopilot error', e.message);
        agent.emitEvent('error', { message: e.message });
      }
    } finally {
      agent.workdir = saved.workdir;
      if (agent.downloads) agent.downloads.targetDir = saved.downloads;
      agent.finish();
    }
  }
}

module.exports = { Autopilot, validatePlan, limitPlan, saveResult, PLANNER_SYSTEM };
