import { getPgClient } from '../db/connection';
import { logger } from './logger';

/**
 * Postgres advisory-lock based mutex for cluster-wide singleton
 * workers.
 *
 * Session pinning is MANDATORY: `pg_try_advisory_lock` / `pg_advisory_unlock`
 * are SESSION-scoped. The drizzle+postgres-js pool hands out a
 * different backend connection per query by default, so the acquire
 * runs on connection A, the worker body runs on B/C/D, and the
 * release runs on E — Postgres logs "you don't own a lock of type
 * ExclusiveLock" and the lock on A leaks until that connection is
 * recycled.
 *
 * `postgres.reserve()` returns a dedicated connection that every
 * query in the worker callback shares. Release the reservation in
 * `finally` so the pool reclaims it regardless of outcome.
 */
function keyFor(name: string): bigint {
  // 64-bit FNV-1a
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < name.length; i++) {
    h ^= BigInt(name.charCodeAt(i));
    h = (h * prime) & mask;
  }
  const signMask = 1n << 63n;
  return h >= signMask ? h - (1n << 64n) : h;
}

export async function withClusterLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const key = keyFor(name).toString();
  const client = getPgClient();
  const reserved = await client.reserve();
  try {
    const rows = await reserved<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(${key}::bigint) AS ok`;
    if (!rows[0]?.ok) {
      logger.debug({ worker: name }, 'advisory lock busy, skipping tick');
      return null;
    }
    try {
      return await fn();
    } finally {
      try {
        await reserved`SELECT pg_advisory_unlock(${key}::bigint)`;
      } catch (err) {
        logger.warn({ worker: name, error: (err as Error).message }, 'advisory lock release failed');
      }
    }
  } finally {
    reserved.release();
  }
}
