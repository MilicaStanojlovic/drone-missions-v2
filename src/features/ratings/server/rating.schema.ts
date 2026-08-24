import "server-only";
import { z } from "zod";

/**
 * Rating request validation — replaces the Jakarta Bean Validation
 * annotations on `RatingRequest`, which is the whole of that record:
 * `@NotNull @Min(1) @Max(5) Short score` and `@Size(max = 500) String
 * comment`. There is no custom validator and no cross-field rule, so there is
 * no `.superRefine()` here; every other rating rule (mission must exist, must
 * be COMPLETED, may only be rated once, rater must be a participant) is
 * service-layer policy in `RatingService.create`, not request validation, and
 * is ported there.
 *
 * Messages are Hibernate Validator's default interpolated messages, since the
 * source declares none (`@NotNull` -> "must not be null", `@Min(1)` -> "must
 * be greater than or equal to 1", `@Max(5)` -> "must be less than or equal to
 * 5", `@Size(max = 500)` -> "size must be between 0 and 500"), so the `data`
 * map in the 400 body is byte-identical to Spring's for the same payload —
 * the same rule `bid.schema.ts` and `mission.schema.ts` follow.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/dto/rating/RatingRequest.java
 * - drone-missions-backend/.../data/model/Rating.java (score `Short`, comment `length = 500`)
 * - drone-missions-backend/.../src/main/resources/db/migration/V11__create_rating_table.sql
 * - drone-missions-frontend/.../components/rating-form/rating-form.component.ts (payload shape)
 */

/** `@NotNull`'s default message, used wherever the source declares none. */
const REQUIRED = "must not be null";

/**
 * Mirrors `RatingRequest` field for field.
 *
 * `score` is a `Short` in the source — a whole number of stars — so this is
 * `z.int()` rather than `z.number()`: the star picker only ever emits 1..5
 * (`RatingFormComponent.starSlots`), the column is `SMALLINT`, and
 * `rating_score_check` (V11) confines it to `BETWEEN 1 AND 5` at the database
 * too. `@Min(1)`/`@Max(5)` are inclusive bounds (Bean Validation's `value` is
 * the accepted extreme), so `.min(1)`/`.max(5)` are their exact counterparts:
 * 1 and 5 pass, 0 and 6 do not.
 *
 * DIVERGENCE (deliberate, narrower): Jackson would accept a *fractional*
 * number for a `Short` property (`ACCEPT_FLOAT_AS_INT` is enabled by default,
 * so `3.5` silently truncates to `3`) and would likewise parse a JSON
 * *string* (`"3"`). Both are Jackson coercions, not intended parts of the API
 * — the Angular client only ever sends an integer from the star picker
 * (`RatingPayload.score: number`, assigned from `starSlots`) and no source
 * test covers either form — so both are rejected here as a field error on the
 * same 400 rather than being silently reshaped into a different score than
 * the caller sent. The `error` callback keeps the two apart: an absent/null
 * score reports `@NotNull`'s message, anything else non-integral reports why
 * it was refused.
 *
 * `comment` is optional, exactly as the source's un-annotated (no `@NotNull`,
 * no `@NotBlank`) field is: it may be omitted, sent as null, or sent empty —
 * `@Size` only caps the length. The 500 cap matches both the annotation and
 * the `rating.comment varchar(500)` column, so an over-long note is a 400
 * rather than a database error, and it is measured on the raw string exactly
 * as `@Size` measures it (the trimming below happens only after the value has
 * been accepted, so a note that is over the cap only because of surrounding
 * whitespace is rejected here just as Spring rejects it).
 *
 * NORMALISATION (accept/reject unaffected): an accepted comment is trimmed,
 * and a comment that is empty or all whitespace becomes `undefined` — i.e.
 * "no comment", which the service writes as the `NULL` the nullable column
 * expects. This is what the only client already sends: `RatingFormComponent`
 * puts `comment` on the payload solely `if (this.comment.trim())`, and sends
 * `this.comment.trim()` when it does. Spring stores whatever reaches it, so
 * doing the same normalisation server-side keeps "no comment" a single
 * representation (`NULL`, never `''`) no matter which client posts — the
 * rating list renders a quoted comment on presence alone, and an empty quote
 * block is not a state the source UI can produce.
 */
export const ratingRequestSchema = z.object({
  score: z
    .int({
      error: (issue) =>
        issue.input === undefined || issue.input === null ? REQUIRED : "must be an integer",
    })
    .min(1, "must be greater than or equal to 1")
    .max(5, "must be less than or equal to 5"),
  comment: z
    .string()
    .max(500, "size must be between 0 and 500")
    .nullish()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
});

export type RatingRequestInput = z.infer<typeof ratingRequestSchema>;
