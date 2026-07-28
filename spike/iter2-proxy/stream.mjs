// Stream test — real Anthropic SDK streaming through the spike proxy.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-fake' });
console.log('baseURL:', client.baseURL);

const events = [];
let textAccum = '';
const t0 = Date.now();
let firstEventMs = null;

const stream = client.messages.stream({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 200,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
});

stream.on('text', (chunk) => {
  if (firstEventMs == null) firstEventMs = Date.now() - t0;
  textAccum += chunk;
});
stream.on('streamEvent', (ev) => events.push(ev.type));
stream.on('error', (e) => console.error('stream error:', e));

const final = await stream.finalMessage();
const ms = Date.now() - t0;

console.log(`\n--- STREAM RESULT (${ms}ms, first delta at ${firstEventMs}ms) ---`);
console.log('event sequence (unique):', [...new Set(events)]);
console.log('total events:', events.length);
console.log('accumulated text:', JSON.stringify(textAccum));
console.log('\nfinal message:');
console.log('  id:', final.id);
console.log('  model:', final.model);
console.log('  stop_reason:', final.stop_reason);
console.log('  content:', JSON.stringify(final.content));
console.log('  usage:', final.usage);

// Success criteria:
const ok = final.content?.[0]?.type === 'text' && textAccum.length > 0 && firstEventMs != null && firstEventMs < ms;
console.log(`\n${ok ? '✓ PASS' : '✗ FAIL'} — SDK streamed cleanly, first delta arrived before final message`);
process.exit(ok ? 0 : 1);
