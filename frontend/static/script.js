// Playwright Agents — Frontend JS
// Spostato da inline script (fix #7: violazione CSP, separazione cache)

const SERVICE_INPUTS = {
  orchestrator: 'orchUrl',
  planner: 'plannerUrl',
  generator: 'generatorUrl',
  healer: 'healerUrl',
  executor: 'executorUrl'
};

let selectedModel = 'gemini-2.0-flash';
let selectedProvider = 'gemini';
let history = [];
let currentResult = null;

// ── Model selector ──
document.querySelectorAll('.model-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedModel = btn.dataset.model;
    if (btn.dataset.provider) selectedProvider = btn.dataset.provider;
  });
});

// ── Provider selector ──
const providerBtns = document.querySelectorAll('.provider-btn');
providerBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    providerBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedProvider = btn.dataset.provider;
    updateModelOptions();
  });
});

function updateModelOptions() {
  const container = document.getElementById('modelButtons');
  const urlField = document.getElementById('openaiUrlField');
  if (!container) return;
  container.innerHTML = '';

  if (selectedProvider === 'openai') {
    urlField.style.display = 'block';
  } else {
    urlField.style.display = 'none';
  }

  const models = selectedProvider === 'gemini'
    ? [
        { model: 'gemini-2.0-flash', label: '2.0 Flash', provider: 'gemini' },
        { model: 'gemini-2.5-pro', label: '2.5 Pro', provider: 'gemini' },
        { model: 'gemini-3.0-ultra', label: '3.0 Ultra', provider: 'gemini' },
      ]
    : [
        { model: 'llama3.1', label: 'Llama 3.1', provider: 'openai' },
        { model: 'codellama', label: 'CodeLlama', provider: 'openai' },
        { model: 'mixtral', label: 'Mixtral', provider: 'openai' },
      ];

  models.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'model-btn' + (m.model === selectedModel ? ' active' : '');
    btn.dataset.model = m.model;
    btn.dataset.provider = m.provider;
    btn.textContent = m.label;
    container.appendChild(btn);
  });

  if (selectedProvider === 'openai' && selectedModel === 'gemini-2.0-flash') {
    selectedModel = 'llama3.1';
  } else if (selectedProvider === 'gemini' && selectedModel === 'llama3.1') {
    selectedModel = 'gemini-2.0-flash';
  }
}

// ── Tabs ──
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Health checks ──
async function checkHealth() {
  for (const [svc, inputId] of Object.entries(SERVICE_INPUTS)) {
    const pill = document.getElementById('pill-' + svc);
    const inputEl = document.getElementById(inputId);
    if (!inputEl) continue;
    const url = inputEl.value.replace(/\/$/, '') + '/health';
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      pill.className = 'pill ' + (r.ok ? 'ok' : 'err');
    } catch {
      pill.className = 'pill err';
    }
  }
}

checkHealth();
setInterval(checkHealth, 10000);

// ── Reports list ──
async function loadReports() {
  const execUrl = document.getElementById('executorUrl').value.replace(/\/$/, '');
  const el = document.getElementById('reportsList');
  try {
    const r = await fetch(`${execUrl}/reports-list`, { signal: AbortSignal.timeout(3000) });
    const { reports } = await r.json();
    if (!reports || reports.length === 0) {
      el.innerHTML = '<div style="color:var(--text2);font-size:.8rem;text-align:center;padding:8px 0">No reports yet</div>';
      return;
    }
    const host = execUrl.startsWith('http') ? new URL(execUrl).hostname : window.location.hostname;
    el.innerHTML = reports.map(r => {
      const id = r.id || r;
      const port = r.port;
      const reportUrl = port ? `http://${host}:${port}` : `${execUrl}/reports/${id}/`;
      return `<a href="${reportUrl}" target="_blank" style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;background:var(--surface2);color:var(--text);text-decoration:none;font-size:.78rem;font-family:monospace;transition:background .15s" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='var(--surface2)'">
        <span style="font-size:1rem">📋</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${id}</span>
        ${port ? `<span style="margin-left:auto;font-size:.7rem;color:var(--accent2)">:${port} ↗</span>` : `<span style="margin-left:auto;font-size:.9rem;opacity:.6">↗</span>`}
      </a>`;
    }).join('');
  } catch {
    el.innerHTML = '<div style="color:var(--text2);font-size:.8rem;text-align:center;padding:8px 0">Executor offline</div>';
  }
}

