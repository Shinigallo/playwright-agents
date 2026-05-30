/**
 * ============================================================
 * EXECUTOR — Agente di esecuzione test
 * ============================================================
 * Terzo agente della pipeline e il più "pesante" del sistema.
 * È l'unico container che usa l'immagine Playwright con browser
 * Chromium pre-installato (mcr.microsoft.com/playwright:v1.44.0).
 *
 * Responsabilità:
 *   1. Riceve il codice TypeScript generato dal Generator
 *   2. Scrive il file .spec.ts in /app/tests/ (directory locale del container)
 *   3. Esegue il test con `npx playwright test`
 *   4. Genera report HTML e JSON per ogni run
 *   5. Avvia un server `npx playwright show-report` per ogni run
 *      (porta dinamica 9300-9320) per accedere al Trace Viewer completo
 *   6. Gestisce lo shutdown graceful dei server di report
 *
 * IMPORTANTE: il test viene scritto ANCHE in /shared/tests (volume Docker
 * condiviso con l'host) per ispezione manuale, ma viene ESEGUITO dalla
 * copia locale /app/tests/ per rispettare il testDir di playwright.config.ts.
 *
 * Endpoint esposti:
 *   POST /execute      → esegue il test, restituisce passed/failed + reportId
 *   GET  /reports-list → lista degli ultimi 5 report con porta show-report
 *   GET  /reports/*    → file statici dei report (screenshot, video, zip)
 *   GET  /health       → health check
 *
 * Porta interna: 3004 | Porta esterna: 3004
 * Porte report:  9300-9320 (una per ogni run recente)
 * ============================================================
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS + headers per il Trace Viewer
// Il Trace Viewer di Playwright è una SPA che usa SharedArrayBuffer,
// il quale richiede COEP/COOP per funzionare nel browser moderno.
// Questi header sono necessari affinché il trace si apra correttamente.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // COEP/COOP richiesti da SharedArrayBuffer (usato dal Trace Viewer Playwright)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Directory di lavoro
// ---------------------------------------------------------------------------

/** Volume condiviso con l'host — solo per ispezione manuale dei .spec.ts */
const TESTS_DIR = '/shared/tests';

/** Volume condiviso con l'host — per i risultati JSON */
const RESULTS_DIR = '/shared/results';

/**
 * Directory locale al container per l'esecuzione dei test.
 * DEVE essere dentro /app per rispettare testDir in playwright.config.ts.
 * Eseguire test da percorsi fuori da testDir causa "No tests found".
 */
const LOCAL_TEST_DIR = '/app/tests';

/** Directory dei report HTML Playwright — una sottodirectory per testId */
const REPORTS_DIR = '/app/reports';

