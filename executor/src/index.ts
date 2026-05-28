import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const app = express();
app.use(express.json());

const TESTS_DIR = '/shared/tests';
const RESULTS_DIR = '/shared/results';

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'executor' }));

app.post('/execute', (req, res) => {
  const { code, testId } = req.body;

  if (!code || !testId) {
    return res.status(400).json({ error: 'code and testId are required' });
  }

  const testFile = path.join(TESTS_DIR, `${testId}.spec.ts`);
  const reportDir = path.join(RESULTS_DIR, testId);

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(testFile, code);

  console.log(`[Executor] Running test: ${testId}`);

  try {
    const output = execSync(
      `npx playwright test ${testFile} --reporter=json --output=${reportDir}`,
      {
        timeout: 120000,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(reportDir, 'results.json') }
      }
    ).toString();

    console.log(`[Executor] Test PASSED: ${testId}`);
    res.json({ success: true, passed: true, output });

  } catch (err: any) {
    const output = err.stdout?.toString() || err.message;
    const stderr = err.stderr?.toString() || '';
    const fullError = `${output}\n${stderr}`.trim();

    // Try to read JSON results
    let results = null;
    try {
      const jsonPath = path.join(reportDir, 'results.json');
      if (fs.existsSync(jsonPath)) {
        results = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      }
    } catch {}

    console.log(`[Executor] Test FAILED: ${testId}`);
    res.json({ success: true, passed: false, error: fullError, results });
  }
});

app.listen(3004, () => console.log('[Executor] Running on :3004'));
