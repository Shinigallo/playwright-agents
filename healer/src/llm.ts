/**
 * ============================================================
 * LLM Helper — Wrapper per le chiamate all'API Gemini (Healer)
 * ============================================================
 * Copia identica agli altri servizi. Il Healer usa la stessa
 * configurazione (temperature bassa) perché la correzione del
 * codice richiede precisione, non creatività.
 *
 * Modello selezionabile via variabile d'ambiente MODEL.
 * ============================================================
 */

import axios from 'axios';

const GEMINI_API_KEY=*** || '';
const MODEL = process.env.MODEL || 'gemini-2.0-flash';

/**
 * Invia un prompt all'API Gemini e restituisce la risposta testuale.
 * Usato dal Healer per generare versioni corrette del codice fallito.
 */
export async function callLLM(prompt: string): Promise<string> {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=***    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,       // determinismo alto: vogliamo fix affidabili, non varianti
        maxOutputTokens: 4096,
      },
    }
  );

  return response.data.candidates[0].content.parts[0].text as string;
}
