// Nested-tests fixture: tests live next to source in src/**/__tests__/.
// The deterministic scanner's shallow probe misses this layout; the nested
// fallback picks it up via `src/**/__tests__/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}`.

import Anthropic from '@anthropic-ai/sdk';

export const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-placeholder',
});

export async function summarize(text) {
  const res = await client.messages.create({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    messages: [{ role: 'user', content: `Summarize: ${text}` }],
  });
  return res.content?.[0]?.type === 'text' ? res.content[0].text : '';
}
