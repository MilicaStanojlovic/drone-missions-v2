"use client";

import { cn } from "@/lib/utils";

/**
 * Read-only star average. Used on feed cards, profiles and the mission page.
 * Ports `RatingStarsComponent` — template, styles and the `rounded` /
 * `ariaLabel` getters included.
 *
 * It lives under `features/ratings/` because that is the feature it renders,
 * even though the ratings vertical itself is a later phase: the mission
 * mapper already returns `designerRating` / `designerRatingCount` (ported
 * with the mission service), and the feed cards this phase builds are the
 * source's first consumer of the component. Nothing here talks to the
 * ratings API — it is a pure display component, exactly as the original is.
 *
 * The Angular `| number: '1.1-1'` pipe (min 1 integer digit, exactly 1
 * fraction digit) is `toFixed(1)` here, which produces the same text for
 * every average the backend can return (0–5).
 *
 * Colours: the design canvas defines no star treatment, so the two values
 * below are the source component's own (`#f2a93b` filled, `#d7dee7` empty),
 * kept verbatim rather than invented.
 *
 * SOURCE: drone-missions-frontend/.../components/rating-stars/rating-stars.component.ts
 */

const STAR_SLOTS = [1, 2, 3, 4, 5];

export interface RatingStarsProps {
  average?: number;
  count?: number;
  /** When false an unrated user renders nothing at all, which suits dense card layouts. */
  showEmpty?: boolean;
  /** Glyphs only — for one review's own score, where "4.0 (1)" would be noise. */
  compact?: boolean;
  className?: string;
}

export function RatingStars({
  average = 0,
  count = 0,
  showEmpty = true,
  compact = false,
  className,
}: RatingStarsProps) {
  if (count > 0) {
    const rounded = Math.round(average);
    const ariaLabel = `${average.toFixed(1)} out of 5, ${count} rating${count === 1 ? "" : "s"}`;
    return (
      <span
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center gap-[5px] text-[12.5px] whitespace-nowrap",
          className,
        )}
      >
        <span aria-hidden="true" className="tracking-[0.5px] text-[#d7dee7]">
          {STAR_SLOTS.map((star) => (
            <span key={star} className={star <= rounded ? "text-[#f2a93b]" : undefined}>
              ★
            </span>
          ))}
        </span>
        {!compact && (
          <>
            <span className="text-foreground font-semibold">{average.toFixed(1)}</span>
            <span className="text-[#7d8b9a]">({count})</span>
          </>
        )}
      </span>
    );
  }

  if (showEmpty) {
    return (
      <span className={cn("inline-flex items-center text-xs text-[#9aa7b4]", className)}>
        No ratings yet
      </span>
    );
  }

  return null;
}
