/**
 * Nuri - SidePanel Controller
 * Orchestrates multi-model AI (Gemini, GPT, Claude) and real-time browser tab automation.
 */

const SERVER_BASE = 'http://localhost:3456';
let activeTaskId = null;
let sseSource = null;

// Initialize on DOM load
// Outside the extension (e.g. http://localhost:3456/sidepanel) there is no
// chrome.runtime, so browser control is impossible; say so instead of crashing.
const HAS_EXTENSION = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
if (!HAS_EXTENSION) {
  window.chrome = window.chrome || {};
  chrome.runtime = { sendMessage: (_msg, cb) => cb && cb({}) };
}

document.addEventListener('DOMContentLoaded', () => {
  if (!HAS_EXTENSION) {
    appendMessage('agent', '⚠️ 확장 프로그램 밖에서 열린 화면입니다. 브라우저 제어를 하려면 AI-Native-Browser.exe로 실행하거나 툴바의 확장 아이콘으로 사이드패널을 여세요.');
  }
  updateActiveTabInfo();
  checkEngineStatus();

  document.getElementById('refreshTabBtn').addEventListener('click', updateActiveTabInfo);
  // MV3 CSP blocks inline onclick handlers, so wire buttons here.
  document.getElementById('sendBtn').addEventListener('click', executeCommand);
  document.getElementById('stopBtn').addEventListener('click', () => window.stopExecution());
  document.querySelectorAll('[data-prompt]').forEach((chip) => {
    chip.addEventListener('click', () => window.applyQuickPrompt(chip.dataset.prompt));
  });
  document.getElementById('promptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeCommand();
  });
});

window.applyQuickPrompt = function(promptText) {
  const input = document.getElementById('promptInput');
  input.value = promptText;
  executeCommand();
};

