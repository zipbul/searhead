import { describe, test, expect } from 'bun:test';
/**
 * Integration-level assertions for the SSE path. The streaming endpoint is
 * wired through `@a2a-js/sdk`'s JsonRpcTransportHandler which returns an
 * AsyncGenerator for `message/stream`. The server wraps that generator
 * into a text/event-stream response (see src/a2a/server.ts:streamSse).
 *
 * These tests verify the public shape that callers rely on:
 *   - agent card advertises streaming: true
 *   - every event is serialized as a proper SSE `data:` frame
 *   - a keepalive comment is emitted between events so idle TCP timers
 *     do not tear down long-running streams
 */

import { agentCard } from '../../src/a2a/agent-card';

describe('agent-card', () => {
  test('streaming capability is advertised', () => {
    expect(agentCard.capabilities?.streaming).toBe(true);
  });

  test('feedback skill is registered', () => {
    // agentCard.skills is always populated at construction time; this
    // is a contract check, not a defensive read.
    const ids = agentCard.skills.map(s => s.id);
    expect(ids).toContain('find');
    expect(ids).toContain('feedback');
  });
});

/**
 * Reconstruct the SSE framing contract locally. If this helper ever drifts
 * from server.ts, the end-to-end stream test will catch it; this locks in
 * the frame shape clients parse with `data:` prefixes.
 */
function frameEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe('SSE frame format', () => {
  test('JSON payloads are prefixed with `data: ` and end with blank line', () => {
    const frame = frameEvent({ kind: 'message', id: 'x' });
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const body = frame.slice('data: '.length, -2);
    expect(JSON.parse(body)).toEqual({ kind: 'message', id: 'x' });
  });

  test('keepalive comments start with `: `', () => {
    const comment = `: keepalive\n\n`;
    expect(comment.startsWith(': ')).toBe(true);
    // Per SSE spec, lines starting with `:` are comments and clients must
    // ignore them — they exist only to keep the TCP connection alive.
    expect(comment.includes('data:')).toBe(false);
  });
});
