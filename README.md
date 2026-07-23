# Playwright AI Agents — Multi-Container Architecture

![CI](https://github.com/Shinigallo/playwright-agents/actions/workflows/ci.yml/badge.svg)

— Multi-Container Architecture

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
# Configura il provider LLM nel .env (vedi "Provider LLM" sotto)

docker compose up --build
```

## Provider LLM

Tutti i servizi (planner, generator, healer) condividono la stessa
configurazione LLM tramite il modulo `services/shared/gemini-proxy.ts`.
Il provider si sceglie con `LLM_PROVIDER` nel `.env`.

### Gemini (default)

```env
LLM_PROVIDER=gemini
GEMINI_API_KEYS=key-1, key-2, key-3   # rotazione automatica su quota esaurita
MODEL=gemini-2.0-flash
```

### OpenAI-compatible / provider locale

Funziona con qualsiasi endpoint OpenAI-compatible: **Ollama, LM Studio,
vLLM, LocalAI** o la stessa API OpenAI. Così puoi far girare tutto in
locale senza chiamare servizi esterni.

```env
LLM_PROVIDER=openai
OPENAI_API_BASE_URL=http://host.docker.internal:11434/v1   # es. Ollama (deve finire con /v1)
OPENAI_API_MODEL=llama3.1
OPENAI_API_KEYS=                                           # opzionale per server locali
```

> Dai container Docker usa `host.docker.internal` (non `localhost`) per
> raggiungere un provider in esecuzione sulla macchina host.

Il provider e il modello si possono anche scegliere **per singola richiesta**
dal frontend, o passando `provider` / `model` / `openaiBaseURL` nel body di `POST /run`.

## Modalità SAP (UI5 / Fiori / WebGUI)

Per testare applicazioni SAP il sistema usa [playwright-sap](https://playwright-sap.dev/),
installato nell'executor come alias di `@playwright/test`. Il generator produce
locator SAP-aware (`page.getByRoleUI5`, `page.locateUI5`, `page.locateSID`,
`page.SAPLogin`) invece dei fragili selettori DOM.

La modalità SAP si attiva automaticamente quando l'URL o il prompt contengono
pattern SAP (`*.sap.*`, `fiori`, `s4`, `ui5`, `webgui`) oppure quando vengono
fornite credenziali SAP. Le credenziali sono opzionali:

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Apri l'\''app Manage Sales Orders e verifica la lista",
    "baseUrl": "https://my-fiori-launchpad.example/sap/bc/ui5",
    "sapUsername": "TESTUSER",
    "sapPassword": "••••••"
  }'
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
