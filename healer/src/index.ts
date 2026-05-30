/**
 * ============================================================
 * HEALER — Agente di auto-correzione
 * ============================================================
 * Quarto e ultimo agente della pipeline. Interviene solo quando
 * il test generato dal Generator fallisce nell'Executor.
 *
 * Riceve il codice fallito + il messaggio di errore di Playwright
 * e usa l'LLM per produrre una versione corretta del test.
 *
 * Il processo di healing può ripetersi fino a MAX_HEAL_ATTEMPTS
 * volte (configurato nell'Orchestrator, default 3).
 *
 * Strategie di correzione principali:
 *   - Sostituire selettori CSS fragili con getByRole/getByText
 *   - Usare toBeAttached() per elementi fuori viewport
 *   - Aggiungere .first() per gestire duplicati (menu mobile/desktop)
 *   - Aggiungere waitForLoadState dopo i goto
 *   - Evitare selettori href-based (cambiabili da CMS/router)
 *
 * Endpoint esposti:
 *   POST /heal   → corregge il codice fallito
 *   GET  /health → health check
 *
 * Porta interna: 3003 | Porta esterna su PiNas: 13003
 * ============================================================
 */

import express from 'express';
import { callLLM } from './llm';

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS — necessario per i health check dal frontend
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'healer' }));

/**
 * POST /heal
 * Analizza il codice fallito e l'errore, poi genera una versione corretta.
 *
 * Body atteso:
 *   { code: string, error: string, plan: TestPlan, model?: string }
 *
 * - code  : il codice TypeScript Playwright che ha fallito
 * - error : l'output completo dell'errore di Playwright (stdout + stderr)
 * - plan  : il piano originale, per mantenere il contesto degli obiettivi del test
 * - model : modello Gemini da usare (opzionale)
 *
 * Risposta:
 *   { success: true, code: string } — codice corretto pronto per un nuovo tentativo
 *
 * LIMITAZIONE NOTA: il Healer non ha accesso al DOM della pagina. Se il test
 * fallisce per un selettore che non esiste in DOM, il Healer deve indovinare
 * basandosi solo sull'errore. In questi casi può essere necessario modificare
 * il prompt originale per usare il testo esatto degli elementi della pagina.
 */
app.post('/heal', async (req, res) => {
  const { code, error, plan } = req.body;

  // Entrambi i campi sono obbligatori — senza l'errore non c'è nulla da correggere
  if (!code || !error) {
    return res.status(400).json({ error: 'code and error are required' });
  }

  try {
    // Log dei primi 100 caratteri dell'errore per debugging nei container logs
    console.log(`[Healer] Fixing error: ${error.substring(0, 100)}...`);

    // Il prompt include: piano originale (contesto), codice fallito, errore specifico,
    // e una lista di fix comuni ordinati per frequenza di occorrenza.
    let fixedCode = await callLLM(`You are a Playwright test healer agent.
The following test code failed. Fix it so it passes.

ORIGINAL PLAN:
${JSON.stringify(plan, null, 2)}

FAILED CODE:
${code}

ERROR:
${error}

Common fixes:
- Prefer page.getByRole() or page.getByText() over attribute selectors
- Use { exact: false } for text matching to handle partial matches
- Replace toBeVisible() with toBeAttached() for off-screen elements
- Add await page.waitForLoadState('domcontentloaded') after goto
- Use first() to handle multiple matching elements
- Avoid href-based selectors — use text content instead
- If an element is in the DOM but not visible, use toBeAttached() instead of toBeVisible()

Return ONLY the fixed TypeScript code, no explanation, no markdown fences.`);

    // Rimozione delle eventuali markdown fences dalla risposta del modello
    fixedCode = fixedCode
      .replace(/^```typescript\n?/, '')
      .replace(/^```ts\n?/, '')
      .replace(/^```\n?/, '')
      .replace(/```$/, '')
      .trim();

    console.log(`[Healer] Code fixed (${fixedCode.length} chars)`);
    res.json({ success: true, code: fixedCode });

  } catch (error: any) {
    console.error('[Healer] Error:', (error as any).message);
    res.status(500).json({ error: (error as any).message });
  }
});

app.listen(3003, () => console.log('[Healer] Running on :3003'));
