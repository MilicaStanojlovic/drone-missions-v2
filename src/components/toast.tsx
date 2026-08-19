"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Transient, self-dismissing status message — the "Bid placed — $450" /
 * "Could not withdraw the bid" feedback the bid actions give.
 *
 * Ports `ToastService` + `ToastComponent` together. The source splits them
 * because Angular needs a root-provided singleton to carry a message from a
 * component to the one `<app-toast>` mounted in `app.component.html`; the
 * observable, the `BehaviorSubject` and the root mount are all machinery for
 * that hand-off. There is no DI-singleton layer here, so the same behaviour is
 * expressed as a hook owned by the component that raises the message, plus a
 * renderer it places itself — the same shape `notification.client.ts` used for
 * `NotificationService`. What is preserved is what is observable: one toast at
 * a time (a second `show` replaces the first and restarts the clock), the
 * 2800 ms auto-dismiss, and the accent colour per call.
 *
 * DESIGN: the canvas (`design/DroneMissions.dc.html`, its `toast` block) is
 * the source of truth for the look — a white card with a coloured left border
 * and matching dot, `0 12px 40px rgba(20,35,55,.18)`, bottom-centred — which
 * is where the Angular CSS (a dark `#1b2732` pill, same position, same
 * 2800 ms, same slide-up) diverges from the canvas it was built against. The
 * canvas wins on styling, the component on behaviour, per the porting rules.
 * The slide-up is `tw-animate-css`'s `animate-in`, disabled under
 * `prefers-reduced-motion` exactly as the source's media query does.
 *
 * SOURCE:
 * - drone-missions-frontend/.../services/toast.service.ts
 * - drone-missions-frontend/.../components/toast/toast.component.ts
 */

/** One toast: what to say and the accent to say it in. Mirrors the `Toast` interface. */
export interface ToastMessage {
  message: string;
  color: string;
}

/** The default accent — the canvas/design primary, as in `ToastService.show`'s default. */
const DEFAULT_COLOR = "#2f6bff";

/** How long a toast stays up, in ms. Mirrors `ToastService`'s timer. */
const TOAST_MS = 2800;

/**
 * Toast state plus the `show` that raises one. `show` is referentially stable,
 * so it is safe in a dependency array; the pending timer is cleared both when
 * a new toast replaces the current one and when the owner unmounts (the
 * root-provided source never unmounts, so it has no counterpart for the
 * latter — without it React would warn about a state update on a component
 * that has gone).
 */
export function useToast(): {
  toast: ToastMessage | null;
  show: (message: string, color?: string) => void;
} {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, color: string = DEFAULT_COLOR) => {
    setToast({ message, color });
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  return { toast, show };
}

/** Renders the current toast, if any. Place it once per component that raises them. */
export function Toast({ toast }: { toast: ToastMessage | null }) {
  if (!toast) {
    return null;
  }
  return (
    <div
      role="status"
      // z-index above the confirm dialog (2000), matching the source's 2100 —
      // a toast raised by a dialog's action has to stay readable over it.
      className="animate-in fade-in slide-in-from-bottom-3 bg-card fixed bottom-[26px] left-1/2 z-[2100] flex max-w-[min(90vw,420px)] -translate-x-1/2 items-center gap-[11px] rounded-[10px] border border-l-[3px] border-[#e2e8ef] px-[18px] py-3 shadow-[0_12px_40px_rgba(20,35,55,0.18)] duration-200 motion-reduce:animate-none"
      style={{ borderLeftColor: toast.color }}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: toast.color }}
      />
      <span className="text-foreground text-[13.5px]">{toast.message}</span>
    </div>
  );
}
