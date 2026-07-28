// Smallest possible test: real Anthropic SDK, ANTHROPIC_BASE_URL swapped to the spike proxy.
// If this prints a valid `content[0].text` string, interception works end-to-end.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-anthropic-not-real', // proxy ignores this and uses OR key
});

console.log('Anthropic SDK baseURL resolved to:', client.baseURL);
const t0 = Date.now();

const res = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',   // proxy overwrites this on the wire
  max_tokens: 60,
  system: 'You are a robot. Reply with exactly one word: OK.',
  messages: [{ role: 'user', content: 'ping' }],
});

const ms = Date.now() - t0;
console.log(`\n--- RESULT (${ms}ms) ---`);
console.log('model reported:', res.model);
console.log('stop_reason:', res.stop_reason);
console.log('usage:', res.usage);
console.log('content[0].text:', JSON.stringify(res.content?.[0]?.text));
console.log('\nfull response:', JSON.stringify(res, null, 2));
