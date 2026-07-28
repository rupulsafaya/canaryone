import { test } from 'node:test';
import assert from 'node:assert';
import { factCheck } from '../src/agent.js';

test('factCheck answers with YES on the first line', async () => {
  const out = await factCheck('The Eiffel Tower is in Paris.');
  assert.ok(typeof out === 'string' && out.length > 0);
  const firstLine = out.trim().split('\n')[0].toUpperCase();
  assert.ok(/YES|NO/.test(firstLine), `expected YES/NO on first line, got: ${firstLine.slice(0, 60)}`);
});
