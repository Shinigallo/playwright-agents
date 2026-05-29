import express from 'express';
import { callLLM } from './llm';

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'generator' }));

app.post('/generate', async (req, res) => {
  const { plan, baseUrl: explicitBaseUrl, previousError } = req.body;
  if (!plan) return res.status(400).json({ error: 'plan is required' });
  const targetBaseUrl = explicitBaseUrl || plan.baseUrl || '';

  const errorContext = previousError
    ? `\n\nPrevious attempt failed:\n${previousError}\nFix the issue in the new code.`
    : '';

  try {
    console.log(`[Generator] Generating test for: "${plan.title}"`);

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

    code = code.replace(/^```typescript\n?/, '').replace(/^```ts\n?/, '').replace(/^```\n?/, '').replace(/```$/, '').trim();
    console.log(`[Generator] Code generated (${code.length} chars)`);
    res.json({ success: true, code });

  } catch (error: any) {
    console.error('[Generator] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3002, () => console.log('[Generator] Running on :3002'));
