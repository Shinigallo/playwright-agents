import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

const app = express();
app.use(express.json());

// CORS + COEP/COOP per Trace Viewer
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const TESTS_DIR = '/shared/tests';
const RESULTS_DIR = '/shared/results';
const LOCAL_TEST_DIR = '/app/tests';
const REPORTS_DIR = '/app/reports';

fs.mkdirSync(LOCAL_TEST_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// Mappa testId -> porta show-report
const reportServers: Map<string, number> = new Map();
const reportProcs: Map<string, import('child_process').ChildProcess> = new Map();
let nextPort = 9300;

function startReportServer(testId: string, reportDir: string): number {
  // Se già in esecuzione, restituisce la porta
  if (reportServers.has(testId)) return reportServers.get(testId)!;

  const port = nextPort++;
  reportServers.set(testId, port);

  const proc = spawn(
    'npx', ['playwright', 'show-report', reportDir, '--port', String(port), '--host', '0.0.0.0'],
    { cwd: '/app', stdio: 'ignore' }  // NO detached — il processo muore col container
  );
  reportProcs.set(testId, proc);

  console.log(`[Executor] Report server for ${testId} started on :${port}`);
  return port;
}

// Graceful shutdown: killa tutti i report server
function shutdownReportServers() {
  for (const [id, proc] of reportProcs.entries()) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  reportProcs.clear();
  reportServers.clear();
}

process.on('SIGTERM', () => { shutdownReportServers(); process.exit(0); });
process.on('SIGINT',  () => { shutdownReportServers(); process.exit(0); });

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'executor' }));

// Serve file statici come fallback (screenshot, video, zip trace)
app.use('/reports', express.static(REPORTS_DIR));

// Lista ultimi 5 report con porta show-report
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

    const reports = dirs.map(d => {
      const reportDir = path.join(REPORTS_DIR, d.id);
      const port = startReportServer(d.id, reportDir);
      return { id: d.id, port };
    });

    res.json({ reports });
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

  const env = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(jsonResultsDir, 'results.json'),
    PLAYWRIGHT_HTML_REPORT: reportDir,
  };

  let passed = false;
  let output = '';
  let fullError = '';
  let results = null;

  try {
    output = execSync(
      `npx playwright test ${localTestFile} --reporter=json,html`,
      { cwd: '/app', timeout: 120000, env }
    ).toString();
    passed = true;
    console.log(`[Executor] Test PASSED: ${testId}`);
  } catch (err: any) {
    output = err.stdout?.toString() || err.message;
    const stderr = err.stderr?.toString() || '';
    fullError = `${output}\n${stderr}`.trim();
    console.log(`[Executor] Test FAILED: ${testId}`);
    try {
      const jsonPath = path.join(jsonResultsDir, 'results.json');
      if (fs.existsSync(jsonPath)) results = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch {}
  }

  // Avvia show-report e restituisce la porta
  const reportPort = startReportServer(testId, reportDir);

  res.json({ success: true, passed, output, error: fullError, results, reportId: testId, reportPort });
});

app.listen(3004, () => console.log('[Executor] Running on :3004'));
