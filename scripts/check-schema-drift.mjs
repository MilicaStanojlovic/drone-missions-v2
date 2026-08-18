#!/usr/bin/env node
/**
 * `pnpm db:check` — real schema-drift guard for the Flyway <-> Drizzle mirror.
 *
 * `drizzle-kit check` (the bare CLI command) only validates the internal
 * consistency of a migration-*snapshot history* under a drizzle-kit `out`
 * folder — it never talks to a database. Run with no snapshots and no
 * DATABASE_URL, it prints "Everything's fine" and exits 0 unconditionally.
 * This project never runs `drizzle-kit generate`/`migrate` for real (Flyway
 * owns all DDL — see flyway.conf, db/migration/), so that snapshot history
 * never exists here, which made bare `drizzle-kit check` a permanent no-op
 * regardless of actual drift, even once a database exists.
 *
 * This script performs the real comparison instead, using drizzle-kit's own
 * normalized snapshot format so hand-written comments and the `$type<...>()`
 * TS-only literal-union narrowing in src/db/schema.ts (invisible at the SQL
 * level) never cause a false positive:
 *
 *   1. `drizzle-kit generate` against src/db/schema.ts into a throwaway temp
 *      dir. Entirely offline (no DB touched, nothing written inside the
 *      repo) — produces a snapshot JSON of what the schema mirror SHOULD be.
 *   2. `drizzle-kit introspect` (read-only) against the live, Flyway-managed
 *      DATABASE_URL into a second throwaway temp dir — a snapshot JSON of
 *      what the database ACTUALLY is.
 *   3. Deep-compares the structural fields of both snapshots (tables,
 *      columns, enums, indexes, FKs, sequences) — ignoring the snapshot's
 *      own migration-bookkeeping fields (id/prevId/_meta/version), which
 *      differ between the two runs by construction and carry no schema
 *      information.
 *
 * CHECK constraints are deliberately excluded from the per-table comparison
 * (see `stripCheckConstraintText` below): Postgres rewrites a CHECK
 * expression into its own normalized form when it stores it — this schema's
 * `status IN ('DRAFT', ...)` columns come back from `introspect` as
 * `((status)::text = ANY (ARRAY[...]))`. Comparing that text verbatim would
 * flag every one of this schema's eight CHECK constraints as "drifted" on
 * the very first real run against a real database, even with zero actual
 * drift — a red CI that says nothing. This is a known, intentional gap:
 * an actually-changed CHECK condition (with the constraint name unchanged)
 * will NOT be caught by `pnpm db:check`; review CHECK constraints by hand
 * when a migration touches one.
 *
 * Exits non-zero with a readable table-level diff on drift; exits 0 when the
 * two snapshots match structurally. Requires DATABASE_URL — CI only runs
 * this step when one is configured (see .github/workflows/ci.yml); running
 * it locally with no DATABASE_URL fails fast with a clear message instead of
 * a raw connection error, mirroring src/db/client.ts's lazy-throw pattern.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const drizzleKitBin = path.join(repoRoot, "node_modules", "drizzle-kit", "bin.cjs");
const schemaPath = path.join(repoRoot, "src", "db", "schema.ts");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL not configured — pnpm db:check compares src/db/schema.ts against a live, " +
      "Flyway-migrated database, so it needs one to check against. Set DATABASE_URL in " +
      ".env.local (or the environment) first. See .env.example.",
  );
  process.exit(1);
}

function runDrizzleKit(args, label) {
  try {
    execFileSync(process.execPath, [drizzleKitBin, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout = error.stdout?.toString() ?? "";
    const stderr = error.stderr?.toString() ?? "";
    throw new Error(`${label} failed:\n${stdout}\n${stderr}`);
  }
}

/** Recursively finds the single `*_snapshot.json` drizzle-kit wrote under `dir`. */
function findSnapshotFile(dir) {
  const found = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith("_snapshot.json")) found.push(full);
    }
  }
  walk(dir);
  if (found.length !== 1) {
    throw new Error(
      `Expected exactly one *_snapshot.json under ${dir}, found ${found.length}` +
        (found.length ? `: ${found.join(", ")}` : "") +
        ". drizzle-kit's output layout may not match what this script assumes — inspect the " +
        "directory manually before trusting this check.",
    );
  }
  return JSON.parse(readFileSync(found[0], "utf8"));
}

