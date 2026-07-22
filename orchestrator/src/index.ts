/**
 * ============================================================
 * ORCHESTRATOR — Cervello del sistema
 * ============================================================
 * Questo servizio è il punto di ingresso principale dell'intero
 * pipeline di test AI. Riceve una richiesta dall'utente (prompt +
 * URL) e coordina in sequenza:
 *
 *   1. Planner  → analizza il prompt e produce un piano JSON strutturato
 *   2. Generator → traduce il piano in codice TypeScript Playwright
 *   3. Executor  → esegue il test in un browser headless reale
 *   4. Healer   → se il test fallisce, corregge il codice (loop)
 *
 * Il loop Executor → Healer si ripete fino a MAX_HEAL_ATTEMPTS volte.
 * Se anche dopo tutti i tentativi il test non passa, viene restituito
 * l'errore finale al client.
 *
 * Endpoint esposti:
 *   POST /run    → avvia il pipeline completo
 *   GET  /status → stato live del run in corso (polling dal frontend)
 *   GET  /health → health check
 *
 * Porta interna: 3000 | Porta esterna su PiNas: 3010
 * ============================================================
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Rate limiting — massimo 10 richieste al minuto per IP per /run
// (prevenzione abuso e consumo eccessivo API Gemini)
// ---------------------------------------------------------------------------
const runLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many run requests. Please wait before starting another test.' },
});

// CORS — whitelist di origini consentite (nessuna wildcard con credentials)
const ALLOWED_ORIGINS: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim())
  : ['http://localhost:3000', 'http://localhost:8089', 'http://localhost:80'];

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(a => origin === a);
}

app.use((req, res, next) => {
  if (isAllowedOrigin(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin!);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Credentials: true solo quando l'origine è esplicitamente autorizzata
  if (isAllowedOrigin(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// URL dei microservizi — letti da variabili d'ambiente per poter essere
// sovrascritti in docker-compose.yml senza modificare il codice.
// Di default usano i nomi dei container Docker come hostname (DNS interno).
// ---------------------------------------------------------------------------
const PLANNER_URL   = process.env.PLANNER_URL   || 'http://planner:3001';
const GENERATOR_URL = process.env.GENERATOR_URL || 'http://generator:3002';
const HEALER_URL    = process.env.HEALER_URL    || 'http://healer:3003';
const EXECUTOR_URL  = process.env.EXECUTOR_URL  || 'http://executor:3004';

/**
 * Numero massimo di tentativi di auto-healing.
 * Default: 3. Con 3 tentativi il loop può eseguire il test 4 volte in totale:
 * run iniziale + 3 heal. Configurabile via env MAX_HEAL_ATTEMPTS.
 */
const MAX_HEAL_ATTEMPTS = parseInt(process.env.MAX_HEAL_ATTEMPTS || '3');

// ---------------------------------------------------------------------------
// STATO LIVE DEL RUN — aggiornato in tempo reale durante il pipeline.
// Il frontend fa polling su GET /status ogni ~1.5s per mostrare
// quale agente è attivo, il tentativo corrente e i log in streaming.
// ---------------------------------------------------------------------------

/** Possibili step del pipeline, in ordine di esecuzione. */
interface RunStatus {
  testId: string;
  /** Fase corrente del pipeline */
  step: 'idle' | 'planning' | 'generating' | 'executing' | 'healing' | 'done' | 'error';
  /** Quale microservizio sta lavorando in questo momento */
  activeService: 'planner' | 'generator' | 'executor' | 'healer' | null;
  /** Numero del tentativo di esecuzione corrente (1 = primo, 2 = dopo il primo heal, ecc.) */
  attempt: number;
  /** Log accumulati — ogni stringa è una riga del log visibile nel frontend */
  log: string[];
  /** Disponibile solo al termine: indica se il test è passato */
  passed?: boolean;
  /** Timestamp Unix (ms) di inizio del run */
  startedAt: number;
}

