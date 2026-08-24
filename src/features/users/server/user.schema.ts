import "server-only";
import { z } from "zod";
import { USER_ROLES } from "@/db/schema";

/**
 * Query-parameter validation for the admin user listing (replaces what
 * Spring's `WebDataBinder`/`ConversionService` does to
 * `@RequestParam(required = false) UserRole role` before
 * `UserController.all` is ever entered).
 *
 * There is no request *body* DTO for any of this phase's user endpoints —
 * `suspend`/`reactivate` take only the path variable — so this module holds
 * the one input the listing accepts.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/controller/user/UserController.java (`all`)
 * - org.springframework.core.convert.support.StringToEnumConverterFactory
 */

/**
 * The optional `?role` filter, converted the way Spring converts a
 * `@RequestParam` of enum type:
 *
 * - absent -> `null`, which `UserRepository.search` reads as "everyone"
 *   (`:role is null or u.role = :role`);
 * - **empty string -> `null`** as well. This is not a liberty: Spring's
 *   `StringToEnum.convert` starts with `if (source.isEmpty()) return null;`,
 *   and it matters here because the Angular admin filter is a `<select>` whose
 *   "All roles" option has the value `''` (see the frontend's
 *   `UserListQuery.role?: UserRole | ''`). Rejecting `?role=` would break the
 *   "clear the filter" path.
 * - anything else -> the matching `UserRole`, or a 400. Spring answers
 *   `MethodArgumentTypeMismatchException` -> 400 for an unknown enum name;
 *   parsing through Zod routes the same rejection onto
 *   `withErrorHandling()`'s validation branch, the mechanism this port uses
 *   for every bad parameter.
 *
 * The `.trim()` mirrors `Enum.valueOf(this.enumType, source.trim())` on the
 * same line of that converter — with the consequence, faithfully reproduced,
 * that a whitespace-only `?role=%20` is *not* the empty-string case (it is
 * not `isEmpty()`) and so fails conversion rather than meaning "everyone".
 */
export const userListQuerySchema = z.object({
  role: z.preprocess(
    (value) => (typeof value === "string" ? (value === "" ? null : value.trim()) : value),
    z.enum(USER_ROLES, { error: "must be a valid user role" }).nullish(),
  ),
});

export type UserListQueryInput = z.infer<typeof userListQuerySchema>;
