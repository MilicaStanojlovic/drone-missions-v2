"use client";

import { cn } from "@/lib/utils";
import type { Rating } from "../rating.client";
import { RatingStars } from "./rating-stars";

/**
 * The comments behind an average: one card per review — who wrote it and their
 * score on one line, the mission it was for, the note itself, and the date.
 * Shared by the own-profile and public-profile pages, as in the original.
 *
 * Ports `RatingListComponent` — template, styles, the `No ratings yet.` empty
 * state and the `ratings = []` default. It is a pure display component: like
 * the source it never fetches, the owning page hands it the list.
 *
 * `track r.id` becomes React's `key={r.id}`.
 *
 * Colours: the design canvas defines no review-card treatment, so the values
 * are the source component's own, mapped to the target's tokens where the
 * canvas already names them — `#fff` is `--card` (`bg-card`), `#1b2732` is
 * `--foreground`, and the card's `#e6ebf1` hairline is the canvas's `--border`
 * `#e5eaf0` (`border-border`), a 1-step difference invisible on screen and
 * worth taking to stay on the token. `#7d8b9a`, `#3c4a58` and `#9aa7b4` are
 * greys the canvas does not name, kept verbatim — `#7d8b9a` is the same one
 * `rating-stars.tsx` already carries over for its count suffix.
 *
 * SOURCE: drone-missions-frontend/.../components/rating-list/rating-list.component.ts
 */

/** Angular's `| date: 'mediumDate'` ("Jun 15, 2015"). */
function mediumDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export interface RatingListProps {
  ratings?: readonly Rating[];
  className?: string;
}

export function RatingList({ ratings = [], className }: RatingListProps) {
  if (ratings.length === 0) {
    return <p className={cn("m-0 text-[13.5px] text-[#7d8b9a]", className)}>No ratings yet.</p>;
  }

  return (
    <ul className={cn("m-0 grid list-none gap-3 p-0", className)}>
      {ratings.map((r) => (
        <li key={r.id} className="bg-card border-border rounded-[10px] border px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground text-[13.5px] font-semibold">{r.raterName}</span>
            <RatingStars average={r.score} count={1} compact />
          </div>
          <div className="mt-0.5 text-xs text-[#7d8b9a]">on {r.missionName}</div>
          {r.comment && (
            <p className="mt-2 mb-0 text-[13.5px] leading-[1.5] text-[#3c4a58]">{r.comment}</p>
          )}
          <div className="mt-2 text-[11.5px] text-[#9aa7b4]">{mediumDate(r.createdAt)}</div>
        </li>
      ))}
    </ul>
  );
}
