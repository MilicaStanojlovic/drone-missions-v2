"use client";

import { cn } from "@/lib/utils";
import type { Rating } from "../rating.client";
import { RatingStars } from "./rating-stars";

/**
 * One rating with a caption — used for both directions on the mission page
 * ("You rated Ana Vidal" / "Ana Vidal rated you"), which is why the caption is
 * the caller's to write rather than derived here.
 *
 * Ports `RatingNoteComponent` — template, styles and both inputs. The stars
 * are the shared `RatingStars` in `compact` mode with `count={1}`, exactly as
 * the source passes them: one review's own score, where the "4.0 (1)" suffix
 * would be noise.
 *
 * The caption `<div>` renders even when `label` is empty, as in the original —
 * the source has no `@if` around it, and the empty box is what keeps a
 * label-less note aligned with a labelled one in a stack.
 *
 * Colours: the design canvas defines no note treatment, so the values below
 * are the source component's own, mapped to the target's tokens where the
 * canvas already names them (`#1b2732` is `--foreground`, i.e. `text-foreground`);
 * `#eef2f6` is the canvas's own hairline (used verbatim there for card and row
 * dividers) and `#3c4a58` its body-copy grey, neither of which is a token.
 *
 * SOURCE: drone-missions-frontend/.../components/rating-note/rating-note.component.ts
 */

export interface RatingNoteProps {
  rating: Rating;
  label?: string;
  /** Rule above, for the second note in a stack. Ports `bordered`. */
  bordered?: boolean;
  className?: string;
}

export function RatingNote({ rating, label = "", bordered = false, className }: RatingNoteProps) {
  return (
    <div
      className={cn(
        "grid justify-items-start gap-1.5",
        bordered && "mt-3.5 border-t border-[#eef2f6] pt-3.5",
        className,
      )}
    >
      <div className="text-foreground text-[12.5px] font-semibold">{label}</div>
      <RatingStars average={rating.score} count={1} compact />
      {rating.comment && (
        <p className="mt-0.5 mb-0 text-[13px] leading-[1.5] text-[#3c4a58]">“{rating.comment}”</p>
      )}
    </div>
  );
}
