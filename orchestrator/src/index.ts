import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PLANNER_URL   = process.env.PLANNER_URL   || 'http://planner:3001';
const GENERATOR_URL = process.env.GENERATOR_URL || 'http://generator:3002';
const HEALER_URL    = process.env.HEALER_URL    || 'http://healer:3003';
const EXECUTOR_URL  = process.env.EXECUTOR_URL  || 'http://executor:3004';
const MAX_HEAL_ATTEMPTS = parseInt(process.env.MAX_HEAL_ATTEMPTS || '3');

// Live status store
interface RunStatus {
  testId: string;
  step: 'idle' | 'planning' | 'generating' | 'executing' | 'healing' | 'done' | 'error';
  activeService: 'planner' | 'generator' | 'executor' | 'healer' | null;
  attempt: number;
  log: string[];
  passed?: boolean;
  startedAt: number;
}

const runStatus: RunStatus = {
  testId: '',
  step: 'idle',
  activeService: null,
  attempt: 0,
  log: [],
  startedAt: 0,
};

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'orchestrator' }));

app.get('/status', (_, res) => res.json(runStatus));

app.post('/run', async (req, res) => {
  const { prompt, baseUrl, model } = req.body;

  if (!prompt || !baseUrl) {
    return res.status(400).json({ error: 'prompt and baseUrl are required' });
  }

  const testId = uuidv4().substring(0, 8);
  const log: string[] = [];
  const addLog = (msg: string) => { log.push(msg); console.log(msg); runStatus.log = [...log]; };

  // Reset status
  Object.assign(runStatus, { testId, step: 'planning', activeService: 'planner', attempt: 0, log: [], passed: undefined, startedAt: Date.now() });

  try {
    // 1. PLAN
    addLog(`[${testId}] Step 1/4: Planning...`);
    runStatus.step = 'planning'; runStatus.activeService = 'planner';
    const planResp = await axios.post(`${PLANNER_URL}/plan`, { prompt, baseUrl, model });
    const { plan } = planResp.data;
    addLog(`[${testId}] Plan: ${plan.title} (${plan.steps.length} steps)`);

    // 2. GENERATE
    addLog(`[${testId}] Step 2/4: Generating test code...`);
    runStatus.step = 'generating'; runStatus.activeService = 'generator';
    const genResp = await axios.post(`${GENERATOR_URL}/generate`, { plan, baseUrl, model });
    let code = genResp.data.code;

    // 3. EXECUTE → HEAL LOOP
    let passed = false;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS + 1; attempt++) {
      addLog(`[${testId}] Step 3/4: Executing (attempt ${attempt})...`);
      runStatus.step = 'executing'; runStatus.activeService = 'executor'; runStatus.attempt = attempt;
      const execResp = await axios.post(`${EXECUTOR_URL}/execute`, { code, testId: `${testId}-${attempt}` });

      if (execResp.data.passed) {
        passed = true;
        addLog(`[${testId}] ✅ Test PASSED on attempt ${attempt}`);
        break;
      }

      lastError = execResp.data.error;
      addLog(`[${testId}] ❌ Test failed: ${lastError.substring(0, 150)}`);

      if (attempt <= MAX_HEAL_ATTEMPTS) {
        addLog(`[${testId}] Step 4/4: Healing (attempt ${attempt}/${MAX_HEAL_ATTEMPTS})...`);
        runStatus.step = 'healing'; runStatus.activeService = 'healer';
        const healResp = await axios.post(`${HEALER_URL}/heal`, { code, error: lastError, plan, model });
        code = healResp.data.code;
      }
    }

    runStatus.step = 'done'; runStatus.activeService = null; runStatus.passed = passed;

    res.json({
      testId,
      passed,
      plan,
      finalCode: code,
      log,
      error: passed ? null : lastError
    });

  } catch (err: any) {
    console.error('[Orchestrator] Fatal error:', err.message);
    runStatus.step = 'error'; runStatus.activeService = null;
    res.status(500).json({ error: err.message, log });
  }
});

app.listen(3000, () => console.log('[Orchestrator] Running on :3000'));