/** Sorts object keys recursively so two structurally-identical snapshots produced by
 * different drizzle-kit commands stringify identically regardless of key order. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

// Fields that carry actual schema information. `id`/`prevId`/`_meta` are
// per-run migration-history bookkeeping that legitimately differs between
// an offline `generate` run and a live `introspect` run even with zero
// drift, so they're deliberately excluded from the comparison.
const STRUCTURAL_KEYS = [
  "dialect",
  "tables",
  "enums",
  "schemas",
  "sequences",
  "roles",
  "policies",
  "views",
];

/**
 * Drops each table's `checkConstraints` block entirely rather than comparing
 * it. `generate` and `introspect` legitimately disagree on the *text* of a
 * CHECK expression (see the header comment), and they aren't guaranteed to
 * agree on constraint *names* either for an unnamed CHECK (drizzle-kit's own
 * auto-naming vs. Postgres's), so even a name-only comparison risks the same
 * false positive. Excluding the block keeps the check honest about what it
 * verifies: added/removed/renamed tables, columns, indexes, and foreign
 * keys, not CHECK constraint content.
 */
function stripCheckConstraintText(tables) {
  const result = {};
  for (const [tableName, table] of Object.entries(tables ?? {})) {
    const rest = { ...table };
    delete rest.checkConstraints;
    result[tableName] = rest;
  }
  return result;
}

function structural(snapshot) {
  const picked = {};
  for (const key of STRUCTURAL_KEYS) picked[key] = snapshot[key] ?? null;
  if (picked.tables) picked.tables = stripCheckConstraintText(picked.tables);
  return sortKeysDeep(picked);
}

function diffTableNames(mirrorTables, liveTables) {
  const allNames = new Set([...Object.keys(mirrorTables), ...Object.keys(liveTables)]);
  const lines = [];
  for (const name of [...allNames].sort()) {
    const inMirror = mirrorTables[name];
    const inLive = liveTables[name];
    if (!inMirror) {
      lines.push(`  + ${name} — exists in the live database but not in src/db/schema.ts`);
    } else if (!inLive) {
      lines.push(`  - ${name} — exists in src/db/schema.ts but not in the live database`);
    } else if (JSON.stringify(sortKeysDeep(inMirror)) !== JSON.stringify(sortKeysDeep(inLive))) {
      lines.push(`  ~ ${name} — columns/constraints/indexes differ`);
    }
  }
  return lines;
}

let mirrorDir;
let liveDir;
let failed = false;

try {
  mirrorDir = mkdtempSync(path.join(tmpdir(), "drone-missionsv2-schema-mirror-"));
  liveDir = mkdtempSync(path.join(tmpdir(), "drone-missionsv2-schema-live-"));

  runDrizzleKit(
    [
      "generate",
      "--dialect=postgresql",
      `--schema=${schemaPath}`,
      `--out=${mirrorDir}`,
      "--name=mirror",
    ],
    "drizzle-kit generate (src/db/schema.ts)",
  );
  runDrizzleKit(
    ["introspect", "--dialect=postgresql", `--out=${liveDir}`, `--url=${databaseUrl}`],
    "drizzle-kit introspect (live DATABASE_URL)",
  );

  const mirrorSnapshot = structural(findSnapshotFile(mirrorDir));
  const liveSnapshot = structural(findSnapshotFile(liveDir));

  if (JSON.stringify(mirrorSnapshot) === JSON.stringify(liveSnapshot)) {
    console.log("db:check — src/db/schema.ts matches the live database. No drift detected.");
  } else {
    failed = true;
    console.error("db:check — src/db/schema.ts has drifted from the live database:\n");
    console.error(
      diffTableNames(mirrorSnapshot.tables ?? {}, liveSnapshot.tables ?? {}).join("\n"),
    );
    console.error(
      "\nRun `pnpm db:pull` to regenerate src/db/schema.ts from the live database, re-apply " +
        "the header comment / CHECK-constraint string-literal-union narrowing documented at the " +
        "top of that file, and commit the result.",
    );
  }
} catch (error) {
  failed = true;
  console.error(`db:check — could not complete the comparison:\n\n${error.message}`);
} finally {
  // Keep the scratch dirs around on failure so a human can inspect the raw
  // snapshots; only clean up on a clean pass.
  if (!failed) {
    if (mirrorDir) rmSync(mirrorDir, { recursive: true, force: true });
    if (liveDir) rmSync(liveDir, { recursive: true, force: true });
  } else if (mirrorDir && liveDir) {
    console.error(
      `\nRaw snapshots left for inspection:\n  mirror: ${mirrorDir}\n  live:   ${liveDir}`,
    );
  }
}

process.exit(failed ? 1 : 0);
