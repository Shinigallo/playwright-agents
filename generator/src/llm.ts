/**
 * ============================================================
 * LLM Helper — Wrapper per le chiamate all'API Gemini
 * ============================================================
 * Copia identica al planner/src/llm.ts.
 * Ogni servizio ha la propria copia per poter essere configurato
 * indipendentemente in futuro (es. usare modelli diversi per
 * planning vs generazione di codice).
 *
 * Modello selezionabile via variabile d'ambiente MODEL:
 *   - gemini-2.0-flash  (default — veloce e poco costoso)
 *   - gemini-2.5-pro    (più potente, più lento)
 *   - gemini-3.0-ultra  (massima capacità)
 * ============================================================
 */

import axios from 'axios';

/** Chiave API Gemini, obbligatoria. Impostata in docker-compose.yml o .env */
const GEMINI_API_KEY = (process['env']['GEMINI_API_KEY'] as string) || '';

/**
 * Modello Gemini da usare per la generazione di codice.
 * Cambiabile a runtime via env MODEL senza rebuilding.
 */
const MODEL = (process['env']['MODEL'] as string) || 'gemini-2.0-flash';

/**
 * Invia un prompt all'API Gemini e restituisce la risposta testuale.
 *
 * @param prompt - Il testo del prompt da inviare (include piano JSON + regole)
 * @returns Il codice TypeScript generato (o JSON a seconda del chiamante)
 */
export async function callLLM(prompt: string): Promise<string> {
  // URL costruito per concatenazione per evitare problemi con i template literal
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + MODEL
    + ':generateContent?key='
    + GEMINI_API_KEY;

  const response = await axios.post(
    url,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,       // bassa temperatura = codice coerente e meno "creativo"
        maxOutputTokens: 4096,  // sufficiente per test Playwright completi con più test case
      },
    }
  );

  return response.data.candidates[0].content.parts[0].text as string;
}
