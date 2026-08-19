import "server-only";
import { z } from "zod";

/**
 * Typed, fail-fast environment configuration.
 *
 * Ports the configuration surface of the Spring Boot backend's
 * `application.properties` (and the `MAIL_ENABLED`/mail-from override shape
 * documented in `application-local.properties`) into a single Zod-validated
 * object. Parsing happens once, eagerly, against `process.env`; any missing
 * required variable or malformed value throws immediately with a readable
 * summary of every violation — instead of the app booting successfully and
 * failing confusingly later, deep inside a request handler.
 *
 * `DATABASE_URL` / `FLYWAY_URL` are deliberately *optional* at parse time:
 * this phase has no Supabase project wired up yet, so `next build`,
 * `next dev`, and the test suite must all be able to boot without a
 * database. The capability that actually needs a connection
 * (`src/db/client.ts`) is responsible for throwing its own clear error the
 * first time a query runs without `DATABASE_URL` configured — this module
 * only guarantees the *shape* of the value when one is present.
 *
 * Source of truth (Spring):
 * - drone-missions-backend/drone-missions/src/main/resources/application.properties
 * - drone-missions-backend/drone-missions/src/main/resources/application-local.properties
 *
 * Discrepancy from source (intentional, noted for the record): Spring's
 * `security.jwt.secret` falls back to a committed dev-default string when
 * `SECURITY_JWT_SECRET` is unset. This port makes `JWT_SECRET` strictly
 * required instead — shipping a working default secret would mean every
 * clone of this repo is HS256-signing tokens with the same publicly-known
 * key, which is a materially worse default for a codebase whose deployment
 * target (Vercel/Supabase) has no per-environment secret vaulting built in
 * the way a local Spring run profile does. The ≥32-byte *rule* is ported
 * unchanged; the fallback *value* is not.
 */

/**
 * Parses an env-var string into a boolean, tolerating "true"/"false" in any
 * case. Deliberately NOT `z.coerce.boolean()`: that coerces via `Boolean(x)`,
 * under which the literal string `"false"` is truthy and would silently
 * enable mail sending for anyone who sets `MAIL_ENABLED=false`.
 */
function booleanFromEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
    // Leave anything else untouched so the boolean schema below rejects it
    // with a clear "not a boolean" validation error.
    return value;
  }, z.boolean());
}

/** HS256 requires a key of at least 32 bytes. */
const MIN_JWT_SECRET_BYTES = 32;

export const envSchema = z.object({
  // --- Database / Flyway (spring.datasource.*, spring.flyway.*) ---
  // Optional at parse time: no DB is provisioned in this phase yet.
  DATABASE_URL: z.string().min(1, "DATABASE_URL must not be empty when provided").optional(),
  FLYWAY_URL: z.string().min(1, "FLYWAY_URL must not be empty when provided").optional(),

  // --- JWT (security.jwt.*) ---
  JWT_SECRET: z
    .string({ error: "JWT_SECRET is required" })
    .refine(
      (value) => new TextEncoder().encode(value).length >= MIN_JWT_SECRET_BYTES,
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes (HS256 requirement)`,
    ),
  JWT_EXPIRATION_MS: z.coerce
    .number({ error: "JWT_EXPIRATION_MS must be a number" })
    .int("JWT_EXPIRATION_MS must be an integer")
    .positive("JWT_EXPIRATION_MS must be positive")
    .default(86400000),

  // --- Mail (app.mail.*) ---
  MAIL_ENABLED: booleanFromEnv(false),
  MAIL_FROM: z.string().min(1).default("DroneMissions <no-reply@dronemissions.app>"),
  RESEND_API_KEY: z.string().min(1).optional(),

  // --- Mission cache (app.cache.mission.*) ---
  // Ports `MissionCacheProperties`, defaults and all. `enabled=false` is not a
  // runtime branch: it makes `getMissionDao()` return the uncached query module
  // itself, exactly as the Spring config never creates the decorator bean.
  // The TTL is milliseconds here rather than Spring's `5m`/`PT5M` Duration
  // string, matching JWT_EXPIRATION_MS above.
  MISSION_CACHE_ENABLED: booleanFromEnv(true),
  MISSION_CACHE_TTL_MS: z.coerce
    .number({ error: "MISSION_CACHE_TTL_MS must be a number" })
    .int("MISSION_CACHE_TTL_MS must be an integer")
    .positive("MISSION_CACHE_TTL_MS must be positive")
    .default(300000),
  MISSION_CACHE_MAX_SIZE: z.coerce
    .number({ error: "MISSION_CACHE_MAX_SIZE must be a number" })
    .int("MISSION_CACHE_MAX_SIZE must be an integer")
    .positive("MISSION_CACHE_MAX_SIZE must be positive")
    .default(1000),
  MISSION_CACHE_LIST_MAX_SIZE: z.coerce
    .number({ error: "MISSION_CACHE_LIST_MAX_SIZE must be a number" })
    .int("MISSION_CACHE_LIST_MAX_SIZE must be an integer")
    .positive("MISSION_CACHE_LIST_MAX_SIZE must be positive")
    .default(200),

  // --- Server port (server.port) ---
  PORT: z.coerce
    .number({ error: "PORT must be a number" })
    .int("PORT must be an integer")
    .positive("PORT must be positive")
    .default(8085),

  // --- Logging (pino) ---
  // No direct Spring equivalent (Logback's `logging.level.*` isn't exposed
  // as an env var in application.properties); introduced for src/lib/logger.ts.
  // Defaults to "info" in production and "debug" outside it so local/dev
  // runs are chatty by default without needing an extra env var set.
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], {
      error: "LOG_LEVEL must be one of: fatal, error, warn, info, debug, trace, silent",
    })
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates the given environment source (defaults to
 * `process.env`). Exported separately from the `env` singleton below so
 * tests can exercise fail-fast/default/rejection behavior against
 * hand-built fixtures without mutating global `process.env`.
 *
 * Throws a single `Error` whose message lists every violation (field +
 * reason) on failure, so a misconfigured deployment fails loudly at boot.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/** The validated, process-wide environment. Fails fast on import. */
export const env = loadEnv();