// Crea le directory necessarie all'avvio del container
fs.mkdirSync(LOCAL_TEST_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Gestione dei server "show-report"
// Invece di servire i report come file statici (che non funziona per il
// Trace Viewer), per ogni run viene avviato un processo `npx playwright show-report`
// su una porta dedicata (9300-9320, con round-robin).
// Il Trace Viewer funziona solo se servito dal CLI ufficiale Playwright.
// ---------------------------------------------------------------------------

/** Mappa testId → porta del server show-report */
const reportServers: Map<string, number> = new Map();

/** Mappa testId → processo show-report (per il graceful shutdown) */
const reportProcs: Map<string, import('child_process').ChildProcess> = new Map();

/** Prossima porta da assegnare (range 9300-9320, esposto in docker-compose) */
let nextPort = 9300;

/**
 * Avvia un server `npx playwright show-report` per il report specificato.
 * Se il server è già in esecuzione per questo testId, restituisce la porta esistente.
 *
 * @param testId   - ID del test run (es. "abc12345-1")
 * @param reportDir - Percorso della directory del report HTML
 * @returns La porta su cui è raggiungibile il Trace Viewer
 */
function startReportServer(testId: string, reportDir: string): number {
  // Evita di avviare duplicati per lo stesso run
  if (reportServers.has(testId)) return reportServers.get(testId)!;

  const port = nextPort++;
  // Round-robin sul range 9300-9320: ricomincia da 9300 dopo aver usato tutte le porte
  if (nextPort > 9320) nextPort = 9300;

  reportServers.set(testId, port);

  /**
   * IMPORTANTE: NO detached:true qui!
   * Se il processo fosse detached, sopravviverebbe al riavvio del container
   * come processo zombie. Docker-proxy manterrebbe le porte 9300-9320 occupate,
   * impedendo al container di riavviarsi correttamente.
   * Senza detached, il processo muore automaticamente quando il container si ferma.
   */
  const proc = spawn(
    'npx',
    ['playwright', 'show-report', reportDir, '--port', String(port), '--host', '0.0.0.0'],
    { cwd: '/app', stdio: 'ignore' } // stdio: ignore = non cattura stdout/stderr del server
  );
  reportProcs.set(testId, proc);

  console.log(`[Executor] Report server for ${testId} started on :${port}`);
  return port;
}

/**
 * Termina tutti i processi show-report in esecuzione.
 * Chiamato automaticamente su SIGTERM/SIGINT per un graceful shutdown.
 */
function shutdownReportServers() {
  for (const [, proc] of reportProcs.entries()) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  reportProcs.clear();
  reportServers.clear();
}

// Gestione graceful shutdown del container Docker
// Docker invia SIGTERM prima di fermare il container, dando tempo di pulire
process.on('SIGTERM', () => { shutdownReportServers(); process.exit(0); });
process.on('SIGINT',  () => { shutdownReportServers(); process.exit(0); });

// ---------------------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------------------

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'executor' }));

/**
 * Serve i file statici dei report (screenshot .png, video .webm, zip trace).
 * Questo è un fallback: il Trace Viewer vero si usa tramite show-report (porte 9300-9320).
 */
app.use('/reports', express.static(REPORTS_DIR));

/**
 * GET /reports-list
 * Restituisce la lista degli ultimi 5 report, ciascuno con il proprio testId
 * e la porta show-report su cui è raggiungibile il Trace Viewer completo.
 *
 * Il frontend polling questo endpoint ogni 15s per aggiornare la sezione Reports.
 * Per ogni report trovato, avvia automaticamente il server show-report se non è
 * già in esecuzione.
 *
 * Risposta: { reports: [{ id: string, port: number }] }
 */
