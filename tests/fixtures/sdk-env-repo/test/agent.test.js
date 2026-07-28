import { test } from 'node:test';
import assert from 'node:assert';
import { ask } from '../src/agent.js';

test('agent returns a non-empty string', async () => {
  const out = await ask('hello');
  assert.ok(typeof out === 'string' && out.length > 0);
});
