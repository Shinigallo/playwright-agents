/**
 * ============================================================
 * PLANNER — Agente di pianificazione basato su DOM reale
 * ============================================================
 * Primo agente della pipeline. Riceve un prompt in linguaggio
 * naturale e una URL, poi:
 *
 *   1. Visita la pagina reale con Playwright (headless Chromium)
 *   2. Estrae gli elementi interattivi visibili dal DOM:
 *      pulsanti, link, input, select, textarea, cookie banner
 *   3. Passa l'elenco elementi + il prompt all'LLM
 *   4. L'LLM pianifica i test case basandosi su ciò che ESISTE
 *      nella pagina, non su supposizioni
 *
 * Questo approccio garantisce che:
 *   - I selettori nel piano corrispondano a elementi reali
 *   - I cookie/GDPR banner vengano rilevati e inclusi nel piano
 *   - I test non falliscano per elementi inesistenti
 *
 * Struttura del piano prodotto:
 * {
 *   title: string,
 *   baseUrl: string,
 *   pageSnapshot: string,   // snapshot testuale degli elementi trovati
 *   tests: [{
 *     name: string,
 *     steps: [{ id, action, description, selector?, value?, assertion? }]
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
import { chromium } from '@playwright/test';
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
 * Visita la pagina con Playwright e restituisce un snapshot testuale
 * degli elementi interattivi visibili nel DOM.
 *
 * Lo snapshot include:
 *   - Pulsanti e link (testo visibile + attributi principali)
 *   - Input, select, textarea (type, placeholder, name)
 *   - Elementi con ruolo "dialog" o "banner" (es. cookie overlay)
 *   - Testo del titolo (h1/h2) per capire il contesto della pagina
 *
 * Il tutto viene passato all'LLM come contesto reale della pagina,
 * così il piano non contiene elementi inventati.
 *
 * @param url URL da visitare
 * @returns snapshot testuale degli elementi trovati
 */
async function snapshotPage(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    // User agent realistico per evitare blocchi anti-bot
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Breve attesa per permettere a JS e overlay (cookie banner) di renderizzarsi
    await page.waitForTimeout(2000);

    // Estrae gli elementi interattivi e semantici rilevanti per la pianificazione
    const snapshot = await page.evaluate(() => {
      const lines: string[] = [];

      // Titolo della pagina
      const title = document.title;
      if (title) lines.push(`PAGE TITLE: ${title}`);

      // Headings principali — danno contesto sulla struttura della pagina
      document.querySelectorAll('h1, h2').forEach(el => {
        const text = el.textContent?.trim();
        if (text) lines.push(`HEADING: ${text}`);
      });

      // Pulsanti — fondamentali per interazioni e cookie banner (max 30)
      let btnCount = 0;
      document.querySelectorAll('button').forEach(el => {
        if (btnCount >= 30) return;
        const text = el.textContent?.trim();
        const type = el.getAttribute('type') || 'button';
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className ? `.${el.className.split(' ')[0]}` : '';
        if (text) lines.push(`BUTTON: "${text}" [type=${type}${id}${cls}]`);
        btnCount++;
      });

      // Link — per navigazione e test di routing (max 50 per non sovraccaricare il payload)
      let linkCount = 0;
      document.querySelectorAll('a').forEach(el => {
        if (linkCount >= 50) return;
        const text = el.textContent?.trim();
        const href = el.getAttribute('href') || '';
        // Ignora link vuoti, ancore pure (#) e javascript:void
        if (text && href && !href.startsWith('javascript') && href !== '#') {
          lines.push(`LINK: "${text}" [href=${href}]`);
          linkCount++;
        }
      });

      // Input — per form testing
      document.querySelectorAll('input').forEach(el => {
        const type = el.getAttribute('type') || 'text';
        const placeholder = el.getAttribute('placeholder') || '';
        const name = el.getAttribute('name') || el.id || '';
        if (type !== 'hidden') {
          lines.push(`INPUT: type=${type} name="${name}" placeholder="${placeholder}"`);
        }
      });

      // Select e textarea
      document.querySelectorAll('select, textarea').forEach(el => {
        const tag = el.tagName.toLowerCase();
        const name = el.getAttribute('name') || el.id || '';
        lines.push(`${tag.toUpperCase()}: name="${name}"`);
      });

      // Dialog/modal e banner — spesso sono i cookie overlay
      document.querySelectorAll('[role="dialog"], [role="banner"], [role="alertdialog"]').forEach(el => {
        const text = el.textContent?.trim().substring(0, 100);
        const role = el.getAttribute('role');
        if (text) lines.push(`OVERLAY [role=${role}]: "${text}..."`);
      });

      // Cerca esplicitamente elementi con testo tipico dei cookie banner
      const cookieKeywords = ['cookie', 'consent', 'accetta', 'accept', 'privacy', 'gdpr'];
      document.querySelectorAll('div, section, aside').forEach(el => {
        const text = el.textContent?.toLowerCase() || '';
        const isCookieBanner = cookieKeywords.some(k => text.includes(k));
        // Solo gli elementi di primo livello (non quelli annidati dentro altri già trovati)
        const isTopLevel = !el.parentElement?.matches('[class*="cookie"], [id*="cookie"], [class*="consent"]');
        if (isCookieBanner && isTopLevel && el.children.length > 0) {
          const preview = el.textContent?.trim().substring(0, 120);
          lines.push(`COOKIE_BANNER: "${preview}..."`);
        }
      });

      return lines.join('\n');
    });

    // Tronca lo snapshot a 3000 caratteri per evitare payload 413 nelle chiamate inter-agente
    return snapshot.length > 3000 ? snapshot.substring(0, 3000) + '\n...[snapshot truncated]' : snapshot;
  } finally {
    // Chiude sempre il browser, anche in caso di errore, per evitare leak di processi
    await browser.close();
  }
}

