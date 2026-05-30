/**
 * ============================================================
 * GENERATOR — Agente di generazione suite di test
 * ============================================================
 * Secondo agente della pipeline. Riceve il piano JSON strutturato
 * prodotto dal Planner e lo trasforma in una suite TypeScript
 * Playwright completa con:
 *   - Un blocco test.describe() per l'intera suite
 *   - Un blocco test() per ogni test case nel piano
 *   - Ogni test è indipendente (naviga da zero, nessuno stato condiviso)
 *
 * Endpoint esposti:
 *   POST /generate → genera il file TypeScript della suite
 *   GET  /health   → health check
 *
 * Porta interna: 3002 | Porta esterna su PiNas: 13002
 * ============================================================
 */

import express from 'express';
import { callLLM } from './llm';

const app = express();
app.use(express.json());

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
 * Genera una suite TypeScript Playwright a partire dal piano strutturato.
 *
 * Body: { plan: TestSuitePlan, baseUrl?: string, model?: string }
 *
 * Risposta: { success: true, code: string }
 * Il codice contiene un test.describe() con N test() block,
 * uno per ogni test case nel piano.
 */
app.post('/generate', async (req, res) => {
  const { plan, baseUrl: explicitBaseUrl } = req.body;
  if (!plan) return res.status(400).json({ error: 'plan is required' });

  // L'URL esplicito ha priorità su quello nel piano per sicurezza
  const targetBaseUrl = explicitBaseUrl || plan.baseUrl || '';

  try {
    console.log(`[Generator] Generating suite for: "${plan.title}" (${plan.tests?.length ?? 0} tests)`);

    let code = await callLLM(`You are a Playwright test code generator.
Generate a complete TypeScript Playwright TEST SUITE based on this plan:

${JSON.stringify(plan, null, 2)}

REQUIRED STRUCTURE — use exactly this pattern:
\`\`\`
import { test, expect } from '@playwright/test';

test.describe('<suite title>', () => {
  test('should ...', async ({ page }) => {
    // steps for test case 1
  });

  test('should ...', async ({ page }) => {
    // steps for test case 2
  });

  // one test() block per test case in the plan
});
\`\`\`

Rules:
- ONE test.describe() block wrapping ALL tests
- ONE test() block per test case — do NOT merge them into a single test
- Each test() must be fully independent: always start with page.goto()
- The base URL is "${targetBaseUrl}" — ALWAYS use this URL in page.goto(), never invent or change it
- Use page.getByRole() or page.getByText() — avoid CSS/href selectors
- Use { exact: false } for text matching to be more resilient
- Use toBeAttached() instead of toBeVisible() for elements that may be off-screen
- Use .first() when multiple elements might match
- Use waitUntil: 'domcontentloaded' in page.goto()
- Add reasonable timeouts (30000ms for goto, 10000ms for assertions)
- Return ONLY the TypeScript code, no explanation, no markdown fences.`);

    // Rimuove eventuali markdown fences dalla risposta Gemini
    code = code
      .replace(/^```typescript\n?/, '')
      .replace(/^```ts\n?/, '')
      .replace(/^```\n?/, '')
      .replace(/```$/, '')
      .trim();

    console.log(`[Generator] Suite generated (${code.length} chars)`);
    res.json({ success: true, code });

  } catch (error: any) {
    console.error('[Generator] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3002, () => console.log('[Generator] Running on :3002'));