/**
 * Retry con backoff esponenziale.
 * Utilizzato per le chiamate inter-servizio per resistere a riavvii temporanei.
 *
 * @param fn - Funzione async da eseguire
 * @param retries - Numero massimo di retry (default 3)
 * @param initialDelay - Delay iniziale in ms (default 1000)
 * @returns Risultato della funzione
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  initialDelay = 1000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt < retries) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.warn(`[Orchestrator] Retry attempt ${attempt + 1}/${retries} after ${delay}ms: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

/** Stato condiviso — map testId → RunStatus per supportare run paralleli. */
const activeRuns = new Map<string, RunStatus>();
  let nextIdCounter = 0; // Rimosso: non utilizzato, usato uuidv4 per testId

// ---------------------------------------------------------------------------
// HEALTH CHECK — usato dal frontend e da Docker per verificare che il
// container sia vivo e raggiungibile.
// ---------------------------------------------------------------------------
app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'orchestrator' }));

// Applica rate limiting alla rotta /run (10 req/minuto per IP)
app.use('/run', runLimiter);

/**
 * GET /status
 * Restituisce lo stato del run richiesto (o 'idle' se non c'è nulla in corso).
 * Se nessun testId è fornito, restituisce l'ultimo run completato.
 * Il frontend fa polling su questo endpoint ogni 1.5s durante un run per aggiornare
 * la barra di progresso, il log in streaming e l'evidenziazione del servizio attivo.
 */
app.get('/status', (req, res) => {
  const testId = req.query.testId as string;
  if (testId && activeRuns.has(testId)) {
    return res.json(activeRuns.get(testId)!);
  }
  // Se nessun testId fornito, restituisce l'ultimo run attivo
  const entries = Array.from(activeRuns.entries());
  if (entries.length === 0) {
    return res.json({
      testId: '', step: 'idle', activeService: null, attempt: 0,
      log: [], startedAt: 0,
    } satisfies RunStatus);
  }
  const lastEntry = entries[entries.length - 1];
  res.json(lastEntry[1]);
});

/**
 * POST /run
 * Avvia il pipeline completo: Planner → Generator → Executor (→ Healer loop).
 *
 * Body atteso:
 *   { prompt: string, baseUrl: string, model?: string }
 *
 * - prompt  : descrizione in linguaggio naturale del test da generare
 *             es. "Verifica che la homepage carichi e mostri il titolo"
 * - baseUrl : URL del sito da testare (es. "https://example.com")
 * - model   : modello Gemini da usare (opzionale, default gemini-2.0-flash)
 *
 * La risposta è sincrona e arriva solo al termine del pipeline (60-120s).
 * Per feedback in tempo reale usare GET /status in parallelo.
 */
