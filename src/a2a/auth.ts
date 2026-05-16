import { timingSafeEqual } from 'node:crypto';

/**
 * Validate Bearer token from Authorization header.
 *
 * Fail-closed policy:
 *  - In production (NODE_ENV=production) the token is REQUIRED. A missing
 *    KNOLDR_API_TOKEN throws at server start via `requireTokenOrThrow`;
 *    this function therefore treats unset token as a server error and
 *    rejects the request rather than silently opening access.
 *  - In non-production an unset token means "no auth configured" and
 *    requests pass — this is explicit for development ergonomics.
 *
 * Comparison uses node:crypto `timingSafeEqual` over fixed-size buffers so
 * an attacker cannot learn token bytes from response-time variance.
 */
function authenticate(request: Request): boolean {
  const token = process.env.KNOLDR_API_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === 'production') {
      return false;
    }
    return true;
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return false;
  }
  const [scheme, value] = authHeader.split(' ');
  if (!scheme || !value || scheme.toLowerCase() !== 'bearer') {
    return false;
  }

  return constantTimeEqual(value, token);
}

/**
 * Call from server startup. Throws when running in production without a
 * token so the process refuses to start rather than accepting traffic
 * anonymously.
 */
function requireTokenOrThrow(): void {
  if (process.env.NODE_ENV === 'production' && !process.env.KNOLDR_API_TOKEN) {
    throw new Error('KNOLDR_API_TOKEN is required in production (fail-closed auth policy)');
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  // Pad both sides to the longer length so timingSafeEqual (which requires
  // equal lengths) still runs in constant time. The length comparison at
  // the end keeps mismatched-length inputs as "not equal" without leaking
  // byte-level info about the real token.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

export { authenticate, requireTokenOrThrow };
