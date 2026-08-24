import "server-only";
import pino from "pino";
import { env } from "@/lib/env";

/**
 * Structured logger (replaces `@Slf4j`/Logback).
 *
 * A single process-wide `pino` instance. Level comes from `LOG_LEVEL` when
 * set; otherwise defaults to "info" in production and "debug" everywhere
 * else, so local/dev runs are chatty without requiring an extra env var.
 *
 * No Spring `application.properties` equivalent exists for this (Logback's
 * `logging.level.*` isn't exposed as an env var there) — this module is new,
 * introduced to give route handlers and services a structured logger, most
 * notably for `withErrorHandling()` (`src/lib/api/handler.ts`) to log the
 * full detail of unexpected errors server-side while returning only the
 * generic "An unexpected error occurred" message to the client.
 */
export const logger = pino({
  level: env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
});
