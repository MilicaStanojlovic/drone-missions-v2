"use client";

import { useEffect } from "react";
import { cn } from "@/lib/utils";

/**
 * A small, reusable confirmation modal. Controlled via `open`; calls
 * `onConfirm` or `onCancel`. Escape and a backdrop click both cancel. Use
 * `danger` for destructive actions (styles the confirm button red).
 *
 * Ports `ConfirmDialogComponent` — template, styles and behaviour. Angular's
 * `@Input()`s become props and its two `@Output()` emitters become the
 * `onConfirm` / `onCancel` callbacks; `@HostListener('document:keydown.escape')`
 * becomes a document listener registered only while the dialog is open, which
 * is the same net behaviour as the source's `if (this.open)` guard.
 *
 * It lives in `src/components/` rather than under a feature because the source
 * keeps it in the shared `components/` folder and several features mount it
 * (missions here, bids and admin in later phases). The stock shadcn `dialog`
 * primitive is deliberately not used: this is a port, and the source's card
 * markup, icons and button treatment are the behaviour + design reference.
 *
 * SOURCE: drone-missions-frontend/.../components/confirm-dialog/confirm-dialog.component.{ts,html,css}
 */

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const CD_BTN =
  "flex-1 cursor-pointer rounded-[9px] border border-transparent px-4 py-[11px] text-sm font-semibold transition-colors";

export function ConfirmDialog({
  open,
  title = "Are you sure?",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCancel();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-[rgba(20,30,45,0.45)] p-5 backdrop-blur-[3px]"
      // Cancel only when the backdrop itself is clicked, not the card above it.
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="bg-card border-border w-full max-w-[400px] rounded-2xl border px-[26px] pt-[26px] pb-[22px] text-center shadow-[0_20px_60px_rgba(20,35,55,0.28)]"
      >
        <div
          aria-hidden="true"
          className={cn(
            "mx-auto mb-3.5 flex h-[46px] w-[46px] items-center justify-center rounded-full",
            danger ? "bg-[#fdeceb] text-[#d64a3f]" : "bg-[#eef3ff] text-[#2f6bff]",
          )}
        >
          {danger ? (
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <line x1="12" y1="16" x2="12" y2="16" />
            </svg>
          )}
        </div>

        <h2 className="mb-2 text-[18px] font-bold tracking-[-0.01em] text-[#141e28]">{title}</h2>
        {message && (
          <p className="mb-[22px] text-[13.5px] leading-[1.55] break-words text-[#5c6b7a]">
            {message}
          </p>
        )}

        <div className="flex gap-2.5">
          <button
            type="button"
            className={cn(
              CD_BTN,
              "bg-card border-[#dbe2ea] text-[#43525f] hover:border-[#b9c6d6] hover:text-[#1b2732]",
            )}
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button
            type="button"
            className={cn(
              CD_BTN,
              danger
                ? "bg-[#e04a3f] text-white shadow-[0_3px_12px_rgba(224,74,63,0.28)] hover:bg-[#c73c32]"
                : "bg-primary text-primary-foreground shadow-[0_3px_12px_rgba(47,107,255,0.28)] hover:bg-[#1e5ae6]",
            )}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
