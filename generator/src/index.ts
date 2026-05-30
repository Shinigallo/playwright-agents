/**
 * ============================================================
 * GENERATOR — Agente di generazione codice
 * ============================================================
 * Secondo agente della pipeline. Riceve il piano JSON strutturato
 * prodotto dal Planner e lo trasforma in codice TypeScript
 * Playwright completo e pronto per essere eseguito.
 *
 * Il codice generato:
 *   - Usa @playwright/test come framework di test
 *   - Segue le best practice Playwright per selettori robusti
 *   - Include timeout adeguati per evitare flakiness
 *   - Usa l'URL base esatto passato dall'utente
 *
 * Endpoint esposti:
 *   POST /generate → genera il codice TypeScript
 *   GET  /health   → health check
 *
 * Porta interna: 3002 | Porta esterna su PiNas: 13002
 * ============================================================
 */

import express from 'express';
import { callLLM } from './llm';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS — necessario per i health check dal frontend (cross-origin)
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'generator' }));

/**
 * POST /generate
 * Genera codice TypeScript Playwright a partire dal piano strutturato.
 *
 * Body atteso:
 *   { plan: TestPlan, baseUrl?: string, model?: string, previousError?: string }
 *
 * - plan          : piano JSON prodotto dal Planner
 * - baseUrl       : URL base esplicito (priorità su plan.baseUrl)
 * - model         : modello Gemini da usare (opzionale)
 * - previousError : errore del tentativo precedente (usato dal Healer come fallback)
 *
 * Risposta:
 *   { success: true, code: string } — codice TypeScript pronto per l'esecuzione
 *
 * NOTA su baseUrl: viene passato sia nell'oggetto plan che come campo esplicito.
 * Il campo esplicito ha priorità per garantire che l'URL dell'utente non venga
 * mai sovrascritto o ignorato dall'LLM (vedi pitfall nel skill).
 */
app.post('/generate', async (req, res) => {
  const { plan, baseUrl: explicitBaseUrl, previousError } = req.body;

  if (!plan) return res.status(400).json({ error: 'plan is required' });

  // Determina l'URL base da usare: esplicito dall'orchestrator > nel piano > vuoto
  const targetBaseUrl = explicitBaseUrl || plan.baseUrl || '';

  // Se viene passato un errore precedente, viene incluso nel prompt come contesto
  // aggiuntivo per guidare il modello a evitare lo stesso pattern sbagliato
  const errorContext = previousError
    ? `\n\nPrevious attempt failed:\n${previousError}\nFix the issue in the new code.`
    : '';

  try {
    console.log(`[Generator] Generating test for: "${plan.title}"`);

    // Il prompt include il piano completo in JSON e regole precise per la generazione.
    // Le regole sono fondamentali per ridurre i fallimenti al primo tentativo:
    //   - getByRole/getByText invece di selettori CSS (più robusti ai cambi di stile)
    //   - toBeAttached() per elementi fuori viewport (evita timeout su nav mobile)
    //   - .first() per elementi duplicati (es. link nel menu desktop e mobile)
    //   - domcontentloaded invece di load per pagine pesanti
    let code = await callLLM(`You are a Playwright test code generator.
Generate a complete, runnable Playwright TypeScript test based on this plan:

${JSON.stringify(plan, null, 2)}
${errorContext}

Rules:
- Use @playwright/test imports
- The base URL is "${targetBaseUrl}" — ALWAYS use this URL in page.goto() calls, never invent or change it
- Use page.getByRole() or page.getByText() — avoid CSS/href selectors
- Use { exact: false } for text matching to be more resilient
- Use toBeAttached() instead of toBeVisible() for elements that may be off-screen
- Use .first() when multiple elements might match
- Use waitUntil: 'domcontentloaded' in page.goto()
- Add reasonable timeouts (30000ms for goto, 10000ms for assertions)
- Return ONLY the TypeScript code, no explanation, no markdown fences.`);

    // Pulizia: rimuove eventuali markdown fences che Gemini aggiunge nonostante
    // le istruzioni esplicite nel prompt ("Return ONLY the TypeScript code")
    code = code
      .replace(/^```typescript\n?/, '')
      .replace(/^```ts\n?/, '')
      .replace(/^```\n?/, '')
      .replace(/```$/, '')
      .trim();

    console.log(`[Generator] Code generated (${code.length} chars)`);
    res.json({ success: true, code });

  } catch (error: any) {
    console.error('[Generator] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3002, () => console.log('[Generator] Running on :3002'));
