// Boss-level: streaming + tool_use combined. This is what real agent frameworks use.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-fake' });

const tools = [{
  name: 'get_weather',
  description: 'Get current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}];

console.log('--- streaming round 1: expect stream to yield tool_use ---');
const events = [];
const t0 = Date.now();
let firstMs = null;

const stream = client.messages.stream({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 200,
  tools,
  messages: [{ role: 'user', content: 'What is the weather in Amsterdam? Use the get_weather tool.' }],
});

stream.on('streamEvent', (ev) => {
  if (firstMs == null) firstMs = Date.now() - t0;
  events.push(ev.type);
});
stream.on('inputJson', (partial, full) => {
  // Anthropic SDK synthesizes this from input_json_delta events — our translator emits those.
  console.log(`  input_json partial: ${JSON.stringify(partial)}  accumulated: ${JSON.stringify(full)}`);
});

const finalMsg = await stream.finalMessage();
console.log(`\ntotal ${Date.now() - t0}ms, first event at ${firstMs}ms`);
console.log('event sequence:', events);
console.log('\nfinal.content:', JSON.stringify(finalMsg.content, null, 2));
console.log('final.stop_reason:', finalMsg.stop_reason);

const toolUse = finalMsg.content.find(b => b.type === 'tool_use');
const ok = toolUse && toolUse.name === 'get_weather' && typeof toolUse.input?.city === 'string' && events.includes('content_block_start') && events.includes('content_block_delta') && events.includes('content_block_stop');
console.log(`\n${ok ? '✓ PASS' : '✗ FAIL'} — streaming SDK reconstructed tool_use{city:"..."} from wire events`);
if (ok) console.log(`  input: ${JSON.stringify(toolUse.input)}`);
process.exit(ok ? 0 : 1);
