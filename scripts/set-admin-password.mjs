// Sets (resets) the seeded admin account's password to one you choose, so you
// can log in as ADMIN. The V12 migration seeds `admin@drone-missions.local`
// with a throwaway dev hash whose plaintext is not recorded anywhere; this
// script replaces that hash with the bcrypt of a password you supply, using
// the exact same hashing the app's auth uses (bcryptjs, cost 10).
//
// Usage:
//   node scripts/set-admin-password.mjs "your-new-password"
//
// DATABASE_URL is read from the environment, falling back to .env.local.
// The target admin email defaults to admin@drone-missions.local; override
// with ADMIN_EMAIL=... if you seeded a different one.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const require = createRequire(join(repoRoot, "package.json"));

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Usage: node scripts/set-admin-password.mjs "your-new-password"');
  console.error("(the app requires passwords of at least 8 characters)");
  process.exit(1);
}

let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  const envFile = join(repoRoot, ".env.local");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (match) databaseUrl = match[1].replace(/^["']|["']$/g, "");
  }
}
if (!databaseUrl) {
  console.error("No DATABASE_URL found (environment or .env.local).");
  process.exit(1);
}

const email = process.env.ADMIN_EMAIL ?? "admin@drone-missions.local";
const postgres = require("postgres");
const bcrypt = require("bcryptjs");

const hash = bcrypt.hashSync(password, 10);
const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  const rows = await sql`
    UPDATE users SET password_hash = ${hash}, updated_at = now()
    WHERE email = ${email} AND role = 'ADMIN'
    RETURNING id, username, email`;
  if (rows.length === 0) {
    console.error(
      `No ADMIN user with email ${email} found — did the migrations run? (check the users table)`,
    );
    process.exitCode = 1;
  } else {
    console.log(`✓ Password updated for admin: ${rows[0].email} (username "${rows[0].username}")`);
    console.log(`  Log in at /login with that email and the password you just set.`);
  }
} finally {
  await sql.end();
}
