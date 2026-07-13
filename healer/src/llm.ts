/**
 * ============================================================
 * LLM Helper — Wrapper per le chiamate all'API Gemini via Proxy
 * ============================================================
 * Questo modulo centralizza tutta la logica di comunicazione
 * con l'API Google Gemini. Ogni microservizio (Planner, Generator,
 * Healer) usa questo wrapper per passare le chiamate al proxy
 * che gestisce:
 *   - Sicurezza chiave API (non esposta ai servizi)
 *   - Rate limiting e retry
 *   - Logging centralizzato
 *
 * Modello selezionabile via variabile d'ambiente MODEL:
 *   - gemini-2.0-flash  (default — veloce e poco costoso)
 *   - gemini-2.5-pro    (più potente, più lento)
 *   - gemini-3.0-ultra  (massima capacità)
 *
 * Parametri di generazione:
 *   - temperature: 0.2 — output deterministico, ideale per codice
 *   - maxOutputTokens: 4096 — sufficiente per test Playwright completi
 * ============================================================
 */

import { callLLM } from '../../shared/gemini-proxy';

/**
 * Invia un prompt all'API Gemini via proxy e restituisce la risposta testuale.
 *
 * @param prompt - Il testo del prompt da inviare al modello
 * @returns La risposta testuale del modello
 * @throws Errore proxy se la chiamata fallisce
 */
export async function callLLM(prompt: string): Promise<string> {
  return callLLM(prompt, 'healer');
}
