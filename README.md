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
  and on `PATH` (or run it via the `flyway` service in `docker-compose.yml` once that lands).
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
DB configured**. The command above works as soon as `.env.local`'s `FLYWAY_URL` is filled in (or
the compose Postgres service is up, once `docker-compose.yml` lands later in Phase 0).

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

## Docker

Replaces the Spring backend's executable jar: [`Dockerfile`](./Dockerfile) is a multi-stage build
that produces a minimal image running the Next.js **standalone** server (`output: "standalone"`
in `next.config.ts`) as a long-running Node process — no source, no `node_modules` beyond what's
actually traced, no package manager in the final layer.

[`docker-compose.yml`](./docker-compose.yml) wires up the full local stack:

| Service  | Role                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`    | The image above. Reads its config from the same env vars as `pnpm dev` (see `.env.example`); `DATABASE_URL`/`FLYWAY_URL` default to the `db` service below so the stack works with zero configuration.                                 |
| `db`     | `postgres:16-alpine` — the documented drop-in **local fallback** for a Supabase dev project. Same Flyway-managed schema, just self-hosted. Its credentials are the source of the sample `DATABASE_URL`/`FLYWAY_URL` in `.env.example`. |
| `flyway` | Official Flyway image, one-shot. Mounts `db/migration/` (read-only) and `flyway.conf`; not part of the default `up` graph.                                                                                                             |

```bash
# Build + run the app (with Postgres as a dependency):
docker compose --env-file .env.local up app

# Apply V1..V18 to the compose Postgres:
docker compose --env-file .env.local run --rm flyway migrate

# Build the image directly, without compose:
docker build -t drone-missionsv2 .
```

Compose does **not** read `.env.local` automatically (it only auto-loads a file literally named
`.env`) — pass `--env-file .env.local` explicitly, or export the vars into your shell first. Every
var falls back to a localhost/`db`-service default if left unset, so `docker compose up` works
out of the box for local dev even with no env file at all; real Supabase/production values still
belong only in `.env.local`, never committed.

`JWT_SECRET` also has to be present at _build_ time (see the `Dockerfile`'s comment on why:
`next build` evaluates every route module, which imports the fail-fast env loader) — the build
stage uses a harmless placeholder for that, and it is never used at runtime: the standalone server
reads live `process.env` again the moment the container actually boots, so whatever `JWT_SECRET`
the `app` service (or your shell) supplies at `run`/`up` time is the one that's actually used to
sign tokens.

### Status

Verified in this environment: `docker build .` succeeds, `docker compose config` validates, and a
container built from the image serves `GET /api/health` → `200 {"status":"ok","db":"not_configured"}`
with a runtime-supplied `JWT_SECRET`. **Not** verified here — no DB configured in this environment:
booting the full compose stack against `db`, running `flyway migrate` for real, and the
`db: "up"` health-check path. Those become checkable the moment a database exists (Supabase or the
compose `db` service).
