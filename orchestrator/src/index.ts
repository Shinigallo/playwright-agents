import express from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

const PLANNER_URL   = process.env.PLANNER_URL   || 'http://planner:3001';
const GENERATOR_URL = process.env.GENERATOR_URL || 'http://generator:3002';
const HEALER_URL    = process.env.HEALER_URL    || 'http://healer:3003';
const EXECUTOR_URL  = process.env.EXECUTOR_URL  || 'http://executor:3004';
const MAX_HEAL_ATTEMPTS = parseInt(process.env.MAX_HEAL_ATTEMPTS || '3');

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'orchestrator' }));

app.post('/run', async (req, res) => {
  const { prompt, baseUrl } = req.body;

  if (!prompt || !baseUrl) {
    return res.status(400).json({ error: 'prompt and baseUrl are required' });
  }

  const testId = uuidv4().substring(0, 8);
  const log: string[] = [];
  const addLog = (msg: string) => { log.push(msg); console.log(msg); };

  try {
    // 1. PLAN
    addLog(`[${testId}] Step 1/4: Planning...`);
    const planResp = await axios.post(`${PLANNER_URL}/plan`, { prompt, baseUrl });
    const { plan } = planResp.data;
    addLog(`[${testId}] Plan: ${plan.title} (${plan.steps.length} steps)`);

    // 2. GENERATE
    addLog(`[${testId}] Step 2/4: Generating test code...`);
    const genResp = await axios.post(`${GENERATOR_URL}/generate`, { plan });
    let code = genResp.data.code;

    // 3. EXECUTE → HEAL LOOP
    let passed = false;
    let lastError = '';
    
    for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS + 1; attempt++) {
      addLog(`[${testId}] Step 3/4: Executing (attempt ${attempt})...`);
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
        const healResp = await axios.post(`${HEALER_URL}/heal`, { code, error: lastError, plan });
        code = healResp.data.code;
      }
    }

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
    res.status(500).json({ error: err.message, log });
  }
});

app.listen(3000, () => console.log('[Orchestrator] Running on :3000'));
