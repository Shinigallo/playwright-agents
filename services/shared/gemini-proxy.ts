/**
 * ============================================================
 * LLM PROXY — Provider multipli con rotazione chiavi API
 * ============================================================
 * Supporta due provider:
 *   - gemini      : API Google Gemini (originale)
 *   - openai      : API compatibili OpenAI (Ollama, LM Studio,
 *                   OpenAI, Azure OpenAI, opencode, etc.)
 *
 * Pattern di rotazione delle chiavi:
 *   - Supporta N chiavi API configurate (comma-separated)
 *   - Ruota automaticamente quando si incontra quota ecceduta (429)
 *   - Retry con backoff esponenziale
 *   - Logging centralizzato per debug
 *
 * Uso in ogni servizio:
 *   import { callLLM } from '../../shared/gemini-proxy';
 *   const response = await callLLM(prompt, 'planner');
 */

import axios from 'axios';

// ── Configurazione provider ──

type LLMProvider = 'gemini' | 'openai';

const LLM_PROVIDER: LLMProvider = (process.env.LLM_PROVIDER as LLMProvider) || 'gemini';

// Gemini
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((k: string) => k.trim())
  .filter((k: string) => k.length > 0);

let geminiKeyIndex = 0;

// OpenAI-compatible
const OPENAI_API_KEYS = (process.env.OPENAI_API_KEYS || '')
  .split(',')
  .map((k: string) => k.trim())
  .filter((k: string) => k.length > 0);

let openaiKeyIndex = 0;

const OPENAI_API_BASE_URL = (process.env.OPENAI_API_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');

function getGeminiKey(): string {
  if (!GEMINI_API_KEYS.length) {
    throw new Error('Nessuna chiave API configurata in GEMINI_API_KEYS');
  }
  return GEMINI_API_KEYS[geminiKeyIndex];
}

function getOpenAIKey(): string {
  if (!OPENAI_API_KEYS.length) {
    throw new Error('Nessuna chiave API configurata in OPENAI_API_KEYS');
  }
  return OPENAI_API_KEYS[openaiKeyIndex];
}

export interface CallLLMOptions {
  model?: string;
  maxTokens?: number;
  provider?: string;
  openaiBaseURL?: string;
  openaiAPIKey?: string;
}

/**
 * Chiama il LLM configurato con rotazione automatica delle chiavi.
 *
 * @param prompt - Testo del prompt
 * @param service - Nome servizio per logging
 * @param model - Modello da usare (default dipende dal provider)
 * @param maxTokens - Max token output (default: 4096)
 * @param options - Opzioni aggiuntive (provider override, openai URL/key per-request)
 * @returns Risposta testuale del modello
 */
export async function callLLM(
  prompt: string,
  service: string = 'unknown',
  model?: string,
  maxTokens?: number,
  options?: CallLLMOptions
): Promise<string> {
  const effectiveModel = model || process.env.MODEL || getDefaultModel();
  const effectiveMaxTokens = maxTokens ?? 4096;
  const effectiveProvider = options?.provider || LLM_PROVIDER;
  const effectiveBaseURL = options?.openaiBaseURL || OPENAI_API_BASE_URL;
  const effectiveKey = options?.openaiAPIKey;

  if (effectiveProvider === 'openai') {
    return callOpenAI(prompt, service, effectiveModel, effectiveMaxTokens, effectiveBaseURL, effectiveKey);
  }
  return callGemini(prompt, service, effectiveModel, effectiveMaxTokens);
}

function getDefaultModel(): string {
  if (LLM_PROVIDER === 'openai') {
    return process.env.OPENAI_API_MODEL || 'llama3.1';
  }
  return 'gemini-2.0-flash';
}

// ─────────────────────────────────────────────────────────────────────
// GEMINI
// ─────────────────────────────────────────────────────────────────────

async function callGemini(
  prompt: string,
  service: string,
  model: string,
  maxTokens: number
): Promise<string> {
  const maxRetries = GEMINI_API_KEYS.length;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const key = getGeminiKey();

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

      console.log(`[${service}] ✅ Provider: gemini, Modello: ${model}, Chiave #${geminiKeyIndex + 1}/${GEMINI_API_KEYS.length}`);
      return text;

    } catch (error: any) {
      if (
        (error.response?.status === 429) ||
        /quota/i.test(error.message) ||
        /rate.limit/i.test(error.message)
      ) {
        console.warn(`[${service}] ⚠️ Quota ecceduta chiave gemini #${geminiKeyIndex + 1}, rotazione...`);
        geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
        continue;
      }

      if (error.response?.status >= 500 && attempt < maxRetries) {
        console.warn(`[${service}] ⚠️ Errore server ${error.response.status}, retry (tentativo ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      throw new Error(`Errore Gemini: ${error.message}`);
    }
  }

  throw new Error('Tutte le chiavi API Gemini hanno esaurito la quota');
}

// ─────────────────────────────────────────────────────────────────────
// OPENAI-COMPATIBLE (Ollama, LM Studio, Azure, opencode, etc.)
// ─────────────────────────────────────────────────────────────────────

async function callOpenAI(
  prompt: string,
  service: string,
  model: string,
  maxTokens: number,
  overrideBaseURL?: string,
  overrideKey?: string
): Promise<string> {
  const baseUrl = overrideBaseURL || OPENAI_API_BASE_URL;
  const maxRetries = overrideKey ? 1 : OPENAI_API_KEYS.length;
  const key = overrideKey || getOpenAIKey();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model: model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: maxTokens,
        },
        {
          timeout: 30000,
          headers: {
            'Content-Type': 'application/json',
            ...(key && key !== 'no-key' && key !== '' ? { Authorization: `Bearer ${key}` } : {}),
          },
        }
      );

      const text = response.data?.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error('Risposta vuota dal modello OpenAI-compatible');
      }

      console.log(`[${service}] ✅ Provider: openai, Modello: ${model}, URL: ${baseUrl}`);
      return text;

    } catch (error: any) {
      if (
        (error.response?.status === 429) ||
        /quota/i.test(error.message) ||
        /rate.limit/i.test(error.message)
      ) {
        if (!overrideKey) {
          console.warn(`[${service}] ⚠️ Quota ecceduta chiave openai #${openaiKeyIndex + 1}, rotazione...`);
          openaiKeyIndex = (openaiKeyIndex + 1) % OPENAI_API_KEYS.length;
        }
        continue;
      }

      if (error.response?.status >= 500 && attempt < maxRetries) {
        console.warn(`[${service}] ⚠️ Errore server ${error.response?.status}, retry (tentativo ${attempt + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }

      const status = error.response?.status ? ` (HTTP ${error.response.status})` : '';
      throw new Error(`Errore OpenAI-compatible (${baseUrl}${status}): ${error.message}`);
    }
    }

  throw new Error('Tutte le chiavi API OpenAI hanno esaurito la quota');
}
