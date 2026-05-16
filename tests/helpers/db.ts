/**
 * Test database helper.
 *
 * Now delegates schema setup to the actual migration runner (drizzle
 * migrator + dynamic partition creation in src/db/migrate.ts). The
 * old helper hand-rolled a simplified schema, which silently drifted
 * from production and let migration regressions slip past CI. Going
 * through the real migration path means integration tests now cover
 * `drizzle/0000_init.sql`, `drizzle/0001_kebab_cleanup.sql`, and the
 * partition fan-out in one shot.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';

let _client: ReturnType<typeof postgres> | null = null;

export function getTestClient() {
  if (!_client) {
    _client = postgres(TEST_DB_URL, { max: 5 });
  }
  return _client;
}

/** Run the project migrations on the test database. */
export async function setupTestDb() {
  const sql = getTestClient();
  const db = drizzle(sql);
  await drizzleMigrate(db, { migrationsFolder: './drizzle' });

  // Mirror src/db/migrate.ts: ensure the current-year + 1 partitions
  // exist. Without this every INSERT into `entry` fails with "no
  // partition of relation entry found for row".
  const currentYear = new Date().getFullYear();
  for (let year = 2025; year <= currentYear + 1; year++) {
    const partName = `entry_${year}`;
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${partName} PARTITION OF entry
        FOR VALUES FROM ('${year}-01-01') TO ('${year + 1}-01-01')
    `);
  }
}

/** Truncate every test-touched table so the next test starts clean. */
export async function cleanTestDb() {
  const sql = getTestClient();
  // Order matters only when FK CASCADE chains aren't already on the
  // tables; every FK here is ON DELETE CASCADE, so a single TRUNCATE
  // ... CASCADE on `entry` reaches the dependents, but we list each
  // table to keep the cleanup deterministic regardless of which
  // tests have data in them.
  await sql`TRUNCATE
    feedback_log, ingest_log, entry_source, entry_tag, entry_domain,
    kg_relation, entity, agent_feedback_authority, claim_feedback,
    claim_relation, verdict_log, verify_queue, entry_score, claim,
    retry_queue, entry, golden_set_run, golden_set_claim
    RESTART IDENTITY CASCADE`;
}

/** Close test DB connection */
export async function teardownTestDb() {
  if (_client) {
    await _client.end();
    _client = null;
  }
}
