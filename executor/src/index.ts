import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const app = express();
app.use(express.json());

const TESTS_DIR = '/shared/tests';
const RESULTS_DIR = '/shared/results';
const LOCAL_TEST_DIR = '/app/tests';

// Ensure local test dir exists
fs.mkdirSync(LOCAL_TEST_DIR, { recursive: true });

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'executor' }));

app.post('/execute', (req, res) => {
  const { code, testId } = req.body;

  if (!code || !testId) {
    return res.status(400).json({ error: 'code and testId are required' });
  }

  // Write test locally (Playwright can only resolve local paths)
  const localTestFile = path.join(LOCAL_TEST_DIR, `${testId}.spec.ts`);
  const reportDir = path.join(RESULTS_DIR, testId);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(localTestFile, code);

  // Also save to shared volume for inspection
  fs.mkdirSync(TESTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TESTS_DIR, `${testId}.spec.ts`), code);

  console.log(`[Executor] Running test: ${testId}`);

  try {
    const output = execSync(
      `npx playwright test ${localTestFile} --reporter=json`,
      {
        cwd: '/app',
        timeout: 120000,
        env: {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(reportDir, 'results.json')
        }
      }
    ).toString();

    console.log(`[Executor] Test PASSED: ${testId}`);
    res.json({ success: true, passed: true, output });

  } catch (err: any) {
    const output = err.stdout?.toString() || err.message;
    const stderr = err.stderr?.toString() || '';
    const fullError = `${output}\n${stderr}`.trim();

    let results = null;
    try {
      const jsonPath = path.join(reportDir, 'results.json');
      if (fs.existsSync(jsonPath)) {
        results = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      }
    } catch {}

    console.log(`[Executor] Test FAILED: ${testId}`);
    console.log(`[Executor] Error: ${fullError.slice(0, 500)}`);
    res.json({ success: true, passed: false, error: fullError, results });
  }
});

app.listen(3004, () => console.log('[Executor] Running on :3004'));
