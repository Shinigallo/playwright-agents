import axios from 'axios';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.MODEL || 'gemini-2.0-flash';

// Supported models:
// gemini-2.0-flash        (fast, default)
// gemini-2.5-pro          (powerful, slower)
// gemini-3.0-ultra        (most capable)

export async function callLLM(prompt: string): Promise<string> {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
    }
  );
  return response.data.candidates[0].content.parts[0].text as string;
}
