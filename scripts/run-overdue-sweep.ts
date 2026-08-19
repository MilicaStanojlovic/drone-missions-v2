import { closeDb } from "@/db/client";
import { runOverdueSweep } from "@/features/notifications/overdue-sweep";

/**
 * One-shot, out-of-band trigger for the overdue sweep.
 *
 * `src/lib/scheduler.ts` runs `runOverdueSweep()` daily at 09:00
 * Europe/Belgrade, which is exactly the wrong granularity for a test: an e2e
 * run cannot wait for tomorrow morning, and reaching into the app process to
 * fire the cron task early would prove the scheduler works rather than the
 * sweep. This script is the same entry point the scheduler calls, run once
 * against the same `DATABASE_URL`, so `e2e/overdue.spec.ts` can say "one sweep
 * happened now" and then "another one happened now" and observe what the pilot
 * sees in between.
 *
 * Run it with `tsx` and the `react-server` export condition — the sweep's
 * module graph starts with `import "server-only"`, whose default entry throws
 * by design and only resolves to a no-op under that condition (the same
 * mechanism `vitest.config.ts` reproduces with an alias, and Next's bundler
 * with its own resolver):
 *
 * ```
 * node node_modules/tsx/dist/cli.mjs --conditions=react-server scripts/run-overdue-sweep.ts
 * ```
 *
 * Deliberately no top-level `await`: this package is CommonJS (no
 * `"type": "module"`), so `tsx` compiles a `.ts` file here to CJS, where a
 * top-level await is a transform error.
 */
async function main(): Promise<void> {
  try {
    await runOverdueSweep();
  } finally {
    // The sweep opens the shared `postgres.js` pool on first query; without
    // this the process would sit on an idle connection until its socket
    // timed out instead of exiting when the sweep is done.
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  // Not `process.exit`: pino writes asynchronously, and a hard exit here can
  // truncate the very log line explaining the failure.
  process.exitCode = 1;
});
