/**
 * ============================================================
 * LLM Helper — Wrapper per le chiamate LLM via Proxy
 * ============================================================
 * Wrapper per healer: supporta Gemini e API OpenAI-compatible
 * (Ollama, LM Studio, OpenAI, opencode, Azure, etc.)
 *
 * Il provider e il modello vengono passati dal caller (orchestrator)
 * e trasmessi al proxy centrale che gestisce:
 *   - Sicurezza chiave API (non esposta ai servizi)
 *   - Rate limiting e retry
 *   - Logging centralizzato
 * ============================================================
 */

import { callLLM as callLLMProxy } from '../../shared/gemini-proxy';

/**
 * Invia un prompt al LLM via proxy e restituisce la risposta testuale.
 *
 * @param prompt - Il testo del prompt da inviare al modello
 * @param model - Modello da usare (opzionale, usa default dal proxy)
 * @returns La risposta testuale del modello
 * @throws Errore proxy se la chiamata fallisce
 */
export async function callLLM(prompt: string, model?: string): Promise<string> {
  return callLLMProxy(prompt, 'healer', model);
}
