/**
 * ============================================================
 * PLANNER — Agente di pianificazione
 * ============================================================
 * Primo agente della pipeline. Riceve un prompt in linguaggio
 * naturale e produce un piano di test strutturato in formato JSON.
 *
 * Il piano raggruppa le azioni in TEST CASE distinti:
 * ogni test case ha un nome descrittivo e la propria lista di step.
 * Questa struttura permette al Generator di produrre una suite
 * completa con test.describe() e più test() block, invece di
 * un singolo test monolitico.
 *
 * Struttura del piano prodotto:
 * {
 *   title: string,       // nome della suite (test.describe)
 *   baseUrl: string,
 *   tests: [{
 *     name: string,      // nome del singolo test case (test(...))
 *     steps: [{
 *       id, action, description, selector?, value?, assertion?
 *     }]
 *   }]
 * }
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
 * Analizza il prompt utente e genera un piano di suite di test.
 *
 * Body: { prompt: string, baseUrl: string, model?: string }
 *
 * Risposta: { success: true, plan: TestSuitePlan }
 *
 * Il piano contiene un array "tests" con più test case indipendenti.
 * Ogni test case ha un proprio nome (usato come titolo del test Playwright)
 * e una lista di step da eseguire in sequenza.
 */
app.post('/plan', async (req, res) => {
  const { prompt, baseUrl } = req.body;
  if (!prompt || !baseUrl) return res.status(400).json({ error: 'prompt and baseUrl are required' });

  try {
    console.log(`[Planner] Analyzing: "${prompt}"`);

    const raw = await callLLM(`You are a Playwright test planning agent.
Given this user request: "${prompt}"
And this base URL: "${baseUrl}"

Create a complete test SUITE plan as JSON. The suite must contain MULTIPLE independent test cases.
Each test case covers a distinct scenario or aspect of the request.

Use this exact format:
{
  "title": "Suite title for test.describe()",
  "baseUrl": "${baseUrl}",
  "tests": [
    {
      "name": "should <do something specific>",
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
  ]
}

Rules:
- Create at least 3 independent test cases covering different aspects
- Each test case must start with a navigate step to ensure isolation
- Test names must start with "should" and be descriptive
- Return ONLY valid JSON, no explanation, no markdown fences.`);

    // Rimuove eventuali markdown fences residue dalla risposta del modello
    const plan = JSON.parse(
      raw
        .replace(/^```json\n?/, '')
        .replace(/^```\n?/, '')
        .replace(/```$/, '')
        .trim()
    );

    const testCount = plan.tests?.length ?? 0;
    console.log(`[Planner] Suite plan created: "${plan.title}" (${testCount} test cases)`);
    res.json({ success: true, plan });

  } catch (error: any) {
    console.error('[Planner] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => console.log('[Planner] Running on :3001'));
