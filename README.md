# drone-missionsv2

Unified Next.js 15 (App Router) + React 19 + TypeScript + Drizzle + Supabase-Postgres app,
re-platforming the `drone-missions` Spring Boot backend and Angular frontend. See
[`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) for the full architecture and phase-by-phase plan.

## Setup

```bash
pnpm install
cp .env.example .env.local
# Fill in JWT_SECRET in .env.local — it's the one required value with no
# default (`openssl rand -base64 32`; see .env.example's comment on why).
# Every other var is optional in this phase and can stay as shipped.
pnpm dev
```

## Scripts

| Script            | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `pnpm dev`        | Run the Next.js dev server                            |
| `pnpm build`      | Production build                                      |
| `pnpm lint`       | ESLint                                                |
| `pnpm typecheck`  | `tsc --noEmit`                                        |
| `pnpm test`       | Vitest unit/integration suite                         |
| `pnpm test:e2e`   | Playwright e2e suite                                  |
| `pnpm db:migrate` | Apply Flyway migrations (`db/migration/`) — see below |

## Database migrations (Flyway)

**Schema is owned by Flyway, not Drizzle.** The migrations in [`db/migration/`](./db/migration)
(`V1__create_mission_table.sql` … `V18__drop_mission_restored_audit_action.sql`) are copied
byte-for-byte, unchanged, from the original Spring backend's
`src/main/resources/db/migration/`. Never hand-write new DDL and never let Drizzle migrate the
schema — `src/db/schema.ts` only _mirrors_ the Flyway-managed shape (via `drizzle-kit pull` or by
hand-mirroring the migrations exactly). See `MIGRATION_PLAN.md` §2–3 and §8.

### Prerequisites

- The [Flyway CLI](https://documentation.red-gate.com/fd/command-line-241409161.html) installed
  and on `PATH` (or apply migrations with `node scripts/apply-migrations.mjs`, which needs no Flyway CLI).
- A reachable Postgres instance (Supabase dev project, or a local Postgres) and its JDBC
  connection string in `FLYWAY_URL`.

### Running migrations

1. Fill `FLYWAY_URL` in `.env.local` (JDBC form, e.g.
   `jdbc:postgresql://[project-ref].pooler.supabase.com:5432/postgres`).
2. Export it into the shell — the Flyway CLI does not read `.env` files itself, but it does
   automatically map the `FLYWAY_URL` environment variable onto its own `flyway.url` config key:
   ```bash
   set -a; source .env.local; set +a
   ```
3. Run:
   ```bash
   pnpm db:migrate
   # equivalent to: flyway -configFiles=flyway.conf migrate
   ```

Configuration lives in [`flyway.conf`](./flyway.conf): migrations are read from
`filesystem:db/migration`, and `baselineOnMigrate=false` (matching the Spring backend's
`spring.flyway.baseline-on-migrate=false` in `application.properties`) — every target database is
expected to start clean from `V1`, never adopted mid-history.

### Status

No database is configured for this environment yet, so an actual `migrate` run is **skipped — no
DB configured**. The command above works as soon as `.env.local`'s `FLYWAY_URL` is filled in.

## Drizzle schema mirror

[`src/db/schema.ts`](./src/db/schema.ts) is a hand-written mirror of the table shape produced by
running all 18 Flyway migrations, in order, against a fresh database — transcribed directly from
`db/migration/V1__create_mission_table.sql` … `V18__drop_mission_restored_audit_action.sql`.
Drizzle never owns the schema and never runs `migrate`/`push`; it only queries and mirrors.

- **Regeneration** (once a database is migrated and reachable): `pnpm db:pull`, i.e.
  `drizzle-kit pull` — introspects the live, Flyway-migrated database and regenerates
  `src/db/schema.ts` from the real catalog. That output supersedes the hand-mirror the moment a
  database exists.
- **CI drift guard**: `pnpm db:check`, i.e. `node scripts/check-schema-drift.mjs` — **not** bare
  `drizzle-kit check`, which only validates a migration-snapshot _history_ against itself and
  never talks to a database (a permanent no-op here, since this project never runs
  `drizzle-kit generate`/`migrate` for real). The script instead runs `drizzle-kit generate`
  against this file and `drizzle-kit introspect` against the live database, each into a
  throwaway temp dir, and deep-compares their normalized snapshot JSON — immune to the
  comment/`$type<...>()` noise a raw file diff of the two would produce. Fails the build the
  moment the mirror drifts from the Flyway-managed truth; see the script's header comment for
  the full mechanism.

Both commands read `DATABASE_URL` from [`drizzle.config.ts`](./drizzle.config.ts). Status here:
**skipped — no DB configured** (same as the Flyway `migrate` above).