loadReports();
setInterval(loadReports, 15000);

// ── Pipeline state helpers ──
let statusPoller = null;

function startStatusPolling() {
  const orchUrl = document.getElementById('orchUrl').value.replace(/\/$/, '');
  statusPoller = setInterval(async () => {
    try {
      const r = await fetch(`${orchUrl}/status`);
      const s = await r.json();
      const svc = s.activeService;
      const all = ['planner','generator','executor','healer'];
      all.forEach(name => {
        const el = document.getElementById('pss-' + name);
        const card = el?.closest('.p-step');
        if (!el || !card) return;
        if (name === svc) {
          el.textContent = s.step + (s.attempt > 1 ? ` #${s.attempt}` : '') + '…';
          card.setAttribute('data-state', 'active');
        } else if (s.log?.join(' ').includes(name === 'planner' ? 'Plan:' : name === 'generator' ? 'Generating' : name === 'executor' ? 'PASSED' : 'fixed')) {
          // already done
        }
      });
      // update live log
      if (s.log?.length) {
        const logEl = document.getElementById('liveLog');
        if (logEl) logEl.textContent = s.log.join('\n');
      }
      if (s.step === 'done' || s.step === 'error' || s.step === 'idle') {
        stopStatusPolling();
      }
    } catch(e) {}
  }, 1500);
}

function stopStatusPolling() {
  if (statusPoller) { clearInterval(statusPoller); statusPoller = null; }
}

function setPipelineStep(step, state, status) {
  const el = document.getElementById('ps-' + step);
  const st = document.getElementById('pss-' + step);
  el.className = 'p-step ' + state;
  st.textContent = status;
}

function resetPipeline() {
  ['planner','generator','executor','healer'].forEach(s => setPipelineStep(s, '', 'idle'));
}

function appendLog(msg) {
  const el = document.getElementById('liveLog');
  const line = document.createElement('span');
  line.className = 'log-line ' + classifyLog(msg);
  line.textContent = msg;
  el.appendChild(line);
  el.appendChild(document.createElement('br'));
  el.scrollTop = el.scrollHeight;
}

function classifyLog(msg) {
  if (msg.includes('✅') || msg.includes('PASSED')) return 'ok';
  if (msg.includes('❌') || msg.includes('failed') || msg.includes('Error')) return 'fail';
  if (msg.includes('Healing') || msg.includes('Healer')) return 'heal';
  return 'info';
}

// ── Simulate live pipeline updates from log messages ──
function updatePipelineFromLog(log) {
  log.forEach(msg => {
    if (msg.includes('Planning'))    setPipelineStep('planner',   'active', 'running…');
    if (msg.includes('Plan:'))       setPipelineStep('planner',   'done',   'done ✓');
    if (msg.includes('Generating'))  setPipelineStep('generator', 'active', 'running…');
    if (msg.includes('Code generated')) setPipelineStep('generator', 'done', 'done ✓');
    if (msg.includes('Executing'))   setPipelineStep('executor',  'active', 'running…');
    if (msg.includes('PASSED'))      setPipelineStep('executor',  'done',   'passed ✓');
    if (msg.includes('failed'))      setPipelineStep('executor',  'error',  'failed ✗');
    if (msg.includes('Healing'))     setPipelineStep('healer',    'active', 'healing…');
    if (msg.includes('Code fixed'))  setPipelineStep('healer',    'done',   'fixed ✓');
  });
}

