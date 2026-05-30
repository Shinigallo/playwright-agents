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
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS — necessario perché il frontend (porta 8089) chiama questo servizio
// direttamente dal browser (cross-origin). Tutte le origini sono accettate
// perché il sistema è deployato su rete locale, non pubblica.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Le preflight OPTIONS devono ricevere 204 subito, senza entrare nelle route
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

/** Stato condiviso a livello di modulo — un solo run alla volta. */
const runStatus: RunStatus = {
  testId: '',
  step: 'idle',
  activeService: null,
  attempt: 0,
  log: [],
  startedAt: 0,
};

// ---------------------------------------------------------------------------
// HEALTH CHECK — usato dal frontend e da Docker per verificare che il
// container sia vivo e raggiungibile.
// ---------------------------------------------------------------------------
app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'orchestrator' }));

/**
 * GET /status
 * Restituisce lo stato live del run corrente (o 'idle' se non c'è nulla in corso).
 * Il frontend fa polling su questo endpoint ogni 1.5s durante un run per aggiornare
 * la barra di progresso, il log in streaming e l'evidenziazione del servizio attivo.
 */
app.get('/status', (_, res) => res.json(runStatus));

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
  const { prompt, baseUrl, model } = req.body;

  // Validazione input — entrambi i campi sono obbligatori
  if (!prompt || !baseUrl) {
    return res.status(400).json({ error: 'prompt and baseUrl are required' });
  }

  // Genera un ID univoco breve (8 caratteri) per tracciare questo run
  // nei log di tutti i container e come chiave per i report HTML.
  const testId = uuidv4().substring(0, 8);
  const log: string[] = [];

  /**
   * Helper per aggiungere una riga al log locale, stampare su console
   * e aggiornare lo stato condiviso (che il frontend legge via /status).
   */
  const addLog = (msg: string) => {
    log.push(msg);
    console.log(msg);
    runStatus.log = [...log]; // copia array per evitare reference sharing
  };

  // Resetta lo stato condiviso per il nuovo run
  Object.assign(runStatus, {
    testId,
    step: 'planning',
    activeService: 'planner',
    attempt: 0,
    log: [],
    passed: undefined,
    startedAt: Date.now(),
  });

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — PLANNING
    // Il Planner riceve il prompt in linguaggio naturale e produce un piano
    // JSON strutturato con titolo, URL e lista di step (navigate/click/fill/assert).
    // -----------------------------------------------------------------------
    addLog(`[${testId}] Step 1/4: Planning...`);
    runStatus.step = 'planning';
    runStatus.activeService = 'planner';

    const planResp = await axios.post(`${PLANNER_URL}/plan`, { prompt, baseUrl, model });
    const { plan } = planResp.data;
    addLog(`[${testId}] Plan: ${plan.title} (${plan.steps.length} steps)`);

    // -----------------------------------------------------------------------
    // STEP 2 — CODE GENERATION
    // Il Generator riceve il piano JSON e genera codice TypeScript Playwright
    // pronto per essere eseguito. baseUrl viene passato esplicitamente per
    // garantire che il codice usi sempre l'URL corretto (vedi pitfall nel skill).
    // -----------------------------------------------------------------------
    addLog(`[${testId}] Step 2/4: Generating test code...`);
    runStatus.step = 'generating';
    runStatus.activeService = 'generator';

    const genResp = await axios.post(`${GENERATOR_URL}/generate`, { plan, baseUrl, model });
    let code = genResp.data.code;

    // -----------------------------------------------------------------------
    // STEP 3+4 — EXECUTE → HEAL LOOP
    // Il test viene eseguito dall'Executor. Se fallisce, il Healer corregge
    // il codice e si ritenta. Il loop si ripete MAX_HEAL_ATTEMPTS volte.
    //
    // Struttura del loop:
    //   attempt 1: esegui → se passa, stop
    //   attempt 1: se fallisce → heal → attempt 2
    //   attempt 2: esegui → se passa, stop
    //   ...fino a MAX_HEAL_ATTEMPTS heal totali
    //
    // Nota: il loop va da 1 a MAX_HEAL_ATTEMPTS+1 incluso, perché l'ultimo
    // tentativo è un'esecuzione senza heal successivo.
    // -----------------------------------------------------------------------
    let passed = false;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS + 1; attempt++) {
      addLog(`[${testId}] Step 3/4: Executing (attempt ${attempt})...`);
      runStatus.step = 'executing';
      runStatus.activeService = 'executor';
      runStatus.attempt = attempt;

      // Aggiunge il numero di tentativo al testId per avere report separati per ogni run
      const execResp = await axios.post(`${EXECUTOR_URL}/execute`, {
        code,
        testId: `${testId}-${attempt}`,
      });

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
        runStatus.step = 'healing';
        runStatus.activeService = 'healer';

        // Il Healer riceve il codice fallito + il messaggio di errore + il piano originale
        // per generare una versione corretta del test
        const healResp = await axios.post(`${HEALER_URL}/heal`, {
          code,
          error: lastError,
          plan,
          model,
        });
        code = healResp.data.code; // il codice corretto diventa input del prossimo tentativo
      }
    }

    // Pipeline completato — aggiorna stato finale
    runStatus.step = 'done';
    runStatus.activeService = null;
    runStatus.passed = passed;

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
    runStatus.step = 'error';
    runStatus.activeService = null;
    res.status(500).json({ error: err.message, log });
  }
});

app.listen(3000, () => console.log('[Orchestrator] Running on :3000'));
