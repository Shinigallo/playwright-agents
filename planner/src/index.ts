/**
 * ============================================================
 * PLANNER — Agente di pianificazione
 * ============================================================
 * Primo agente della pipeline. Riceve un prompt in linguaggio
 * naturale (es. "Testa il login con credenziali valide") e
 * produce un piano di test strutturato in formato JSON.
 *
 * Il piano descrive ogni azione da compiere: navigare a una
 * pagina, cliccare un elemento, compilare un campo, asserire
 * un risultato, ecc.
 *
 * Questo piano viene poi passato al Generator, che lo trasforma
 * in codice TypeScript Playwright eseguibile.
 *
 * Endpoint esposti:
 *   POST /plan   → genera il piano JSON
 *   GET  /health → health check
 *
 * Porta interna: 3001 | Porta esterna su PiNas: 13001
 * ============================================================
 */

import express from 'express';
import { callLLM } from './llm';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS — anche questo servizio è chiamato direttamente dal frontend
// per i health check, quindi necessita degli header CORS.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'planner' }));

/**
 * POST /plan
 * Analizza il prompt utente e genera un piano di test strutturato.
 *
 * Body atteso:
 *   { prompt: string, baseUrl: string, model?: string }
 *
 * Risposta:
 *   { success: true, plan: TestPlan }
 *
 * Struttura del piano generato:
 * {
 *   title: string,          // titolo descrittivo del test
 *   baseUrl: string,        // URL del sito da testare
 *   steps: [{
 *     id: number,
 *     action: "navigate|click|fill|assert|wait",
 *     description: string,  // spiegazione leggibile dello step
 *     selector?: string,    // selettore CSS o testo dell'elemento
 *     value?: string,       // valore da inserire (per fill)
 *     assertion?: string    // cosa verificare (per assert)
 *   }]
 * }
 */
app.post('/plan', async (req, res) => {
  const { prompt, baseUrl } = req.body;

  // Entrambi i parametri sono obbligatori per costruire un piano valido
  if (!prompt || !baseUrl) {
    return res.status(400).json({ error: 'prompt and baseUrl are required' });
  }

  try {
    console.log(`[Planner] Analyzing: "${prompt}"`);

    // Costruisce il prompt per l'LLM specificando esattamente il formato JSON atteso.
    // Il modello deve restituire SOLO JSON valido, senza markdown o spiegazioni,
    // per poter fare il parse direttamente senza preprocessing.
    const raw = await callLLM(`You are a Playwright test planning agent.
Given this user request: "${prompt}"
And this base URL: "${baseUrl}"

Create a detailed, structured test plan as JSON with this format:
{
  "title": "test suite title",
  "baseUrl": "${baseUrl}",
  "steps": [
    {
      "id": 1,
      "action": "navigate | click | fill | assert | wait",
      "description": "human readable description",
      "selector": "CSS or text selector (if applicable)",
      "value": "input value (if applicable)",
      "assertion": "what to assert (if applicable)"
    }
  ]
}

Return ONLY valid JSON, no explanation, no markdown fences.`);

    // Pulizia dell'output: i modelli Gemini a volte wrappano la risposta
    // in markdown fences (```json ... ```) nonostante le istruzioni.
    // Questo regex rimuove eventuali fence residue prima del parse.
    const plan = JSON.parse(
      raw
        .replace(/^```json\n?/, '')
        .replace(/^```\n?/, '')
        .replace(/```$/, '')
        .trim()
    );

    console.log(`[Planner] Plan created with ${plan.steps?.length} steps`);
    res.json({ success: true, plan });

  } catch (error: any) {
    console.error('[Planner] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => console.log('[Planner] Running on :3001'));
