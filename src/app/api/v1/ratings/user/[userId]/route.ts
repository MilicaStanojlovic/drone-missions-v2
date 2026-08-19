import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/api/handler";
import { toUserRatingsResponse, type UserRatingsResponse } from "@/features/ratings/rating.mapper";
import { receivedBy, summaryFor } from "@/features/ratings/rating.service";

/**
 * `GET /api/v1/ratings/user/{userId}` (replaces `RatingController.forUser`).
 *
 * "A user's average, count and comments — one call, since a profile shows all
 * three", as the source's own javadoc puts it. The endpoint is
 * `@PreAuthorize("isAuthenticated()")` and takes no principal at all: a
 * reputation is public to every signed-in user, which is the whole point of
 * showing it next to a bid, so there is nothing to compare the caller against
 * and no `getCurrentUser()` call below. `src/middleware.ts` supplies the
 * "signed in" part (this path is not in `PUBLIC_PATHS`).
 *
 * Note the asymmetry with the mission endpoint next door: *who rated whom on
 * which mission* is private to that mission's two participants, while *what a
 * user has been rated* is not.
 *
 * ## Where the two halves come from
 * The source composes the response out of two `RatingService` calls —
 * `summaryFor(userId)` for the headline numbers and `receivedBy(userId)` for
 * the reviews. This port keeps both calls, their order, and their layer: both
 * are imported from `rating.service.ts`. The aggregate behind `summaryFor` is
 * physically implemented in `rating.queries.ts` (Phase 2 put it there so
 * `mission.mapper.ts` could stamp a designer's rating onto every mission), and
 * the service re-exports it — so this handler names one layer and never reaches
 * into SQL itself. The shaping, as everywhere else in this port, is the
 * mapper's: `toUserRatingsResponse` is the port of the
 * `new UserRatingsResponse(...)` expression the Java controller writes inline.
 *
 * An unknown or never-rated user is **not** a 404 here, mirroring the source:
 * no user lookup happens at all, `summaryFor` answers `RatingSummary.NONE`
 * when the aggregate finds nothing, and `receivedBy` answers an empty list, so
 * the response is a well-formed `{average: 0, count: 0, ratings: []}`. A
 * profile with no reviews yet and a user id that never existed are the same
 * answer, which is what keeps the profile page free of a special case.
 *
 * SOURCE: drone-missions-backend/.../web/controller/rating/RatingController.java
 * (`forUser`)
 */

/** The dynamic segment this route file owns. */
type UserRatingsRouteContext = { params: Promise<{ userId: string }> };

/**
 * The path variable, validated the way `@PathVariable Long userId` is: Spring
 * converts it and answers 400 (`MethodArgumentTypeMismatchException`) when the
 * segment is not a number. Mirrors the id schemas on the mission/bid routes,
 * safe-integer bound included.
 */
const userIdSchema = z.object({
  userId: z
    .string()
    .regex(/^-?\d+$/, "must be a number")
    .refine((value) => Number.isSafeInteger(Number(value)), "must be a number")
    .transform(Number),
});

/**
 * One user's whole reputation: the average, the count, and the reviews behind
 * them. Mirrors `RatingController.forUser`.
 *
 * The two reads stay sequential, as in the source — the aggregate first, then
 * the rows — rather than being raced with `Promise.all`: they are two
 * statements on the same pool either way, and keeping the order makes the pair
 * read the way the Java expression does.
 */
export const GET = withErrorHandling<UserRatingsRouteContext>(async (_request, context) => {
  const { userId } = userIdSchema.parse(await context.params);

  const summary = await summaryFor(userId);
  const ratings = await receivedBy(userId);
  return NextResponse.json<UserRatingsResponse>(toUserRatingsResponse(summary, ratings));
});
