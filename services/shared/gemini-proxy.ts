/**
 * ============================================================
 * GEMINI PROXY — Rotazione chiavi API e rate limiting
 * ============================================================
 * Pattern di rotazione delle chiavi Gemini:
 *   - Supporta N chiavi API configurate in GEMINI_API_KEYS (comma-separated)
 *   - Ruota automaticamente quando si incontra quota ecceduta (429)
 *   - Retry con backoff esponenziale
 *   - Logging centralizzato per debug
 *
 * Uso in ogni servizio:
 *   import { callLLM } from '../../shared/gemini-proxy';
 *   const response = await callLLM(prompt, 'planner');
 */

import axios from 'axios';

// Caricamento chiavi multiple
const API_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((k: string) => k.trim())
  .filter((k: string) => k.length > 0);

let currentKeyIndex = 0;

function getKey(): string {
  if (!API_KEYS.length) {
    throw new Error('Nessuna chiave API configurata in GEMINI_API_KEYS');
  }
  return API_KEYS[currentKeyIndex];
}

/**
 * Chiama l'API Gemini con rotazione automatica delle chiavi.
 *
 * @param prompt - Testo del prompt
 * @param service - Nome servizio per logging
 * @param model - Modello Gemini (default: gemini-2.0-flash)
 * @param maxTokens - Max token output (default: 4096)
 * @returns Risposta testuale del modello
 */
export async function callLLM(
  prompt: string,
  service: string = 'unknown',
  model: string = 'gemini-2.0-flash',
  maxTokens: number = 4096
): Promise<string> {
  const maxRetries = API_KEYS.length;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const key = getKey();
    
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: maxTokens,
          },
        },
        { timeout: 30000 }
      );
      
      const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Risposta vuota da Gemini');
      }
      
      console.log(`[${service}] ✅ Modello: ${model}, Chiave #${currentKeyIndex + 1}/${API_KEYS.length}`);
      return text;
      
    } catch (error: any) {
      // Se quota ecceduta, ruota chiave e riprova
      if (
        (error.response?.status === 429) ||
        /quota/i.test(error.message) ||
        /rate.limit/i.test(error.message)
      ) {
        console.warn(`[${service}] ⚠️ Quota ecceduta chiave #${currentKeyIndex + 1}, rotazione...`);
        currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
        continue;
      }
      
      // Errore 500 retry con backoff
      if (error.response?.status >= 500 && attempt < maxRetries) {
        console.warn(`[${service}] ⚠️ Errore server ${error.response.status}, retry (tentativo ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      
      throw new Error(`Errore Gemini: ${error.message}`);
    }
  }
  
  throw new Error('Tutte le chiavi API hanno esaurito la quota');
}
