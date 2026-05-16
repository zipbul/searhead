// Migration runner.
//
// The schema baseline + the kebab-conversion are both expressed as
// SQL migration files under `drizzle/`, applied here via drizzle's
// migrator (`__drizzle_migrations` tracks the journal; each file
// runs once per deployment). Only the work the migrator does not
// own lives in this script:
//
//  - dynamic partition creation: `entry_${year}` tables get added
//    at runtime per current year + 1, so they cannot live in a
//    static `.sql` file.
//
// Everything else — extensions, table DDL, indexes (including
// HNSW / pgroonga), CHECK constraints, snake → kebab data
// rewrites, legacy auto-named CHECK cleanup — is in `drizzle/`.

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { logger } from '../observability/logger';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

const sql = postgres(connectionString, { max: 1 });
const db = drizzle(sql, { schema });

async function migrate() {
  logger.info('running migrations');

  await drizzleMigrate(db, { migrationsFolder: './drizzle' });

  // Dynamic year-keyed partitions for the `entry` table. New years
  // are added eagerly each year; old years' tables remain in place.
  //
  // We use `sql.unsafe` here because PostgreSQL's `PARTITION OF ...
  // FOR VALUES FROM (...) TO (...)` clause does not accept bound
  // parameters — every value in the FOR VALUES list must be a
  // compile-time literal. The interpolated values are both derived
  // from `new Date().getFullYear()`, so they are integers under our
  // control and carry no injection surface.
  const currentYear = new Date().getFullYear();
  for (let year = 2025; year <= currentYear + 1; year++) {
    const partName = `entry_${year}`;
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${partName} PARTITION OF entry
        FOR VALUES FROM ('${year}-01-01') TO ('${year + 1}-01-01')
    `);
  }

  logger.info('migrations complete');
  await sql.end();
}

try {
  await migrate();
} catch (err) {
  logger.error(err, 'migration failed');
  process.exit(1);
}
