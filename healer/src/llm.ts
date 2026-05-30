/**
 * LLM Helper — Wrapper per le chiamate all'API Gemini.
 * Ogni servizio ha la propria copia per configurazioni indipendenti.
 */

import axios from 'axios';

// Legge la chiave API dall'ambiente Docker (impostata in .env / docker-compose.yml)
const API_KEY = (process as any).env['GEMINI_API_KEY'] as string || '';
const MODEL = (process as any).env['MODEL'] as string || 'gemini-2.0-flash';

/**
 * Invia un prompt all'API Gemini e restituisce la risposta testuale.
 * @param prompt - Il testo del prompt da inviare
 */
export async function callLLM(prompt: string): Promise<string> {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + MODEL
    + ':generateContent?key='
    + API_KEY;

  const response = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
  });

  return response.data.candidates[0].content.parts[0].text as string;
}
