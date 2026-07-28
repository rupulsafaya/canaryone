// Tool-call round-trip test — real Anthropic SDK with a tool definition through the spike proxy.
// Two rounds: (1) model requests tool_use, (2) we send tool_result, model produces final text.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-fake' });

const tools = [{
  name: 'get_weather',
  description: 'Get current weather for a city.',
  input_schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
}];

// --- Round 1: expect tool_use ---
console.log('--- ROUND 1: request with tool defined ---');
const t0 = Date.now();
const round1 = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 200,
  tools,
  messages: [{ role: 'user', content: 'What is the weather in Amsterdam? Use the get_weather tool.' }],
});
console.log(`round1 (${Date.now() - t0}ms):`);
console.log('  stop_reason:', round1.stop_reason);
console.log('  content:', JSON.stringify(round1.content, null, 2));

const toolUse = round1.content.find(b => b.type === 'tool_use');
if (!toolUse) { console.log('\n✗ FAIL — model did not emit tool_use block'); process.exit(1); }
console.log('\n✓ tool_use block present:', { id: toolUse.id, name: toolUse.name, input: toolUse.input });

// --- Round 2: send tool_result, expect natural-language response ---
console.log('\n--- ROUND 2: send tool_result ---');
const t1 = Date.now();
const round2 = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 200,
  tools,
  messages: [
    { role: 'user', content: 'What is the weather in Amsterdam? Use the get_weather tool.' },
    { role: 'assistant', content: round1.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Amsterdam: 12°C, drizzle.' }] },
  ],
});
console.log(`round2 (${Date.now() - t1}ms):`);
console.log('  stop_reason:', round2.stop_reason);
console.log('  content:', JSON.stringify(round2.content, null, 2));

const finalText = round2.content.find(b => b.type === 'text')?.text;
const ok = finalText && finalText.toLowerCase().includes('amsterdam') && (finalText.includes('12') || finalText.toLowerCase().includes('drizzle'));
console.log(`\n${ok ? '✓ PASS' : '⚠  PARTIAL'} — round2 text: ${JSON.stringify(finalText)}`);
if (!ok) console.log('  (some models phrase this loosely; wire success is what matters if text is non-empty)');
process.exit(finalText ? 0 : 1);
