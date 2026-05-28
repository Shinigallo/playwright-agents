import express from 'express';
import { callLLM } from './llm';

const app = express();
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'planner' }));

app.post('/plan', async (req, res) => {
  const { prompt, baseUrl } = req.body;
  if (!prompt || !baseUrl) return res.status(400).json({ error: 'prompt and baseUrl are required' });

  try {
    console.log(`[Planner] Analyzing: "${prompt}"`);

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

    const plan = JSON.parse(raw.replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/```$/, '').trim());
    console.log(`[Planner] Plan created with ${plan.steps?.length} steps`);
    res.json({ success: true, plan });

  } catch (error: any) {
    console.error('[Planner] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => console.log('[Planner] Running on :3001'));
