import "server-only";
import { z } from "zod";

/**
 * Bid request validation — replaces the Jakarta Bean Validation annotations
 * on `BidRequest`, which is the whole of that record: `@NotNull @Positive
 * BigDecimal amount` and `@Size(max = 500) String message`. There is no
 * custom validator and no cross-field rule, so there is no `.superRefine()`
 * here; every other bid rule (mission open for bidding, deadline not passed,
 * bid still PENDING) is service-layer policy in `BidService`, not request
 * validation, and is ported there.
 *
 * Messages are Hibernate Validator's default interpolated messages, since the
 * source declares none (`@NotNull` -> "must not be null", `@Positive` ->
 * "must be greater than 0", `@Size(max = 500)` -> "size must be between 0 and
 * 500"), so the `data` map in the 400 body is byte-identical to Spring's for
 * the same payload — the same rule `mission.schema.ts` follows.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/dto/bid/BidRequest.java
 * - drone-missions-frontend/.../models/bid.model.ts (`BidPayload`)
 */

/** `@NotNull`'s default message, used wherever the source declares none. */
const REQUIRED = "must not be null";

/**
 * Mirrors `BidRequest` field for field.
 *
 * `amount` is a `BigDecimal` in the source and stays a plain number here, as
 * the plan directs. Decimals are the point of the annotation — the column is
 * `numeric(12, 2)` and the Angular form submits prices like `1250.5` — so
 * this is deliberately *not* `z.int()`; `@Positive` is the only bound, and
 * `.positive()` is its exact counterpart (strictly greater than zero, so a
 * zero bid is rejected).
 *
 * DIVERGENCE (deliberate, narrower): Jackson would also accept a JSON
 * *string* for a `BigDecimal` property (`"amount": "100.50"`), because
 * `BigDecimal`'s deserializer parses text. That is a Jackson coercion, not an
 * intended part of the API — the Angular client only ever sends a number
 * (`BidPayload.amount: number`) and no source test covers the string form —
 * so a string is rejected here as a field error on the same 400 rather than
 * silently coerced. `z.number()` also rejects `NaN`, which is not expressible
 * in JSON anyway.
 *
 * `message` is optional, exactly as the source's un-annotated (no `@NotNull`,
 * no `@NotBlank`) field is: it may be omitted, sent as null, or sent empty —
 * `@Size` only caps the length. The 500 cap matches both the annotation and
 * the `bid.message varchar(500)` column, so an over-long note is a 400 rather
 * than a database error.
 */
export const bidRequestSchema = z.object({
  amount: z.number({ error: REQUIRED }).positive("must be greater than 0"),
  message: z.string().max(500, "size must be between 0 and 500").nullish(),
});

export type BidRequestInput = z.infer<typeof bidRequestSchema>;
