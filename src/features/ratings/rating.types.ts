import type { rating } from "@/db/schema";

/**
 * Rating domain types (replaces `data.model.Rating` and the persistence half
 * of what the Angular `models/rating.model.ts` describes).
 *
 * A rating is **written once and never changed** — the entity has no
 * `updatedAt` for exactly that reason, and `rating_mission_rater_unique` (V11)
 * is what enforces it. There is therefore no "update" shape here, only
 * `RatingWrite` (in `rating.queries.ts`, next to the insert that consumes it)
 * and the loaded `Rating` below.
 *
 * Following the precedent of `bid.types.ts` / `notification.types.ts`, the two
 * relations the mapper reads are modelled as narrow structural shapes rather
 * than whole `Mission`/`User` rows: `RatingMapper.toResponse` touches exactly
 * `mission.getId()/getName()` and `rater.getId()/getUsername()`, so those are
 * the only fields a rating ever needs off them. Keeping them narrow is also
 * what keeps a mission's two `jsonb` flight-plan columns and a user's password
 * hash out of every rating list.
 *
 * DELIBERATE DIVERGENCE from the plan's wording: the plan describes this as a
 * "row-with-names" type, i.e. flat `missionName`/`raterName` fields as in the
 * Angular `Rating` model. That flat shape is the *wire* shape
 * (`web.dto.rating.RatingResponse`, which the Angular model mirrors
 * field-for-field) and it lands with `rating.mapper.ts`; the type here mirrors
 * the *entity*, whose relations the mapper reads the names off. This is the
 * same two-type split `bid.types.ts` already makes (`Bid` with resolved
 * `mission`/`pilot` relations, `BidResponse` flat with `missionName`/
 * `pilotName`), and the queries still carry both names on every row exactly as
 * the plan requires — via the joined relations rather than as flattened
 * columns.
 *
 * No `import "server-only"`: like `bid.types.ts`, this file is erasable
 * `import type` only (nothing from `@/db/schema` survives to runtime), so it
 * stays importable from browser code should a client component need the shape.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/model/Rating.java
 * - drone-missions-backend/.../src/main/resources/db/migration/V11__create_rating_table.sql
 * - drone-missions-backend/.../web/mapper/rating/RatingMapper.java
 * - drone-missions-frontend/.../models/rating.model.ts
 */

/**
 * The raw `rating` row exactly as Drizzle selects it.
 *
 * `score` is a `smallint` — a `number` here, a `Short` on the Java entity;
 * `rating_score_check` (V11) confines it to 1–5 either way. `comment` is
 * nullable `varchar(500)`, and there is no `updatedAt` column at all.
 */
export type RatingRow = typeof rating.$inferSelect;

/**
 * The mission a rating is about, reduced to the fields the rating layer reads
 * (`RatingMapper` takes `getId()` and `getName()` off the `@ManyToOne
 * Mission`). Any mission row is assignable to it.
 *
 * `name` is nullable because `mission.name` is (`varchar(255)`, no NOT NULL),
 * the same way `BidMission.name` already reflects.
 */
export interface RatingMission {
  id: number;
  name: string | null;
}

/**
 * The user who wrote a rating, reduced to the two fields the mapper reads off
 * the `@ManyToOne User rater` (`getId()`, `getUsername()`). A whole `User` row
 * is assignable to it, and unlike `User` it carries no password hash, so it is
 * safe to hold in a shape that gets mapped straight into a response.
 */
export interface RatingRater {
  id: number;
  username: string;
}

/**
 * One rating as the query layer hands it out — the row with its two displayed
 * relations resolved.
 *
 * `missionId`/`raterId` stay alongside `mission`/`rater` (they are those
 * relations' FK columns), matching how `Bid` keeps `missionId`/`pilotId` next
 * to `mission`/`pilot`.
 *
 * The third relation, `ratee`, is deliberately **not** resolved: the mapper
 * emits `rateeId` only (a profile page already knows whose ratings it is
 * showing), so joining `users` a second time per row would load a name nothing
 * reads. `rateeId` is on `RatingRow` already.
 */
export interface Rating extends RatingRow {
  mission: RatingMission;
  rater: RatingRater;
}
