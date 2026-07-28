import { test } from 'node:test';
import assert from 'node:assert';
import { echo } from '../src/agent.js';

test('echo returns a non-empty string', async () => {
  const out = await echo('Reply with the single word: pong');
  assert.ok(typeof out === 'string' && out.length > 0, 'response should be a non-empty string');
});
