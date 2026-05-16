import { describe, test, expect } from 'bun:test';

import { handleFeedback } from '../../src/a2a/handlers/feedback';

describe('handleFeedback — input validation (no DB)', () => {
  test('missing entryId returns invalid_input', async () => {
    const res = await handleFeedback({ signal: 'positive', agentId: 'a' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('missing agentId returns invalid_input', async () => {
    const res = await handleFeedback({ entryId: '01ABC', signal: 'positive' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('invalid signal returns invalid_input', async () => {
    const res = await handleFeedback({
      entryId: '01ABC',
      signal: 'maybe',
      agentId: 'a',
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('empty entryId returns invalid_input', async () => {
    const res = await handleFeedback({ entryId: '', signal: 'positive', agentId: 'a' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('empty agentId returns invalid_input', async () => {
    const res = await handleFeedback({ entryId: '01ABC', signal: 'negative', agentId: '' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('reason exceeding max length returns invalid_input', async () => {
    const res = await handleFeedback({
      entryId: '01ABC',
      signal: 'positive',
      agentId: 'a',
      reason: 'x'.repeat(1001),
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });
});
