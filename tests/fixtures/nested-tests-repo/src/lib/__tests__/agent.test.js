import { test } from 'node:test';
import assert from 'node:assert';
import { summarize } from '../agent.js';

test('summarize returns a non-empty string', async () => {
  const out = await summarize('hello world');
  assert.ok(typeof out === 'string' && out.length > 0);
});
