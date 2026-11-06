// 하위 에이전트: the browser agent hands independent research tasks to sub-agents that run at the
// same time, each in its own background tab with its own AI session ({"type":"parallel"}).
// Sub-agents only read and collect: they never ask the user, never open/switch tabs, and every
// action that would need the user's approval (pay, publish, send, delete, platform skills) is
// refused, so they cannot do anything the main agent could not be asked about.
// Pure helpers here (unit-tested); the loop itself is Agent.runParallel (agent.js).

const SUB_MAX_STEPS = 25;
const MAX_GOAL = 2000;

// Actions a sub-agent may not use (tab control belongs to the main agent and the user; nesting and
// questions would need the user's attention while several things run).
const SUB_FORBIDDEN = new Set(['new_tab', 'switch_tab', 'close_tab', 'ask_user', 'delegate', 'parallel', 'generate_image']);

/**
 * Validates a parallel action. Returns { tasks } (title, goal, url) or { error } for the model.
 * @param {number} max the setting automation.subagents (0 = off)
 */
function normalizeTasks(action, max) {
  if (!max) return { error: 'sub-agents are turned off in the settings (설정 > 자동화 > 하위 에이전트): do the tasks yourself one by one' };
  const raw = Array.isArray(action?.tasks) ? action.tasks : [];
  const tasks = raw
    .map((t, i) => {
      const goal = String((typeof t === 'string' ? t : t?.goal) || '').trim().slice(0, MAX_GOAL);
      const title = String((typeof t === 'object' && t?.title) || `작업 ${i + 1}`).trim().slice(0, 40);
      let url = typeof t === 'object' && t?.url ? String(t.url).trim() : '';
      if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
      if (url && !/^https?:\/\//i.test(url)) url = '';
      return { title, goal, url };
    })
    .filter((t) => t.goal);
  if (tasks.length < 2) return { error: 'parallel needs at least 2 independent tasks, each with a "goal"; for one task just do it yourself' };
  if (tasks.length > max) return { error: `at most ${max} sub-agents at once (setting): merge or split the tasks into rounds` };
  return { tasks };
}

/** What the main agent reads next turn (TOOL OUTPUT) and the one-line result. */
function formatResults(results) {
  const ok = results.filter((r) => r.ok).length;
  const summary = `parallel: ${ok}/${results.length} sub-agents finished (reports in TOOL OUTPUT)`;
  const output = results
    .map((r, i) => `### 하위 에이전트 ${i + 1}: ${r.title}${r.tabId != null ? ` (tab ${r.tabId})` : ''}\n${r.ok ? r.answer : `FAILED: ${r.error}`}`)
    .join('\n\n');
  return { summary, output: `SUB-AGENT REPORTS:\n${output}` };
}

/** Goal text a sub-agent receives: its own task plus the rules it works under. */
function subGoal(task) {
  return `${task.goal}

(You are a SUB-AGENT working for a main agent, in your own browser tab, at the same time as other sub-agents. Stay in this tab: use navigate instead of new tabs. Only read, search and collect: never pay, order, publish, post, send, upload or delete, and don't ask the user anything — if something needs a login or a decision, stop and say so in your report. Finish with done; the answer is your report to the main agent: put every fact, number, name and URL it needs in it, concise. Files you save go to the shared work folder: mention their names.)`;
}

module.exports = { normalizeTasks, formatResults, subGoal, SUB_FORBIDDEN, SUB_MAX_STEPS };
