"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { serverMessage } from "@/lib/api/client";
import { rateMission, type RatingPayload } from "../rating.client";

/**
 * Star picker + optional comment for a completed mission. Calls `onRated` on
 * success so the parent can swap it for the submitted rating; a rating cannot
 * be edited afterwards.
 *
 * Ports `RatingFormComponent` — template, styles and behaviour, including the
 * hover preview (`hovered || score`), the disabled-until-scored submit, the
 * busy label, the trimmed-empty comment being dropped from the payload
 * entirely, and the "Ratings are final" note.
 *
 * Two shape differences, both forced by the stack rather than chosen:
 *
 * - The source's `@Output() rated` event becomes the `onRated` callback prop —
 *   React's equivalent, and what `BidsPanel`'s `onChanged` already uses.
 * - The source raises its feedback through the root-provided `ToastService`
 *   singleton, whose one `<app-toast>` lives in `app.component.html` and so
 *   outlives this component; here `useToast` is a hook, so the parent's `show`
 *   comes in as a prop and this component renders no `<Toast>` of its own.
 *   That matters on the success path specifically: `onRated()` re-reads the
 *   ratings, which makes `canRate` false and unmounts this form — a toast
 *   owned here would be torn down with it after roughly one GET instead of the
 *   2800 ms `toast.tsx` preserves. Raising both messages through the toast
 *   `MissionDetail` already owns keeps the source's observable behaviour: one
 *   toast at a time, on screen for its full life whether the form survives or
 *   not.
 *
 * The error path surfaces the backend's own message via `serverMessage` — the
 * target's shared reader for the `{ data, status, message }` envelope, which is
 * the source's private `serverMessage` helper generalised. That is what puts
 * the server's 409 "You have already rated mission 7" and 403 "You did not take
 * part in mission 7…" text in front of the user instead of a generic failure.
 *
 * Colours: the design canvas defines no rate-form treatment, so the values are
 * the source component's own, mapped to the target's tokens where the canvas
 * already names them (`#1b2732` is `--foreground`, and the submit's `#2f6bff`
 * is the canvas primary). `#f2a93b`/`#d7dee7` are the same star pair
 * `rating-stars.tsx` already carries over.
 *
 * SOURCE: drone-missions-frontend/.../components/rating-form/rating-form.component.ts
 */

const STAR_SLOTS = [1, 2, 3, 4, 5];

export interface RatingFormProps {
  missionId: number;
  /** Who is being rated, for the "How was …?" prompt. Ports `counterpartName`. */
  counterpartName?: string | null;
  /** Ports the `rated` output — re-read so the panel flips to "you rated". */
  onRated: () => void;
  /**
   * The parent's `useToast().show` — stands in for the injected `ToastService`
   * singleton, so the message survives this form being unmounted by `onRated`.
   */
  show: (message: string, color?: string) => void;
  className?: string;
}

export function RatingForm({
  missionId,
  counterpartName,
  onRated,
  show,
  className,
}: RatingFormProps) {
  const [score, setScore] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  function submit(): void {
    if (!score || busy) {
      return;
    }
    setBusy(true);
    const payload: RatingPayload = { score };
    if (comment.trim()) {
      payload.comment = comment.trim();
    }
    rateMission(missionId, payload)
      .then(() => {
        setBusy(false);
        show("Thanks — your rating was saved", "#12a06a");
        onRated();
      })
      .catch((error: unknown) => {
        setBusy(false);
        show(serverMessage(error, "Could not save your rating"), "#e04a3f");
      });
  }

  return (
    <div className={cn("grid gap-2.5", className)}>
      <div className="text-foreground text-[13.5px] font-semibold">
        How was {counterpartName || "the other side"}?
      </div>

      <div role="radiogroup" aria-label="Score out of 5" className="flex gap-1">
        {STAR_SLOTS.map((star) => (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={score === star}
            aria-label={`${star} out of 5`}
            className={cn(
              "cursor-pointer border-none bg-transparent p-0 text-[26px] leading-none transition-colors duration-[120ms]",
              star <= (hovered || score) ? "text-[#f2a93b]" : "text-[#d7dee7]",
            )}
            onMouseEnter={() => setHovered(star)}
            onMouseLeave={() => setHovered(0)}
            onClick={() => setScore(star)}
          >
            ★
          </button>
        ))}
      </div>

      <textarea
        className="box-border w-full resize-y rounded-lg border border-[#e6ebf1] px-[11px] py-[9px] font-sans text-[13.5px] outline-none focus:border-[#2f6bff]"
        rows={3}
        maxLength={500}
        placeholder="Add a comment (optional)…"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />

      <button
        type="button"
        className="cursor-pointer rounded-lg border-none bg-[#2f6bff] px-3.5 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:enabled:bg-[#2357d6] disabled:cursor-not-allowed disabled:bg-[#c3cedd]"
        disabled={!score || busy}
        onClick={submit}
      >
        {busy ? "Submitting…" : "Submit rating"}
      </button>
      <div className="text-[11.5px] text-[#9aa7b4]">Ratings are final and cannot be changed.</div>
    </div>
  );
}
