import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const app = express();
app.use(express.json());

const TESTS_DIR = '/shared/tests';
const RESULTS_DIR = '/shared/results';
const LOCAL_TEST_DIR = '/app/tests';
const REPORTS_DIR = '/app/reports';

fs.mkdirSync(LOCAL_TEST_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'executor' }));

// Serve HTML reports statically
app.use('/reports', express.static(REPORTS_DIR, { index: 'index.html' }));

// List last 5 reports
app.get('/reports-list', (_, res) => {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return res.json({ reports: [] });
    const dirs = fs.readdirSync(REPORTS_DIR)
      .filter(d => fs.existsSync(path.join(REPORTS_DIR, d, 'index.html')))
      .map(d => {
        const stat = fs.statSync(path.join(REPORTS_DIR, d));
        return { id: d, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
    res.json({ reports: dirs.map(d => d.id) });
  } catch (e: any) {
    res.json({ reports: [] });
  }
});

app.post('/execute', (req, res) => {
  const { code, testId } = req.body;
  if (!code || !testId) return res.status(400).json({ error: 'code and testId are required' });

  const localTestFile = path.join(LOCAL_TEST_DIR, `${testId}.spec.ts`);
  const reportDir = path.join(REPORTS_DIR, testId);
  const jsonResultsDir = path.join(RESULTS_DIR, testId);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(jsonResultsDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(localTestFile, code);

  fs.mkdirSync(TESTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TESTS_DIR, `${testId}.spec.ts`), code);

  console.log(`[Executor] Running test: ${testId}`);

  try {
    const output = execSync(
      `npx playwright test ${localTestFile} --reporter=json,html`,
      {
        cwd: '/app',
        timeout: 120000,
        env: {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(jsonResultsDir, 'results.json'),
          PLAYWRIGHT_HTML_REPORT: reportDir,
        }
      }
    ).toString();

    console.log(`[Executor] Test PASSED: ${testId}`);
    res.json({ success: true, passed: true, output, reportId: testId });

  } catch (err: any) {
    const output = err.stdout?.toString() || err.message;
    const stderr = err.stderr?.toString() || '';
    const fullError = `${output}\n${stderr}`.trim();

    let results = null;
    try {
      const jsonPath = path.join(jsonResultsDir, 'results.json');
      if (fs.existsSync(jsonPath)) results = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch {}

    console.log(`[Executor] Test FAILED: ${testId}`);
    console.log(`[Executor] Error: ${fullError.slice(0, 500)}`);
    res.json({ success: true, passed: false, error: fullError, results, reportId: testId });
  }
});

app.listen(3004, () => console.log('[Executor] Running on :3004'));