app.get('/reports-list', (_, res) => {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return res.json({ reports: [] });

    // Legge le directory dei report, filtra quelle con index.html (report validi),
    // ordina per data di modifica (più recente prima) e prende le ultime 5
    const dirs = fs.readdirSync(REPORTS_DIR)
      .filter(d => fs.existsSync(path.join(REPORTS_DIR, d, 'index.html')))
      .map(d => {
        const stat = fs.statSync(path.join(REPORTS_DIR, d));
        return { id: d, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime) // più recente prima
      .slice(0, 5);                        // max 5 report visibili

    // Per ogni report, avvia il show-report server se non è già attivo
    const reports = dirs.map(d => {
      const reportDir = path.join(REPORTS_DIR, d.id);
      const port = startReportServer(d.id, reportDir);
      return { id: d.id, port };
    });

    res.json({ reports });
  } catch {
    res.json({ reports: [] });
  }
});

/**
 * POST /execute
 * Esegue un test Playwright e restituisce il risultato.
 *
 * Body atteso:
 *   { code: string, testId: string }
 *
 * - code   : codice TypeScript Playwright generato (o corretto dal Healer)
 * - testId : identificatore unico del run (es. "abc12345-1", dove "-1" è il tentativo)
 *
 * Risposta:
 *   {
 *     success: true,
 *     passed: boolean,        // true se tutti i test sono passati
 *     output: string,         // stdout di npx playwright test
 *     error: string,          // stdout+stderr in caso di fallimento (per il Healer)
 *     results: object|null,   // risultati JSON di Playwright (se disponibili)
 *     reportId: string,       // ID del report HTML generato
 *     reportPort: number      // porta del Trace Viewer per questo run
 *   }
 *
 * FLUSSO INTERNO:
 *   1. Scrive il .spec.ts in /app/tests/ (per l'esecuzione) e /shared/tests/ (per ispezione)
 *   2. Esegue `npx playwright test` in modo ASINCRONO (non blocca l'event loop)
 *   3. Cattura stdout/stderr e il codice di uscita
 *   4. Legge il file JSON dei risultati se esiste
 *   5. Avvia il server show-report per il Trace Viewer
 *   6. Restituisce tutto all'Orchestrator
 */
app.post('/execute', async (req, res) => {
  const { code, testId } = req.body;
  if (!code || !testId) return res.status(400).json({ error: 'code and testId are required' });

  // Percorsi file per questo run
  const localTestFile  = path.join(LOCAL_TEST_DIR, `${testId}.spec.ts`);
  const reportDir      = path.join(REPORTS_DIR, testId);
  const jsonResultsDir = path.join(RESULTS_DIR, testId);

  // Crea tutte le directory necessarie (recursive evita errori se già esistono)
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(jsonResultsDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });

  // Scrive il codice nel path locale (per l'esecuzione Playwright)
  fs.writeFileSync(localTestFile, code);

  // Copia anche nel volume condiviso (per ispezione manuale dall'host)
  fs.mkdirSync(TESTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TESTS_DIR, `${testId}.spec.ts`), code);

  console.log(`[Executor] Running test: ${testId}`);

  // Variabili d'ambiente per Playwright:
  // - PLAYWRIGHT_JSON_OUTPUT_NAME: dove salvare il file JSON dei risultati
  // - PLAYWRIGHT_HTML_REPORT: dove salvare il report HTML interattivo
  const env = {
    ...process.env,
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(jsonResultsDir, 'results.json'),
    PLAYWRIGHT_HTML_REPORT: reportDir,
  };

  /**
   * Esecuzione ASINCRONA del test con spawn (non execSync).
   * execSync blocca l'event loop di Node.js: durante l'esecuzione del test
   * (60-120s) tutti gli altri endpoint (/health, /reports-list) sarebbero
   * irraggiungibili. spawn con Promise mantiene il server responsivo.
   */
  const { passed, output, fullError } = await new Promise<{
    passed: boolean;
    output: string;
    fullError: string;
  }>((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(
      'npx',
      ['playwright', 'test', localTestFile, '--reporter=json,html'],
      {
        cwd: '/app',  // directory con playwright.config.ts
        env,
        timeout: 120000, // 2 minuti: timeout massimo per il processo Playwright
      }
    );

    // Accumula stdout e stderr in stringhe
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        // Exit code 0 = tutti i test passati
        console.log(`[Executor] Test PASSED: ${testId}`);
        resolve({ passed: true, output: stdout, fullError: '' });
      } else {
        // Exit code != 0 = almeno un test fallito
        // fullError contiene sia stdout che stderr per dare al Healer il massimo contesto
        console.log(`[Executor] Test FAILED: ${testId}`);
        resolve({ passed: false, output: stdout, fullError: `${stdout}\n${stderr}`.trim() });
      }
    });

    proc.on('error', (err) => {
      // Errore nel processo stesso (es. npx non trovato, permessi mancanti)
      console.log(`[Executor] Test ERROR: ${testId} - ${err.message}`);
      resolve({ passed: false, output: '', fullError: err.message });
    });
  });

  // Legge il file JSON dei risultati Playwright (se generato con successo)
  // Contiene statistiche dettagliate: test totali, passati, falliti, durata, ecc.
  let results = null;
  try {
    const jsonPath = path.join(jsonResultsDir, 'results.json');
    if (fs.existsSync(jsonPath)) {
      results = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    }
  } catch { /* ignora errori di parsing — results rimane null */ }

  // Avvia il server show-report per il Trace Viewer e ottieni la porta
  const reportPort = startReportServer(testId, reportDir);

  res.json({
    success: true,
    passed,
    output,           // stdout del run (usato dal frontend per il log)
    error: fullError, // stdout+stderr completi (passati al Healer in caso di fallimento)
    results,          // JSON strutturato dei risultati Playwright
    reportId: testId, // ID per identificare questo report nella lista
    reportPort,       // porta del Trace Viewer: http://<host>:<reportPort>
  });
});

app.listen(3004, () => console.log('[Executor] Running on :3004'));