async function updateActiveTabInfo() {
  chrome.runtime.sendMessage({ type: 'ANB_GET_ACTIVE_TAB' }, (res) => {
    const tab = res?.tab;
    const tabUrlEl = document.getElementById('activeTabUrl');
    if (tab && tab.url) {
      tabUrlEl.innerText = tab.url.replace(/^https?:\/\//, '').slice(0, 32);
      tabUrlEl.title = tab.url;
    } else {
      tabUrlEl.innerText = 'about:blank';
    }
  });
}

async function checkEngineStatus() {
  const badge = document.getElementById('engineStatus');
  try {
    const res = await fetch(`${SERVER_BASE}/v1/health`);
    if (res.ok) {
      badge.innerHTML = `<span class="status-dot"></span><span>엔진 가동 중</span>`;
      badge.style.color = '#3fb950';
    } else {
      throw new Error('Not ok');
    }
  } catch {
    badge.innerHTML = `<span class="status-dot" style="background:#d29922"></span><span>서버 대기 중</span>`;
    badge.style.color = '#d29922';
  }
}

async function executeCommand() {
  const input = document.getElementById('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;

  const model = document.getElementById('modelSelect').value;
  input.value = '';

  // 1. Append User Message
  appendMessage('user', prompt);

  // Toggle buttons
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'flex';

  // 2. Pre-process Target Navigation
  const targetUrl = detectUrl(prompt);
  if (targetUrl) {
    appendMessage('step-action', `🌐 <strong>[자동 이동]</strong> ${targetUrl} 로 브라우저를 이동합니다...`);
    chrome.runtime.sendMessage({ type: 'ANB_NAVIGATE_TAB', url: targetUrl });
    // Allow page 1.5s to start loading
    await new Promise((r) => setTimeout(r, 1500));
    updateActiveTabInfo();
  }

  // 3. Extract Real Page Snapshot
  appendMessage('step-action', `📋 <strong>[접근성 분석]</strong> 브라우저 화면의 ARIA 상호작용 요소를 추출합니다...`);
  let snapshot = null;
  try {
    const snapRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'ANB_CAPTURE_SNAPSHOT' }, resolve);
    });
    snapshot = snapRes?.snapshot;
  } catch (err) {
    console.warn('Snapshot capture failed:', err);
  }

  // 4. Send Task to Local Orchestrator Backend
  try {
    const taskRes = await fetch(`${SERVER_BASE}/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt,
        model: model,
        providerId: model.includes('gemini') ? 'google-agy' : (model.includes('gpt') ? 'openai-codex' : 'anthropic-claude'),
        pageSnapshot: snapshot
      })
    });

    if (!taskRes.ok) {
      const errBody = await taskRes.json();
      throw new Error(errBody.error || `HTTP ${taskRes.status}`);
    }

    const task = await taskRes.json();
    activeTaskId = task.taskId;
    listenTaskEvents(activeTaskId);

  } catch (err) {
    appendMessage('agent', `❌ <strong>오류 발생:</strong> ${err.message}`);
    resetButtons();
  }
}

function listenTaskEvents(taskId) {
  if (sseSource) sseSource.close();
  sseSource = new EventSource(`${SERVER_BASE}/v1/tasks/${taskId}/events`);

  sseSource.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);

      if (ev.type === 'step_update' && ev.textDelta) {
        appendMessage('step-action', ev.textDelta);
      } else if (ev.type === 'tool_call' && ev.toolName === 'browser.navigate' && ev.toolArgs?.url) {
        appendMessage('step-action', `🌐 <strong>[브라우저 이동]</strong> ${ev.toolArgs.url}`);
        chrome.runtime.sendMessage({ type: 'ANB_NAVIGATE_TAB', url: ev.toolArgs.url });
        updateActiveTabInfo();
      } else if (ev.type === 'tool_call' && ev.toolName === 'browser.ariaSnapshot') {
        appendMessage('step-action', `📋 [ARIA 트리] ${ev.toolArgs.interactiveCount || 0}개 상호작용 요소 식별 완료`);
      } else if (ev.type === 'tool_call' && ev.toolName === 'browser.click') {
        appendMessage('step-action', `🖱️ <strong>[자동 클릭]</strong> ${ev.toolArgs.refId || '요소'} 클릭 실행`);
        chrome.runtime.sendMessage({
          type: 'ANB_CLICK_ELEMENT',
          selector: ev.toolArgs.selector,
          refText: ev.toolArgs.refText
        });
      } else if (ev.type === 'tool_call' && ev.toolName === 'browser.fill') {
        appendMessage('step-action', `⌨️ <strong>[자동 입력]</strong> '${ev.toolArgs.text}' 입력 실행`);
        chrome.runtime.sendMessage({
          type: 'ANB_FILL_INPUT',
          selector: ev.toolArgs.selector,
          text: ev.toolArgs.text
        });
      } else if (ev.type === 'result' && ev.textDelta) {
        appendMessage('result-card', `✅ <strong>요약 및 분석 완료:</strong><br><br>${ev.textDelta.replace(/\n/g, '<br>')}`);
        finishExecution();
      } else if (ev.type === 'error') {
        appendMessage('agent', `❌ <strong>실행 실패:</strong> ${ev.error}`);
        finishExecution();
      } else if (ev.type === 'state' && ['COMPLETED', 'CANCELLED'].includes(ev.state)) {
        if (activeTaskId) appendMessage('step-action', ev.state === 'COMPLETED' ? '✅ 작업 완료' : '⏹️ 작업 취소됨');
        finishExecution();
      }
    } catch (parseErr) {
      console.warn('SSE parse error:', parseErr);
    }
  };

  sseSource.onerror = () => {
    // Retry or close
  };
}

window.stopExecution = async function() {
  if (activeTaskId) {
    await fetch(`${SERVER_BASE}/v1/tasks/${activeTaskId}/cancel`, { method: 'POST' }).catch(() => {});
    appendMessage('step-action', '⏹️ 작업이 사용자에 의해 중단되었습니다.');
  }
  finishExecution();
};

function finishExecution() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  activeTaskId = null;
  resetButtons();
  updateActiveTabInfo();
}

function resetButtons() {
  document.getElementById('sendBtn').style.display = 'flex';
  document.getElementById('stopBtn').style.display = 'none';
}

function appendMessage(className, htmlContent) {
  const chatBox = document.getElementById('chatBox');
  const msg = document.createElement('div');
  msg.className = `msg ${className}`;
  msg.innerHTML = htmlContent;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function detectUrl(prompt) {
  const p = prompt.toLowerCase();
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  const match = urlRegex.exec(prompt);
  if (match) return match[1];

  if (p.includes('네이버') || p.includes('naver')) {
    const searchMatch = /네이버(?:에서)?\s+(?:'|")?([^'"\n]+?)(?:'|")?\s*(?:검색|찾아|조회|최저가)/i.exec(prompt);
    if (searchMatch && searchMatch[1]) {
      return `https://search.naver.com/search.naver?query=${encodeURIComponent(searchMatch[1].trim())}`;
    }
    return 'https://www.naver.com';
  }

  if (p.includes('유튜브') || p.includes('youtube')) return 'https://www.youtube.com';
  if (p.includes('다음') || p.includes('daum')) return 'https://www.daum.net';
  if (p.includes('구글') || p.includes('google')) return 'https://www.google.com';
  if (p.includes('쿠팡') || p.includes('coupang')) return 'https://www.coupang.com';
  if (p.includes('깃허브') || p.includes('github')) return 'https://github.com';

  return null;
}
