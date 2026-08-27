/**
 * Next's startup hook — the port of the moment Spring Boot's context finishes
 * refreshing and `@EnableScheduling` (`DroneMissionsApplication`) hands the
 * `@Scheduled` methods to its task scheduler.
 *
 * Spring gets that moment for free: there is exactly one process, it boots
 * once, and the annotation scanner runs inside it. Next has no equivalent
 * "main" — the app is a set of modules a router pulls in on demand, so the
 * only sanctioned place to run code once per server boot is this file's
 * `register()` export (`src/instrumentation.ts`, alongside `src/app/`).
 * Instrumentation is stable in Next 15, so `next.config.ts` needs no flag for
 * it; the file's presence is the whole opt-in.
 *
 * All this module does is decide *whether* this particular process should own
 * the scheduler, and delegate to `startScheduler()` if so. The schedule itself
 * (cron string, zone, idempotence, error swallowing) lives in
 * `src/lib/scheduler.ts` — see that file.
 *
 * SOURCE: drone-missions-backend/.../DroneMissionsApplication.java (`@EnableScheduling`)
 */

/**
 * Called by Next once per server runtime, before the first request is served.
 *
 * `register()` is called in more situations than "the server just started
 * serving traffic", and a cron timer is wrong in every one of the others.
 * Four guards rule those out, and the *shape* of the first one is load-bearing
 * rather than stylistic:
 *
 * 1. **`NEXT_RUNTIME === "nodejs"`, written inline around the import.** Next
 *    compiles this file once per runtime, so with a `middleware.ts` in the
 *    project it is also built for the Edge runtime — where `node-cron` has no
 *    timers to use and the sweep's transitive `postgres.js` cannot resolve
 *    `net`/`tls`/`crypto` at all. A *dynamic* `import()` is not by itself
 *    enough to keep that out of the Edge bundle: webpack still follows it and
 *    fails the build ("Module not found: Can't resolve 'tls'"). What actually
 *    keeps it out is this comparison sitting literally inside the `if` that
 *    wraps the import — Next's DefinePlugin substitutes the runtime's own
 *    value, webpack folds `"edge" === "nodejs"` to false at parse time, and
 *    the whole branch (import included) is never added to that graph. Hoisting
 *    the condition into a helper, or writing it as an early `return`, defeats
 *    the folding and breaks `next build`. Leave it where it is.
 * 2. **`NEXT_PHASE !== "phase-production-build"`.** `next build` evaluates
 *    instrumentation while collecting page data. Registering there would pin a
 *    09:00 timer to the build process and, if a build ever straddled 09:00,
 *    run a real sweep against the real database from CI. Builds schedule
 *    nothing.
 * 3. **`NODE_ENV !== "test"` and no `VITEST`.** A stray live timer outliving a
 *    test file is exactly the flakiness `stopScheduler()` exists to prevent.
 *    The suites drive the scheduler explicitly (`scheduler.test.ts`) or call
 *    `runOverdueSweep()` directly (`overdue-sweep.test.ts`); neither wants it
 *    started behind its back.
 * 4. **No `VERCEL`.** On a serverless host there is no long-lived process to
 *    hold a timer: a lambda is frozen seconds after it responds and reclaimed
 *    within minutes, so a 09:00 timer registered here would essentially never
 *    fire — and `scheduler.ts`'s `unref: true` guarantees it could not hold
 *    the process open even if it wanted to. Registering it anyway would only
 *    drag the `scheduler → overdue-sweep → email.service → mission.cache`
 *    module graph into every cold start and log a start line for a job that
 *    never runs. There, `vercel.json`'s `crons` entry drives
 *    `GET /api/cron/overdue-sweep` instead — see that route for the full
 *    reasoning. The two mechanisms are mutually exclusive by environment.
 *
 * All five are read from `process.env` rather than `@/lib/env`: they are
 * Next's, the runner's and the host's own variables, not the app's
 * configuration schema, and they are absent by design in most processes.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (
      process.env.NEXT_PHASE === "phase-production-build" ||
      process.env.NODE_ENV === "test" ||
      process.env.VITEST ||
      process.env.VERCEL
    ) {
      return;
    }

    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
