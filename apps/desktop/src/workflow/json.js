// Extracts the first complete JSON object from an LLM reply (tolerates code fences and chatter).
// Shared by the step agents (decision.js) and the autopilot planner.

const { t } = require('../i18n');

function parseJsonObject(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  if (start < 0) throw new Error(t('LLM 응답에서 JSON을 찾을 수 없습니다'));
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error(t('LLM 응답의 JSON이 완결되지 않았습니다'));
}

module.exports = { parseJsonObject };
