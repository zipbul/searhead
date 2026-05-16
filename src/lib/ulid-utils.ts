const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class InvalidUlidError extends Error {
  constructor(id: string) {
    super(`Invalid ULID: ${id.slice(0, 32)}`);
    this.name = 'InvalidUlidError';
  }
}

/**
 * Extract timestamp from a ULID as epoch milliseconds.
 *
 * Validates length (≥ 10 chars) and Crockford-base32 alphabet before
 * decoding. Previously this function trusted its input and threw a
 * confusing TypeError ("undefined is not an object") on short strings,
 * and silently returned nonsense timestamps for non-base32 characters
 * (indexOf returned -1 which accumulated into NaN-like values).
 */
export function decodeUlidTimestamp(id: string): number {
  if (typeof id !== 'string' || id.length < 10) {
    throw new InvalidUlidError(id);
  }
  let time = 0;
  for (let i = 0; i < 10; i++) {
    const c = id[i]!.toUpperCase();
    const n = ENCODING.indexOf(c);
    if (n < 0) {
      throw new InvalidUlidError(id);
    }
    time = time * 32 + n;
  }
  return time;
}
