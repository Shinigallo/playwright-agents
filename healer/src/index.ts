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

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'healer' }));

app.post('/heal', async (req, res) => {
  const { code, error, plan } = req.body;
  if (!code || !error) return res.status(400).json({ error: 'code and error are required' });

  try {
    console.log(`[Healer] Fixing error: ${error.substring(0, 100)}...`);

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

    fixedCode = fixedCode.replace(/^```typescript\n?/, '').replace(/^```ts\n?/, '').replace(/^```\n?/, '').replace(/```$/, '').trim();
    console.log(`[Healer] Code fixed (${fixedCode.length} chars)`);
    res.json({ success: true, code: fixedCode });

  } catch (error: any) {
    console.error('[Healer] Error:', (error as any).message);
    res.status(500).json({ error: (error as any).message });
  }
});

app.listen(3003, () => console.log('[Healer] Running on :3003'));