// ── Main run ──
async function runTest() {
  const prompt  = document.getElementById('prompt').value.trim();
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const orchUrl = document.getElementById('orchUrl').value.replace(/\/$/, '');

  if (!prompt || !baseUrl) {
    alert('Please fill in Prompt and Base URL');
    return;
  }

  // UI setup
  const btn = document.getElementById('runBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  startStatusPolling();

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('pipelineView').style.display = 'block';
  document.getElementById('resultBanner').style.display = 'none';
  document.getElementById('liveLog').innerHTML = '';
  resetPipeline();

  // Switch to pipeline tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="pipeline"]').classList.add('active');
  document.getElementById('tab-pipeline').classList.add('active');

  appendLog(`Starting run — provider: ${selectedProvider}, model: ${selectedModel}`);
  appendLog(`Prompt: "${prompt}"`);
  appendLog(`Base URL: ${baseUrl}`);

  try {
    const requestBody = { prompt, baseUrl, model: selectedModel, provider: selectedProvider };
    if (selectedProvider === 'openai') {
      const openaiUrl = document.getElementById('openaiBaseUrl');
      const openaiKey = document.getElementById('openaiApiKey');
      if (openaiUrl) requestBody.openaiBaseURL = openaiUrl.value;
      if (openaiKey) requestBody.openaiApiKey = openaiKey.value;
    }

    const resp = await fetch(`${orchUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const result = await resp.json();
    currentResult = result;

    // Show log lines
    (result.log || []).forEach(l => appendLog(l));
    updatePipelineFromLog(result.log || []);

    // Result banner
    const banner = document.getElementById('resultBanner');
    banner.style.display = 'flex';
    if (result.passed) {
      banner.className = 'result-banner pass';
      banner.innerHTML = '<span class="r-icon">✅</span> All tests passed!';
    } else {
      banner.className = 'result-banner fail';
      banner.innerHTML = `<span class="r-icon">❌</span> Tests failed after all heal attempts`;
    }

    // Fill plan tab
    if (result.plan) {
      document.getElementById('emptyPlan').style.display = 'none';
      document.getElementById('planContent').style.display = 'block';
      document.getElementById('planTitle').textContent = result.plan.title || 'Test Plan';
      const list = document.getElementById('stepsList');
      list.innerHTML = '';
      (result.plan.steps || []).forEach(s => {
        const el = document.createElement('div');
        el.className = 'step-item';
        el.innerHTML = `
            <div class="step-num">${s.id}</div>
            <div class="step-body">
              <span class="step-action">${s.action}</span>
              <span class="step-desc">${s.description}</span>
              ${s.selector ? `<div class="step-meta">selector: <code>${s.selector}</code></div>` : ''}
              ${s.value     ? `<div class="step-meta">value: <code>${s.value}</code></div>` : ''}
              ${s.assertion ? `<div class="step-meta">assert: <code>${s.assertion}</code></div>` : ''}
            </div>`;
        list.appendChild(el);
      });
    }

    // Fill code tab
    if (result.finalCode) {
      document.getElementById('emptyCode').style.display = 'none';
      document.getElementById('codeContent').style.display = 'block';
      document.getElementById('codeBlock').textContent = result.finalCode;
    }

    // Fill logs tab
    document.getElementById('emptyLogs').style.display = 'none';
    document.getElementById('logsContent').style.display = 'block';
    const fullLog = document.getElementById('fullLog');
    fullLog.innerHTML = '';
    (result.log || []).forEach(l => {
      const line = document.createElement('span');
      line.className = 'log-line ' + classifyLog(l);
      line.textContent = l;
      fullLog.appendChild(line);
      fullLog.appendChild(document.createElement('br'));
    });

    // Add to history
    history.unshift({
      id: result.testId,
      title: result.plan?.title || prompt.substring(0, 40),
      passed: result.passed,
      time: new Date().toLocaleTimeString(),
      result
    });
    renderHistory();
    loadReports();

  } catch (err) {
    appendLog('❌ Error: ' + err.message);
    appendLog('Make sure the orchestrator is running at ' + orchUrl);
  }

  btn.classList.remove('loading');
  btn.disabled = false;
  stopStatusPolling();
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!history.length) return;
  list.innerHTML = history.map((h, i) => `
      <div class="hist-item" onclick="loadHistory(${i})">
        <div class="hi-title">${h.title}</div>
        <div class="hi-meta">
          <span class="badge ${h.passed ? 'pass' : 'fail'}">${h.passed ? 'PASS' : 'FAIL'}</span>
          <span>#${h.id}</span>
          <span>${h.time}</span>
        </div>
      </div>`).join('');
}

function loadHistory(i) {
  const h = history[i];
  currentResult = h.result;

  // Re-populate code tab
  if (h.result.finalCode) {
    document.getElementById('emptyCode').style.display = 'none';
    document.getElementById('codeContent').style.display = 'block';
    document.getElementById('codeBlock').textContent = h.result.finalCode;
  }
}

function copyCode() {
  const code = document.getElementById('codeBlock').textContent;
  navigator.clipboard.writeText(code);
  const btn = document.querySelector('.copy-btn');
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 1500);
}
