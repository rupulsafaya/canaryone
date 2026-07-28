// A tiny agent module that uses the Anthropic SDK with the SDK's default
// base URL (which honors ANTHROPIC_BASE_URL). canaryone's methodology check
// should classify this repo as sdk-env and auto-advance.

import Anthropic from '@anthropic-ai/sdk';

export const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-placeholder',
  // No baseURL — SDK default; honors ANTHROPIC_BASE_URL env var.
});

export async function ask(prompt) {
  const res = await client.messages.create({
    model: 'claude-haiku-4.5',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content?.[0]?.type === 'text' ? res.content[0].text : '';
}