/**
 * POST /plan
 * Visita la pagina reale, estrae gli elementi DOM e genera un piano di suite.
 *
 * Body: { prompt: string, baseUrl: string, model?: string }
 *
 * Risposta: { success: true, plan: TestSuitePlan }
 */
app.post('/plan', async (req, res) => {
  const { prompt, baseUrl } = req.body;
  if (!prompt || !baseUrl) return res.status(400).json({ error: 'prompt and baseUrl are required' });

  try {
    // Step 1: visita la pagina e ottieni il DOM snapshot reale
    console.log(`[Planner] Visiting page: ${baseUrl}`);
    let pageSnapshot = '';
    try {
      pageSnapshot = await snapshotPage(baseUrl);
      console.log(`[Planner] DOM snapshot: ${pageSnapshot.split('\n').length} elements found`);
    } catch (snapErr: any) {
      // Se la visita fallisce (es. pagina non raggiungibile), continua senza snapshot
      // L'LLM genererà un piano basato solo sul prompt, come prima
      console.warn(`[Planner] Could not visit page: ${snapErr.message}. Planning without DOM snapshot.`);
      pageSnapshot = '(page not reachable — plan based on prompt only)';
    }

    // Step 2: passa snapshot + prompt all'LLM per generare il piano
    console.log(`[Planner] Analyzing: "${prompt}"`);

    const raw = await callLLM(`You are a Playwright test planning agent.
The user wants to test this page: ${baseUrl}

USER REQUEST: "${prompt}"

Here are the ACTUAL elements found on the page (extracted via Playwright DOM inspection):
--- PAGE SNAPSHOT ---
${pageSnapshot}
--- END SNAPSHOT ---

Based on the REAL elements above, create a complete test SUITE plan as JSON.
Use the actual text of buttons, links and inputs from the snapshot — do NOT invent selectors.
If you see a COOKIE_BANNER or a button with text like "Accept", "Accetta", "OK", include a
dismissal step as the FIRST step of EVERY test case, before any other interaction.

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
          "selector": "use exact text from snapshot (if applicable)",
          "value": "input value (if applicable)",
          "assertion": "what to assert (if applicable)"
        }
      ]
    }
  ]
}

Rules:
- Create at least 3 independent test cases covering different aspects
- Each test case MUST start with a navigate step (page isolation)
- If a cookie banner was found, add a click step to dismiss it right after navigate in EVERY test
- Test names must start with "should" and be descriptive
- Base selectors on actual text from the snapshot, not invented CSS classes
- Return ONLY valid JSON, no explanation, no markdown fences.`);

    const plan = JSON.parse(
      raw
        .replace(/^```json\n?/, '')
        .replace(/^```\n?/, '')
        .replace(/```$/, '')
        .trim()
    );

    // Salva lo snapshot nel piano così il Generator e il Healer possono usarlo
    plan.pageSnapshot = pageSnapshot;

    const testCount = plan.tests?.length ?? 0;
    console.log(`[Planner] Suite plan created: "${plan.title}" (${testCount} test cases)`);
    res.json({ success: true, plan });

  } catch (error: any) {
    console.error('[Planner] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => console.log('[Planner] Running on :3001'));
