import { describe, test, expect, mock } from 'bun:test';

import { enqueueEnrichment, pendingCount } from '../../src/fqa/queue';

// Mock runEnrichment so the queue test doesn't hit the DB.
const calls: string[] = [];
mock.module('../../src/fqa/enrich', () => ({
  runEnrichment: async (id: string) => {
    calls.push(id);
    return null;
  },
  // The module also exports other names; provide stubs so the
  // mock substitutes cleanly.
  auditAndEnrich: async () => ({ scanned: 0, enriched: 0, skipped: [] }),
  expireStalePullTasks: async () => 0,
}));

// Polls `pendingCount()` until the queue is empty or the timeout
// elapses. Extracted into a helper so the wait-for-drain pattern
// doesn't appear as a conditional inside `test(...)` bodies — the
// jest rule flags any `if`/`for` inside a test callback, even one
// that's clearly fixture-side.
async function drain(): Promise<void> {
  const start = Date.now();
  while (pendingCount() > 0 && Date.now() - start < 50) {
    await new Promise(r => setTimeout(r, 5));
  }
}

describe('fqa queue — event-driven drain', () => {
  test('enqueue dispatches in order, idle when drained', async () => {
    calls.length = 0;
    enqueueEnrichment('a');
    enqueueEnrichment('b');
    enqueueEnrichment('c');
    await drain();
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(pendingCount()).toBe(0);
  });

  test('subsequent enqueue restarts the drainer', async () => {
    calls.length = 0;
    enqueueEnrichment('x');
    await drain();
    expect(calls).toEqual(['x']);
    enqueueEnrichment('y');
    await drain();
    expect(calls).toEqual(['x', 'y']);
  });
});
