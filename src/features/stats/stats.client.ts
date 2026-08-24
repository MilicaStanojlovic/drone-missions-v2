import { apiFetch } from "@/features/auth/auth.client";
import { ensureOk } from "@/lib/api/client";
import type { PlatformStats } from "@/features/stats/stats.types";

/**
 * Client-side platform-stats access: the one snapshot call the admin overview
 * makes. Ports `services/platform-stats.service.ts` and `models/stats.model.ts`.
 *
 * Only the browser half lives here. The server half — `stats.types.ts`,
 * `stats.service.ts` and the `GET /api/v1/platform-stats` route behind it — is
 * Phase 9's ("Platform stats dashboard", which depends on every data vertical,
 * see MIGRATION_PLAN.md §7).
 *
 * The snapshot shape itself is no longer written down here: it was, while this
 * file was the only place in the repo that knew it, and Phase 9 moved that one
 * declaration server-side to `stats.types.ts` (beside the service that builds
 * it, as `RatingSummary` sits beside its queries) and re-exports it below.
 * That is the direction every other feature runs — `audit.client.ts` derives
 * `AuditLogEntry` from `audit.types.ts` the same way — and it leaves the API
 * response and the component that renders it typed by a single interface with
 * nothing to drift.
 *
 * `import type` is erased at compile time, so re-exporting from a
 * `server-only` module (and from `@/db/schema`, which pulls in
 * `drizzle-orm/pg-core`) emits no runtime import — the same technique
 * `auth.client.ts`, `mission.client.ts` and `audit.client.ts` use.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/platform-stats.service.ts
 * - drone-missions-frontend/.../models/stats.model.ts
 * - drone-missions-backend/.../web/dto/stats/PlatformStatsResponse.java
 * - drone-missions-backend/.../web/controller/stats/PlatformStatsController.java
 */

/**
 * The wire shape of `GET /api/v1/platform-stats`, and one bar of its
 * bids-per-mission chart. Identical to what the service returns — the source's
 * `PlatformStatsMapper` copies its record across field for field — so the
 * response is typed by the server declaration rather than a transcription of
 * it. Mirrors the Angular `stats.model.ts` pair.
 */
export type { PlatformStats, TopMission } from "@/features/stats/stats.types";

/** One snapshot of the platform counts (admin-only endpoint). Ports `getOverview`. */
export async function fetchPlatformStats(): Promise<PlatformStats> {
  const response = await ensureOk(await apiFetch("/api/v1/platform-stats"));
  return (await response.json()) as PlatformStats;
}