app.post('/run', async (req, res) => {
  const { prompt, baseUrl, model, provider, sapUsername, sapPassword, sapType } = req.body;

  // Validazione input — entrambi i campi sono obbligatori
  if (!prompt || !baseUrl) {
    return res.status(400).json({ error: 'prompt and baseUrl are required' });
  }

  // Validazione protocollo: solo http(s)://
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: `Protocollo non supportato: ${parsed.protocol}. Usa http:// o https://` });
    }
  } catch {
    return res.status(400).json({ error: 'baseUrl deve essere un URL valido (http:// o https://)' });
  }

  // Genera un ID univoco per tracciare questo run
  // nei log di tutti i container e come chiave per i report HTML.
  const testId = uuidv4().substring(0, 8);
  const log: string[] = [];
  const runProvider = provider || process.env.LLM_PROVIDER || 'gemini';
  const runModel = model || process.env.MODEL || 'gemini-2.0-flash';
  const hasSAP = !!(sapUsername && sapPassword);

  // Crea entry nel map per supportare run paralleli
  const run: RunStatus = {
    testId,
    step: 'planning',
    activeService: 'planner',
    attempt: 0,
    log: [],
    startedAt: Date.now(),
  };
  activeRuns.set(testId, run);

  // Pulisce la entry dopo il completamento del run (garbage collection)
  const cleanup = setTimeout(() => activeRuns.delete(testId), 5 * 60 * 1000);

  /**
   * Helper per aggiungere una riga al log e aggiornare lo stato nel map.
   */
  const addLog = (msg: string) => {
    log.push(msg);
    run.log = [...log]; // copia array per evitare reference sharing
  };

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — PLANNING
    // -----------------------------------------------------------------------
    addLog(`[${testId}] Step 1/4: Planning... (provider: ${runProvider}, model: ${runModel})`);
    run.step = 'planning';
    run.activeService = 'planner';

    const planReqBody: any = { prompt, baseUrl, model: runModel, provider: runProvider };
    if (hasSAP) {
      planReqBody.sapUsername = sapUsername;
      planReqBody.sapPassword = sapPassword;
      planReqBody.sapType = sapType || 'auto';
      addLog(`[${testId}] SAP credentials provided — type: ${sapType || 'auto'}`);
    }
    const planResp = await axios.post(`${PLANNER_URL}/plan`, planReqBody, { timeout: 60000 });
    const { plan } = planResp.data;
    // Validazione JSON del piano prima di usarlo (fix #4)
    if (!plan || typeof plan !== 'object' || !plan.title || !Array.isArray(plan.tests)) {
      throw new Error('Piano invalido restituito dal Planner');
    }
    addLog(`[${testId}] Plan: ${plan.title} (${plan.tests.length} test cases)`);

    // -----------------------------------------------------------------------
    // STEP 2 — CODE GENERATION
    // -----------------------------------------------------------------------
    addLog(`[${testId}] Step 2/4: Generating test code...`);
    run.step = 'generating';
    run.activeService = 'generator';

    const genReqBody: any = { plan, baseUrl, model: runModel, provider: runProvider };
    if (hasSAP) {
      genReqBody.sapUsername = sapUsername;
      genReqBody.sapPassword = sapPassword;
    }
    const genResp = await axios.post(`${GENERATOR_URL}/generate`, genReqBody, { timeout: 60000 });
    let code = genResp.data.code;

    // -----------------------------------------------------------------------
    // STEP 3+4 — EXECUTE → HEAL LOOP
    // -----------------------------------------------------------------------
    let passed = false;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS + 1; attempt++) {
      addLog(`[${testId}] Step 3/4: Executing (attempt ${attempt})...`);
      run.step = 'executing';
      run.activeService = 'executor';
      run.attempt = attempt;

      // Retry con backoff esponenziale sulle chiamate inter-servizio (fix #6)
      const execResp = await retryWithBackoff(() =>
        axios.post(`${EXECUTOR_URL}/execute`, {
          code,
          testId: `${testId}-${attempt}`,
        }, { timeout: 180000 }), // 3 minuti per il test Playwright
        3, 1000
      );

      if (execResp.data.passed) {
        passed = true;
        addLog(`[${testId}] ✅ Test PASSED on attempt ${attempt}`);
        break; // Uscita dal loop: test superato
      }

      // Test fallito — salva l'errore per il Healer e il log finale
      lastError = execResp.data.error;
      addLog(`[${testId}] ❌ Test failed: ${lastError.substring(0, 150)}`);

      // Esegui il heal solo se non siamo all'ultimo tentativo consentito
      if (attempt <= MAX_HEAL_ATTEMPTS) {
        addLog(`[${testId}] Step 4/4: Healing (attempt ${attempt}/${MAX_HEAL_ATTEMPTS})...`);
        run.step = 'healing';
        run.activeService = 'healer';

        const healResp = await retryWithBackoff(() =>
          axios.post(`${HEALER_URL}/heal`, {
            code,
            error: lastError,
            plan,
            pageSnapshot: plan.pageSnapshot, // snapshot DOM reale dalla visita del Planner
            model: runModel,
            provider: runProvider,
          }, { timeout: 60000 }),
          3, 1000
        );
        code = healResp.data.code; // il codice corretto diventa input del prossimo tentativo
      }
    }

    // Pipeline completato — aggiorna stato finale
    run.step = 'done';
    run.activeService = null;
    run.passed = passed;
    clearTimeout(cleanup);

    // Restituisce il risultato completo al client
    res.json({
      testId,
      passed,
      plan,         // piano strutturato prodotto dal Planner
      finalCode: code, // codice finale (eventualmente corretto dal Healer)
      log,          // tutti i log dell'esecuzione
      error: passed ? null : lastError, // null se il test è passato
    });

  } catch (err: any) {
    // Errore imprevisto (es. servizio non raggiungibile, timeout di rete)
    console.error('[Orchestrator] Fatal error:', err.message);
    run.step = 'error';
    run.activeService = null;
    clearTimeout(cleanup);
    res.status(500).json({ error: err.message, log });
  }
});

app.listen(3000, () => console.log('[Orchestrator] Running on :3000'));
