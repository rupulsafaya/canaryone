// D2/M1 pipeline target: one non-streaming OpenAI chat.completions call.
// The model name is a placeholder — canaryone's proxy rewrites it to the
// lane's configured model + provider before forwarding to OpenRouter.

import OpenAI from 'openai';

export const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? 'sk-proxy-placeholder',
  // No baseURL override — honors OPENAI_BASE_URL env, which canaryone sets
  // to the lane's ephemeral proxy port.
});

export async function echo(prompt) {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    // Set high enough that reasoning models don't exhaust the budget on
    // internal chain-of-thought and return empty visible content.
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices?.[0]?.message?.content ?? '';
}
