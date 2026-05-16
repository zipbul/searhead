/**
 * Migration regression tests.
 *
 * Covers the two behaviors that broke silently in earlier rounds:
 *   1. Idempotency — running migrate twice in a row must succeed,
 *      preserving applied state and inserting no spurious rows.
 *   2. snake → kebab conversion — a pre-v0.4 deployment seeded with
 *      snake_case enum values must end up with every row carrying
 *      the project-wide kebab convention AND the named *_values
 *      CHECK constraint flipped to enforced (VALIDATE CONSTRAINT).
 *
 * Both tests spin a dedicated ephemeral database next to the main
 * test DB so they don't interfere with parallel suites.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';

/** Build the admin connection (defaults to postgres super-db). */
function adminClient() {
  // Connect to the `postgres` maintenance DB on the same host/port
  // as TEST_DATABASE_URL so we can CREATE / DROP databases.
  const u = new URL(ADMIN_URL);
  u.pathname = '/postgres';
  return postgres(u.toString(), { max: 1 });
}

async function createDb(name: string) {
  const admin = adminClient();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
}

async function dropDb(name: string) {
  const admin = adminClient();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
}

function dbUrl(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

async function runMigrate(dbName: string): Promise<void> {
  const sql = postgres(dbUrl(dbName), { max: 1 });
  const db = drizzle(sql);
  await drizzleMigrate(db, { migrationsFolder: './drizzle' });
  const currentYear = new Date().getFullYear();
  for (let year = 2025; year <= currentYear + 1; year++) {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS entry_${year} PARTITION OF entry
        FOR VALUES FROM ('${year}-01-01') TO ('${year + 1}-01-01')
    `);
  }
  await sql.end();
}

// Skip everything when the test DB is unreachable.
const dbAvailable = await (async () => {
  try {
    const probe = postgres(ADMIN_URL, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable, skipping migrate tests:', (err as Error).message);
    return false;
  }
})();

const tmpDbs: string[] = [];

afterAll(async () => {
  for (const name of tmpDbs) {
    await dropDb(name);
  }
});

describe('migrate — idempotency', () => {
  test.skipIf(!dbAvailable)('running migrate twice on a fresh DB is a no-op the second time', async () => {
    const name = `knoldr_mig_idempotent_${Date.now()}`;
    tmpDbs.push(name);
    await createDb(name);
    await runMigrate(name);

    // After the first run, capture row counts on the migration journal.
    const sql1 = postgres(dbUrl(name), { max: 1 });
    const [{ count: applied1 }] = await sql1<{ count: string }[]>`
      SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
    `;
    await sql1.end();
    expect(Number(applied1)).toBeGreaterThan(0);

    // Second run shouldn't add anything.
    await runMigrate(name);
    const sql2 = postgres(dbUrl(name), { max: 1 });
    const [{ count: applied2 }] = await sql2<{ count: string }[]>`
      SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
    `;
    await sql2.end();
    expect(applied2).toBe(applied1);
  });
});

describe('migrate — snake → kebab conversion', () => {
  test.skipIf(!dbAvailable)('rewrites legacy snake_case enum values and validates the CHECKs', async () => {
    const name = `knoldr_mig_snake_${Date.now()}`;
    tmpDbs.push(name);
    await createDb(name);

    // Seed the DB the way a pre-v0.4 deployment looked: schema with
    // no CHECK on source_type and snake values stored verbatim.
    const seed = postgres(dbUrl(name), { max: 1 });
    await seed.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await seed.unsafe(`CREATE EXTENSION IF NOT EXISTS pgroonga`);
    await seed.unsafe(`
      CREATE TABLE entry (
        id text NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        language text NOT NULL DEFAULT 'en',
        metadata jsonb,
        authority double precision NOT NULL DEFAULT 0.0,
        decay_rate double precision NOT NULL DEFAULT 0.01,
        status text NOT NULL DEFAULT 'draft',
        created_at timestamptz NOT NULL,
        embedding vector(384) NOT NULL,
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at)
    `);
    await seed.unsafe(`
      CREATE TABLE entry_2025 PARTITION OF entry
        FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')
    `);
    await seed.unsafe(`
      CREATE TABLE entry_source (
        entry_id text NOT NULL,
        entry_created_at timestamptz NOT NULL,
        url text NOT NULL,
        source_type text NOT NULL,
        trust double precision DEFAULT 0.0,
        PRIMARY KEY (entry_id, entry_created_at, url),
        FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
      )
    `);
    const zeroVec = `[${new Array(384).fill(0).join(',')}]`;
    await seed.unsafe(
      `INSERT INTO entry (id, title, content, created_at, embedding) VALUES ('legacy-1', 't', 'c', '2025-06-15T00:00:00Z', '${zeroVec}'::vector)`,
    );
    await seed.unsafe(
      `INSERT INTO entry_source (entry_id, entry_created_at, url, source_type, trust) VALUES
       ('legacy-1', '2025-06-15T00:00:00Z', 'https://a', 'official_docs', 0.9),
       ('legacy-1', '2025-06-15T00:00:00Z', 'https://b', 'research_paper', 0.75)`,
    );
    await seed.end();

    await runMigrate(name);

    // Data must be kebab now.
    const verify = postgres(dbUrl(name), { max: 1 });
    const rows = await verify<{ source_type: string }[]>`
      SELECT source_type FROM entry_source WHERE entry_id = 'legacy-1' ORDER BY url
    `;
    expect(rows.map(r => r.source_type)).toEqual(['official-docs', 'research-paper']);

    // CHECK must be flipped to enforced.
    const [{ convalidated }] = await verify<{ convalidated: boolean }[]>`
      SELECT convalidated FROM pg_constraint
      WHERE conname = 'entry_source_source_type_values'
    `;
    expect(convalidated).toBe(true);

    // Future INSERT with snake value must be rejected.
    let rejected = false;
    try {
      await verify.unsafe(
        `INSERT INTO entry_source (entry_id, entry_created_at, url, source_type, trust) VALUES
         ('legacy-1', '2025-06-15T00:00:00Z', 'https://c', 'official_docs', 0.5)`,
      );
    } catch {
      rejected = true;
    }
    await verify.end();
    expect(rejected).toBe(true);
  });
});
