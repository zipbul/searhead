# Migrations

`src/db/migrate.ts` runs `drizzleMigrate` over every `.sql` file
listed in `meta/_journal.json`, in order. The journal is the
runtime source of truth — every applied migration is recorded in
`__drizzle_migrations` so each file runs once per deployment.

| file                     | role                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_init.sql`          | Baseline schema: extensions, partitioned tables, indexes (including HNSW / pgroonga), inline + named CHECK constraints. Idempotent (`IF NOT EXISTS` / guarded `DO` blocks) so safe to apply against a pre-v0.4 deployment. Named `*_values` CHECKs attach in `NOT VALID` mode so legacy snake_case data isn't rejected here — 0001 rewrites and then `VALIDATE`s. |
| `0001_kebab_cleanup.sql` | Data migration: rewrites pre-v0.4 snake_case enum rows to kebab-case, drops any auto-named `_check` siblings still carrying snake values, then `VALIDATE CONSTRAINT` flips every NOT-VALID CHECK to enforced. Matches zero rows on a fresh install.                                                                                                               |

## Editing

`0000_init.sql` is **hand-maintained**, not the output of
`drizzle-kit generate`. The schema relies on Postgres features the
auto-generator doesn't model (partitioning, extensions, HNSW /
pgroonga index types), and keeping a regenerable baseline would
silently drop them on every regenerate.

When you change `src/db/schema.ts`:

1. Run `bun run db:generate` and read the output as a **diff
   reference** for what drizzle-kit thinks should change. Do **not**
   commit its raw output as a new `000N_*.sql` file.
2. Hand-write `000N_<short_name>.sql` here, applying the diff plus
   any Postgres-feature gaps drizzle-kit missed (partition clauses,
   index types, CHECK shapes).
3. Add a matching journal entry in `meta/_journal.json`.
4. Add a regression test for any data migration in
   `tests/integration/migrate.test.ts`.

`meta/0000_snapshot.json` is the drizzle-kit auto-generated state.
It is **not** consulted at runtime; it only affects the diff
emitted by `drizzle-kit generate`. It may lag behind
`0000_init.sql` for the Postgres features drizzle-kit can't model.
Regenerate it (`bun run db:generate`) before each diff run so
follow-on `generate` calls anchor on a fresh baseline.

## Running

- `bun run db:migrate` — apply every pending migration to
  `$DATABASE_URL`.
- `bun run db:push` — sync `schema.ts` to a development DB without
  emitting a migration file. **Dev only**; loses partitioning and
  extension setup so production must always run `db:migrate`.
- `bun run db:generate` — emit a draft migration file from a
  `schema.ts` diff; output is for reference, do not commit as-is.
