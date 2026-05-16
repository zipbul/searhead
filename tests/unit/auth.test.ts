import { describe, test, expect, afterEach } from 'bun:test';

import { authenticate } from '../../src/a2a/auth';

describe('authenticate', () => {
  const originalToken = process.env.KNOLDR_API_TOKEN;

  afterEach(() => {
    if (originalToken) {
      process.env.KNOLDR_API_TOKEN = originalToken;
    } else {
      delete process.env.KNOLDR_API_TOKEN;
    }
  });

  test('allows all requests when no token configured', () => {
    delete process.env.KNOLDR_API_TOKEN;
    const req = new Request('http://localhost/a2a', { method: 'POST' });
    expect(authenticate(req)).toBe(true);
  });

  test('accepts valid Bearer token', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/a2a', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret-123' },
    });
    expect(authenticate(req)).toBe(true);
  });

  test('rejects missing Authorization header', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/a2a', { method: 'POST' });
    expect(authenticate(req)).toBe(false);
  });

  test('rejects wrong token', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/a2a', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(authenticate(req)).toBe(false);
  });

  test('rejects non-Bearer scheme', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/a2a', {
      method: 'POST',
      headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
    });
    expect(authenticate(req)).toBe(false);
  });

  test('case-insensitive Bearer scheme', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/a2a', {
      method: 'POST',
      headers: { Authorization: 'bearer test-secret-123' },
    });
    expect(authenticate(req)).toBe(true);
  });
});
