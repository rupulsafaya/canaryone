// A tiny agent module that uses the OpenAI SDK with a HARDCODED baseURL.
// canaryone's methodology check should classify this repo as sdk-hardcoded
// and refuse to advance to task picking.

import OpenAI from 'openai';

export const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY ?? 'sk-placeholder',
  // Hardcoded — env-var swap cannot intercept this.
  baseURL: 'https://api.groq.com/openai/v1',
});

export async function ask(prompt) {
  const res = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0]?.message?.content ?? '';
}
