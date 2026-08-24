import "server-only";
import { z } from "zod";
import { AUDIT_ACTIONS, USER_ROLES } from "@/db/schema";

/**
 * Query-parameter validation for the audit listing (replaces what Spring's
 * `WebDataBinder`/`ConversionService` does to `AuditLogController.list`'s four
 * `@RequestParam(required = false)` arguments before the method is entered).
 *
 * The audit read path has no request *body* at all — it is a single GET — so
 * this module holds the only input it accepts. Modelled on
 * `src/features/users/server/user.schema.ts`, whose `userListQuerySchema` ports the
 * same conversion for the one filter that listing takes.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/audit/AuditLogController.java (`list`)
 * - org.springframework.core.convert.support.StringToEnumConverterFactory
 * - org.springframework.core.convert.support.StringToNumberConverterFactory
 */

/**
 * Converts a `@RequestParam` of enum type the way Spring's `StringToEnum`
 * does: absent -> `null` ("not filtering"), **empty string -> `null` too**
 * (that converter opens with `if (source.isEmpty()) return null;`), anything
 * else -> `Enum.valueOf(type, source.trim())` or a 400.
 *
 * The empty-string case is load-bearing, not pedantry: the Angular audit
 * filters are `<select>`s whose "All" options have the value `''`
 * (`AuditLogQuery.role?: UserRole | ''`, `action?: AuditAction | ''`), and
 * although `AuditLogService.getPage` currently drops falsy filters before
 * sending, rejecting `?role=` would make "clear the filter" a 400 the moment
 * anything sent it. The `.trim()` mirrors the same converter line — with the
 * faithfully reproduced consequence that whitespace-only `?role=%20` is *not*
 * the empty case (it is not `isEmpty()`) and so fails conversion.
 */
function enumParam<T extends string>(values: readonly T[], label: string) {
  return z.preprocess(
    (value) => (typeof value === "string" ? (value === "" ? null : value.trim()) : value),
    z.enum(values, { error: `must be a valid ${label}` }).nullish(),
  );
}

/**
 * The four optional filters, each `null` when "not filtering":
 *
 * - **`actorId`** — `@RequestParam(required = false) Long`, converted by
 *   `StringToNumber`: empty string -> `null` (that converter, too, starts with
 *   an `isEmpty()` check), a non-numeric value -> 400
 *   (`MethodArgumentTypeMismatchException` there, a Zod rejection routed onto
 *   `withErrorHandling()`'s validation branch here). The integer test is the
 *   same one every `[id]` route in this port applies to a path variable, since
 *   both stand in for the same `Long` conversion — `NumberFormatException` on
 *   `"1.5"` or `"2x"` alike.
 * - **`action`** / **`role`** — enum conversion as described above. `role`
 *   filters on the row's *snapshotted* `actor_role`, not the account's current
 *   role, which is the whole point of that column existing (see
 *   `AuditLog.actorRole`'s javadoc: "so rows stay self-describing"). It is
 *   declared over `USER_ROLES` because the controller's parameter is a
 *   `UserRole`; the column's own `AuditActorRole` has the identical three
 *   values.
 * - **`q`** — a free-text `String`, passed through **raw**. No trimming, no
 *   lowercasing and no blank-to-null here on purpose: that normalisation is
 *   `AuditService.search`'s job in the source, and this port keeps it there
 *   (`audit.service.ts`), so the service's contract stays testable exactly as
 *   `AuditServiceTest` tests it.
 */
export const auditLogQuerySchema = z.object({
  actorId: z.preprocess(
    (value) => (typeof value === "string" ? (value === "" ? null : value.trim()) : value),
    z
      .string()
      .regex(/^-?\d+$/, "must be a number")
      .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
      .transform(Number)
      .nullish(),
  ),
  action: enumParam(AUDIT_ACTIONS, "audit action"),
  role: enumParam(USER_ROLES, "user role"),
  q: z.string().nullish(),
});

export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;
