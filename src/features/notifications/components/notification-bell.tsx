"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  NOTIFICATION_COLORS,
  useNotifications,
  type AppNotification,
} from "@/features/notifications/notification.client";

/**
 * The notifications bell in the topbar: an unread-count badge and a dropdown
 * of the pilot's notifications (bid accepted/rejected, mission cancelled,
 * mission overdue). Clicking a row marks it read and opens the related
 * mission. Replaces `NotificationBellComponent`.
 *
 * Rendered only for pilots — the topbar gates it exactly as
 * `app.component.html` does (`@if (auth.isPilot)`), and `useNotifications`
 * re-checks the role itself before it loads or polls anything, so a stray
 * mount on the designer side is inert rather than noisy.
 *
 * Styling is the component CSS re-expressed in Tailwind against the tokens in
 * `globals.css`, which are lifted from the design canvas
 * (`design/DroneMissions.dc.html`): `bg-card`/`border-input`/`bg-accent` for
 * the button, `bg-destructive` for the badge, `text-primary` for the mark-all
 * action. Where the component CSS uses a grey the token set has no name for,
 * the canvas's own hex is used (`#e8edf2` card border, `#eef2f6`/`#f2f5f8`
 * dividers, `#f7f9fb` row hover, `#5c6b7a`/`#93a1b0`/`#a2afbc` text greys,
 * `#cdd6df` hover border) rather than a new invented value. Two component
 * greys are *not* canvas colours (`#16222e` heading, `#46566a` icon) and take
 * their canvas equivalents `--foreground` / `--muted-foreground` instead; the
 * unread row tint `#f5f9ff` has no canvas counterpart at all and is kept as
 * the component defines it. Type accent dots keep the source's inline
 * `[style.background]="colors[n.type]"` binding, since the colour is data.
 *
 * SOURCE: drone-missions-frontend/.../components/notification-bell/notification-bell.component.{ts,html,css}
 */

/**
 * "3h ago" style relative time. Ported verbatim from the component method of
 * the same name, including its `just now` floor and its day-granularity cap
 * (nothing older is ever expressed in weeks or months).
 */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function NotificationBell() {
  const router = useRouter();
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);

  function onSelect(n: AppNotification) {
    if (!n.read) {
      markRead(n.id);
    }
    setOpen(false);
    // A rejected pilot can no longer see the (now awarded) mission — send them
    // to the feed. Same fallback for a notification with no mission at all.
    router.push(
      n.missionId && n.type !== "BID_REJECTED" ? `/missions/${n.missionId}` : "/missions",
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Notifications"
        aria-haspopup="true"
        aria-expanded={open}
        className={cn(
          "bg-card group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-[9px] border transition-colors",
          open
            ? "bg-accent border-[#cdd6df]"
            : "border-input hover:bg-accent hover:border-[#cdd6df]",
        )}
      >
        <svg
          className={cn(
            "block h-[18px] w-[18px] transition-colors",
            open ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
          )}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="bg-destructive border-card absolute -top-[5px] -right-[5px] box-border h-[17px] min-w-[17px] rounded-[20px] border-2 px-1 text-center font-mono text-[9.5px] leading-[13px] font-semibold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div role="presentation" onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          {/* `animate-in fade-in slide-in-from-top-1` (tw-animate-css) is the
              component CSS's `panel-in` keyframes — same 6px drop, same fade,
              same ~0.14s ease. */}
          <div className="bg-card animate-in fade-in slide-in-from-top-1 absolute top-[calc(100%+10px)] right-0 z-50 w-[340px] max-w-[90vw] overflow-hidden rounded-[14px] border border-[#e8edf2] shadow-[0_12px_28px_rgba(20,35,55,0.12)] duration-150 ease-out">
            <div className="flex items-center justify-between border-b border-[#eef2f6] px-4 py-[13px]">
              <span className="text-foreground text-sm font-semibold">Notifications</span>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="text-primary cursor-pointer text-[12.5px] font-medium hover:underline"
                >
                  Mark all read
                </button>
              )}
            </div>

            {notifications.length === 0 ? (
              <div className="px-4 py-[34px] text-center text-[13.5px] text-[#93a1b0]">
                You&apos;re all caught up.
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto">
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => onSelect(n)}
                    className={cn(
                      "flex w-full items-start gap-[11px] border-b border-[#f2f5f8] px-4 py-[13px] text-left transition-colors last:border-b-0",
                      // The component CSS declares `.note--unread` after
                      // `.note:hover`, so the unread tint wins over hover;
                      // only a read row gets a hover background here.
                      n.read ? "hover:bg-[#f7f9fb]" : "bg-[#f5f9ff]",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full"
                      style={{ background: NOTIFICATION_COLORS[n.type] }}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-foreground text-[13.5px] font-semibold">{n.title}</span>
                      <span className="mt-0.5 text-[12.5px] leading-[1.4] text-[#5c6b7a]">
                        {n.message}
                      </span>
                      <span className="mt-[5px] font-mono text-[10.5px] text-[#a2afbc]">
                        {timeAgo(n.createdAt)}
                      </span>
                    </span>
                    {!n.read && (
                      <span
                        aria-hidden="true"
                        className="mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full"
                        style={{ background: NOTIFICATION_COLORS[n.type] }}
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
