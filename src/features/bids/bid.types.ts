import type { BidStatus, bid } from "@/db/schema";

/**
 * Bid domain types (replaces `data.model.Bid`, `data.model.BidStatus`, the
 * web DTO `web.dto.bid.BidResponse`, and the display constants of the Angular
 * `models/bid.model.ts`).
 *
 * `BidStatus` is not redeclared here — it already lives in `src/db/schema.ts`
 * as the union backing the `bid_status_check` constraint (V8), and the Java
 * `BidStatus` enum agrees with it value-for-value. It is re-exported below so
 * bid code can take the whole vocabulary from one module without the union
 * drifting into two copies.
 *
 * DELIBERATE DIVERGENCE from `mission.types.ts` / `notification.types.ts`:
 * this module does **not** start with `import "server-only"`. Those two are
 * server-side-only shapes, whereas `BID_STATUS_LABELS`/`BID_STATUS_COLORS`
 * are display constants that the bids panel and the `/my-bids` page render in
 * the browser, and the plan places them here. Everything in this file is
 * therefore isomorphic: only erased `import type`s (no runtime import of
 * `@/db/schema`, so Drizzle never reaches a client bundle) plus two frozen
 * string maps. The runtime constants that *are* server-only — `BID_STATUSES`
 * and the like — stay in `@/db/schema` and are imported there directly.
 *
 * SOURCE:
 * - drone-missions-backend/.../data/model/Bid.java
 * - drone-missions-backend/.../data/model/BidStatus.java
 * - drone-missions-backend/.../web/dto/bid/BidResponse.java
 * - drone-missions-backend/.../web/mapper/bid/BidMapper.java
 * - drone-missions-frontend/.../models/bid.model.ts
 */

export type { BidStatus };

// --- Persistence shapes (mirror `data.model.Bid`) ---

/**
 * The raw `bid` row exactly as Drizzle selects it.
 *
 * `amount` is a `string` here, not a number: the column is
 * `numeric(12, 2)`, and `postgres.js`/Drizzle hand `numeric` back as its
 * decimal text so no precision is lost in transit. `Bid` below narrows it,
 * the same way `MissionRow` -> `Mission` narrows the two `jsonb` columns.
 */
export type BidRow = typeof bid.$inferSelect;

/**
 * The mission a bid is for, reduced to the fields the bid layer reads.
 *
 * The Java entity holds a whole `@ManyToOne Mission`, but `BidMapper` touches
 * exactly two of its properties (`getId()`, `getName()`), so — following the
 * precedent already set by `NotificationMission` — this is a plain structural
 * shape rather than the full `Mission` type. Any mission row is assignable to
 * it, and the queries layer can satisfy it from a join without materialising a
 * whole mission (including its `jsonb` flight plan) per bid.
 *
 * `name` is nullable because `mission.name` is (`varchar(255)`, no NOT NULL),
 * exactly as `MissionResponse.name` already reflects.
 */
export interface BidMission {
  id: number;
  name: string | null;
}

/**
 * The pilot who placed a bid, reduced to the fields the bid layer reads —
 * the counterpart of the entity's `@ManyToOne User pilot`, of which
 * `BidMapper` reads only `getId()` and `getUsername()`. A whole `User` row is
 * assignable to it, and unlike `User` it carries no password hash, so it is
 * safe to hold in shapes that get mapped straight to a response.
 */
export interface BidPilot {
  id: number;
  username: string;
}

/**
 * One bid as the query layer hands it out — the row with `amount` narrowed to
 * a number and the two `@ManyToOne` relations resolved.
 *
 * `missionId`/`pilotId` stay alongside `mission`/`pilot` (they are the
 * relations' FK columns) for the same reason `Mission` keeps `userId`
 * next to its resolved `designer`.
 *
 * Narrowing `amount` to `number` mirrors the Java entity, which holds a real
 * `BigDecimal` and hands it straight to the DTO. It is lossless for this
 * column: `numeric(12, 2)` tops out at 9_999_999_999.99, i.e. 999_999_999_999
 * in minor units — comfortably inside a double's exact-integer range
 * (2^53), so no representable value round-trips wrong.
 */
export interface Bid extends Omit<BidRow, "amount"> {
  amount: number;
  mission: BidMission;
  pilot: BidPilot;
}

// --- Wire shape (mirrors `web.dto.bid.BidResponse`) ---

/**
 * Public view of one bid. Mirrors `BidResponse` field-for-field, including
 * its central choice: the mission and pilot arrive as `missionName`/
 * `pilotName` next to their ids, resolved server-side off the relations, so
 * "the client never has to show (or re-fetch) raw identifiers" (the record's
 * own javadoc).
 *
 * `message` is `string | null` rather than optional: the source record has no
 * `@JsonInclude(NON_NULL)` (the only place this codebase's DTOs use it is
 * `Geofence`), so a bid without a note serializes as `"message": null` — a
 * present key. The Angular model's `message?: string` is the permissive
 * reading of that same payload, not a second shape.
 *
 * `missionName` is likewise nullable, because `mission.name` is; the Angular
 * model types it `string` optimistically.
 */
export interface BidResponse {
  id: number;
  missionId: number;
  missionName: string | null;
  pilotId: number;
  pilotName: string;
  amount: number;
  message: string | null;
  status: BidStatus;
  createdAt: Date;
  updatedAt: Date;
}

// --- Display constants (mirror `models/bid.model.ts`) ---

/** Human-friendly labels for status chips. Mirrors `BID_STATUS_LABELS`. */
export const BID_STATUS_LABELS: Record<BidStatus, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
};

/**
 * Accent colour per status. Mirrors `BID_STATUS_COLORS`, whose comment reads
 * "matches the mission palette" — and it does, literally: the three values
 * are `MISSION_STATUS_COLORS.BIDDING`, `.COMPLETED` and `.CANCELLED`, all
 * three of which also appear in `design/DroneMissions.dc.html`. They are
 * spelled out here rather than imported from `mission.client.ts` because the
 * source keeps two independent maps, and a bid being "pending" is not the
 * same fact as a mission being "bidding" — they merely share a colour today.
 */
export const BID_STATUS_COLORS: Record<BidStatus, string> = {
  PENDING: "#d9860a",
  ACCEPTED: "#12a06a",
  REJECTED: "#e04a3f",
};
