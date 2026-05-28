# Playwright AI Agents — Multi-Container Architecture

## Architettura

```
POST /run
  │
  ▼
[Orchestrator :3000]
  │
  ├─► [Planner :3001]    — analizza la richiesta, crea un piano
  │
  ├─► [Generator :3002]  — genera il codice TypeScript dal piano
  │
  ├─► [Executor :3004]   — esegue i test con Playwright
  │       │
  │       └─► fail? ──► [Healer :3003] ──► codice corretto ──► Executor
  │
  └─► Risultato finale
```

## Avvio

```bash
cp .env.example .env
# Inserisci la tua ANTHROPIC_API_KEY nel .env

docker compose up --build
```

## Utilizzo

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Test the login flow with valid credentials",
    "baseUrl": "https://example.com"
  }'
```

## Risposta

```json
{
  "testId": "abc12345",
  "passed": true,
  "plan": { "title": "...", "steps": [...] },
  "finalCode": "import { test } from ...",
  "log": ["[abc12345] Step 1/4: Planning...", "..."],
  "error": null
}
```

## Health check

```bash
curl http://localhost:3000/health  # orchestrator
curl http://localhost:3001/health  # planner
curl http://localhost:3002/health  # generator
curl http://localhost:3003/health  # healer
curl http://localhost:3004/health  # executor
```
