/**
 * ============================================================
 * LLM Helper — Wrapper per le chiamate all'API Gemini
 * ============================================================
 * Questo modulo centralizza tutta la logica di comunicazione
 * con l'API Google Gemini. Ogni microservizio (Planner, Generator,
 * Healer) ha la propria copia di questo file per poter usare
 * modelli o configurazioni diverse in futuro, se necessario.
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

import axios from 'axios';

/** Chiave API Gemini, obbligatoria. Impostata in docker-compose.yml o .env */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

/**
 * Modello Gemini da usare.
 * Cambiabile a runtime via variabile d'ambiente MODEL senza rebuilding.
 * Esempio: MODEL=gemini-2.5-pro docker compose up
 */
const MODEL = process.env.MODEL || 'gemini-2.0-flash';

/**
 * Invia un prompt all'API Gemini e restituisce la risposta testuale.
 *
 * @param prompt - Il testo del prompt da inviare al modello
 * @returns La risposta testuale del modello (il testo del primo candidato)
 * @throws Errore axios se la chiamata API fallisce (rate limit, chiave non valida, ecc.)
 */
export async function callLLM(prompt: string): Promise<string> {
  const response = await axios.post(
    // URL dell'API Gemini con il modello selezionato e la chiave API come query param
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      // Formato richiesto dall'API Gemini v1beta: array di "contents" con "parts"
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,       // bassa temperatura = output coerente e ripetibile
        maxOutputTokens: 4096,  // massimo output: sufficiente per un test completo
      },
    }
  );

  // Estrae il testo dalla struttura di risposta annidata dell'API Gemini:
  // response.data.candidates[0].content.parts[0].text
  return response.data.candidates[0].content.parts[0].text as string;
}
