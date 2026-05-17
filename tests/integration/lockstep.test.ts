/**
 * schema.ts ↔ drizzle/*.sql lockstep guard.
 *
 * The migration files in `drizzle/` are hand-maintained alongside
 * `src/db/schema.ts` (the auto-generator can't express partitioning,
 * extensions, or HNSW / pgroonga indexes). It is easy for the two to
 * drift — someone adds a column to `schema.ts` and forgets to update
 * `0000_init.sql`. This test runs the actual migration pipeline
 * against a fresh DB and then asserts that, for every table defined
 * in `schema.ts`, every column declared on the drizzle table object
 * exists in the DB. A missing column means the .sql lags behind.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { getTableColumns, getTableName, isTable, type Table } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from '../../src/db/schema';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';

function adminUrl(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function maintenanceUrl(): string {
  const u = new URL(ADMIN_URL);
  u.pathname = '/postgres';
  return u.toString();
}

async function recreate(name: string): Promise<void> {
  const admin = postgres(maintenanceUrl(), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
}

async function dropDb(name: string): Promise<void> {
  const admin = postgres(maintenanceUrl(), { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
}

async function applyMigrations(dbName: string): Promise<void> {
  const sql = postgres(adminUrl(dbName), { max: 1 });
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

const dbAvailable = await (async () => {
  try {
    const probe = postgres(ADMIN_URL, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable, skipping lockstep tests:', (err as Error).message);
    return false;
  }
})();

const tmpDb = `knoldr_lockstep_${Date.now()}`;

afterAll(async () => {
  if (dbAvailable) {
    await dropDb(tmpDb);
  }
});

describe('migration lockstep — schema.ts vs drizzle/*.sql', () => {
  test.skipIf(!dbAvailable)('every column declared in schema.ts exists in the migrated DB', async () => {
    await recreate(tmpDb);
    await applyMigrations(tmpDb);

    const sql = postgres(adminUrl(tmpDb), { max: 1 });
    try {
      // information_schema.columns gives the live column set per
      // table. We pull every (table, column) pair once and probe
      // against drizzle's runtime view of schema.ts.
      const liveRows = await sql<{ table_name: string; column_name: string }[]>`
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
      `;
      const live = new Map<string, Set<string>>();
      for (const row of liveRows) {
        let cols = live.get(row.table_name);
        if (!cols) {
          cols = new Set<string>();
          live.set(row.table_name, cols);
        }
        cols.add(row.column_name);
      }

      const missing: string[] = [];
      for (const value of Object.values(schema)) {
        if (!isTable(value)) {
          continue;
        }
        const table = value as Table;
        const tableName = getTableName(table);
        const cols = getTableColumns(table);
        const liveCols = live.get(tableName);
        if (!liveCols) {
          missing.push(`table ${tableName} missing entirely`);
          continue;
        }
        for (const col of Object.values(cols)) {
          if (!liveCols.has(col.name)) {
            missing.push(`${tableName}.${col.name}`);
          }
        }
      }

      expect(missing).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  test.skipIf(!dbAvailable)('every named *_values CHECK declared in schema.ts is enforced after migrate', async () => {
    // 0001_kebab_cleanup.sql VALIDATEs every NOT VALID CHECK. After
    // a successful migrate, every named *_values constraint must be
    // in convalidated=true state. This catches a missing VALIDATE in
    // 0001 or a CHECK that schema.ts declared but neither .sql file
    // attached.
    const sql = postgres(adminUrl(tmpDb), { max: 1 });
    try {
      const rows = await sql<{ conname: string; convalidated: boolean }[]>`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conname LIKE '%\\_values' ESCAPE '\\' AND contype = 'c'
      `;
      const unvalidated = rows.filter(r => !r.convalidated).map(r => r.conname);
      expect(unvalidated).toEqual([]);
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await sql.end();
    }
  });

  test.skipIf(!dbAvailable)('every named CHECK declared in schema.ts exists on the migrated DB', async () => {
    // schema.ts attaches CHECK constraints via the `check()` helper
    // with explicit names (e.g. `entry_source_trust_range`). Each
    // one must land in pg_constraint after migrate; a missing name
    // means the .sql files don't actually create the constraint
    // even though schema.ts thinks they do.
    const expectedNames = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!isTable(value)) {
        continue;
      }
      // drizzle exposes the resolved table-level CHECKs / FKs /
      // indexes via `getTableConfig`. The CHECK entries carry the
      // explicit name passed to `check('name', sql\`...\`)` calls.
      const cfg = getTableConfig(value as PgTable);
      for (const c of cfg.checks) {
        expectedNames.add(c.name);
      }
    }

    const sql = postgres(adminUrl(tmpDb), { max: 1 });
    try {
      const rows = await sql<{ conname: string }[]>`
        SELECT conname FROM pg_constraint WHERE contype = 'c'
      `;
      const live = new Set(rows.map(r => r.conname));
      const missing = [...expectedNames].filter(n => !live.has(n));
      expect(missing).toEqual([]);
      expect(expectedNames.size).toBeGreaterThan(0);
    } finally {
      await sql.end();
    }
  });

  test.skipIf(!dbAvailable)('entry table is partitioned by created_at after migrate', async () => {
    // Without partitioning, every INSERT into entry falls into a
    // single heap and the year-keyed indexes can't take effect. A
    // contributor reissuing CREATE TABLE entry in a new .sql
    // migration without PARTITION BY would silently revert this.
    const sql = postgres(adminUrl(tmpDb), { max: 1 });
    try {
      const rows = await sql<{ partstrat: string; partattrs: string }[]>`
        SELECT p.partstrat::text, p.partattrs::text
        FROM pg_partitioned_table p
        JOIN pg_class c ON c.oid = p.partrelid
        WHERE c.relname = 'entry'
      `;
      expect(rows.length).toBe(1);
      // 'r' = RANGE in pg_partitioned_table.partstrat.
      expect(rows[0]!.partstrat).toBe('r');
    } finally {
      await sql.end();
    }
  });

  test.skipIf(!dbAvailable)('vector and pgroonga extensions are installed after migrate', async () => {
    // Both extensions are CREATE EXTENSION IF NOT EXISTS in 0000,
    // but a hand edit that strips them would let downstream tests
    // pass on a DB that already had them and silently break on
    // genuinely fresh installs.
    const sql = postgres(adminUrl(tmpDb), { max: 1 });
    try {
      const rows = await sql<{ extname: string }[]>`
        SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgroonga')
      `;
      const names = rows.map(r => r.extname).sort();
      expect(names).toEqual(['pgroonga', 'vector']);
    } finally {
      await sql.end();
    }
  });
});
