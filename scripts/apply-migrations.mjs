// Applies the Flyway migrations in db/migration to DATABASE_URL, in version
// order, without needing the Flyway CLI or Docker. Intended for pointing a
// fresh database (e.g. a new Supabase project) at the canonical schema.
//
// It records what it applied in the same `flyway_schema_history` table the
// real Flyway CLI uses (checksum left NULL — if you later run the actual
// Flyway CLI against this database, run `flyway repair` once to backfill
// checksums, or keep using this script; both skip already-applied versions).
//
// Usage:  node scripts/apply-migrations.mjs
//   DATABASE_URL is read from the environment, falling back to .env.local.
//   MIGRATIONS_DIR overrides the migration folder (default: db/migration).
//
// Idempotent: re-running applies only versions not yet in the history table.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const migrationsDir = process.env.MIGRATIONS_DIR ?? join(repoRoot, "db", "migration");

// DATABASE_URL from the environment, else parsed out of .env.local — same
// precedence the app itself uses (see vitest.config.ts / lib/env.ts).
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  const envFile = join(repoRoot, ".env.local");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (match) databaseUrl = match[1].replace(/^["']|["']$/g, "");
  }
}
if (!databaseUrl) {
  console.error("No DATABASE_URL found (environment or .env.local). Nothing to migrate against.");
  process.exit(1);
}

const require = createRequire(join(repoRoot, "package.json"));
const postgres = require("postgres");

// Supabase requires TLS; a plain string without sslmode still works because
// postgres.js honours sslmode in the URL, and `prepare: false` keeps the
// script compatible with Supavisor transaction-mode pools too.
const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });

const files = readdirSync(migrationsDir)
  .filter((f) => /^V\d+__.+\.sql$/.test(f))
  .sort((a, b) => Number(a.match(/^V(\d+)__/)[1]) - Number(b.match(/^V(\d+)__/)[1]));

if (files.length === 0) {
  console.error(`No V*__*.sql files found in ${migrationsDir}`);
  process.exit(1);
}

try {
  // The real Flyway DDL for its history table (community edition, Postgres).
  await sql`
    CREATE TABLE IF NOT EXISTS flyway_schema_history (
      installed_rank integer NOT NULL PRIMARY KEY,
      version varchar(50),
      description varchar(200) NOT NULL,
      type varchar(20) NOT NULL,
      script varchar(1000) NOT NULL,
      checksum integer,
      installed_by varchar(100) NOT NULL,
      installed_on timestamp NOT NULL DEFAULT now(),
      execution_time integer NOT NULL,
      success boolean NOT NULL
    )`;
  await sql`
    CREATE INDEX IF NOT EXISTS flyway_schema_history_s_idx
      ON flyway_schema_history (success)`;

  const appliedRows = await sql`
    SELECT version FROM flyway_schema_history WHERE success AND version IS NOT NULL`;
  const applied = new Set(appliedRows.map((r) => r.version));
  let [{ rank }] = await sql`
    SELECT coalesce(max(installed_rank), 0) AS rank FROM flyway_schema_history`;
  rank = Number(rank);

  let count = 0;
  for (const file of files) {
    const [, version, description] = file.match(/^V(\d+)__(.+)\.sql$/);
    if (applied.has(version)) {
      console.log(`- V${version} already applied, skipping (${file})`);
      continue;
    }
    const body = readFileSync(join(migrationsDir, file), "utf8");
    const started = Date.now();
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        INSERT INTO flyway_schema_history
          (installed_rank, version, description, type, script,
           checksum, installed_by, execution_time, success)
        VALUES
          (${++rank}, ${version}, ${description.replaceAll("_", " ")}, 'SQL', ${file},
           NULL, current_user, ${Date.now() - started}, true)`;
    });
    console.log(`✓ V${version} applied (${file})`);
    count++;
  }
  console.log(
    count === 0
      ? `Database already up to date (${applied.size} migrations present).`
      : `Done — applied ${count} migration(s), ${applied.size + count} total.`,
  );
} finally {
  await sql.end();
}
