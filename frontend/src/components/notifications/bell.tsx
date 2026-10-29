"use client";

import { clsx } from "clsx";
import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { UNREAD_EVENT, timeAgo, type Inbox, type InboxItem } from "@/lib/notifications";
import { useAuth } from "@/providers/auth-provider";

const POLL_MS = 60_000;

/** Opens an in-app link. Same page with another ?tab= needs a full load (the page reads it once). */
export function useOpenLink() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback((link: string) => {
    const path = link.split("?")[0];
    if (path === pathname && link.includes("?")) window.location.assign(link);
    else router.push(link);
  }, [router, pathname]);
}

export function NotificationBell() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool?.school_id ?? null;
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openLink = useOpenLink();

  const refreshCount = useCallback(async () => {
    if (!schoolId || document.visibilityState === "hidden") return;
    try { setUnread((await apiFetch<{ unread: number }>("/notifications/unread-count", { schoolId })).unread); } catch { /* keep the last count */ }
  }, [schoolId]);

  useEffect(() => {
    void refreshCount();
    const t = window.setInterval(() => void refreshCount(), POLL_MS);
    const onFocus = () => void refreshCount();
    window.addEventListener("focus", onFocus);
    window.addEventListener(UNREAD_EVENT, onFocus);
    return () => { window.clearInterval(t); window.removeEventListener("focus", onFocus); window.removeEventListener(UNREAD_EVENT, onFocus); };
  }, [refreshCount]);

  useEffect(() => { // the number on the installed app's icon, where the system supports it
    const n = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    (unread > 0 ? n.setAppBadge?.(unread) : n.clearAppBadge?.())?.catch(() => undefined);
  }, [unread]);

  const loadList = useCallback(async () => {
    if (!schoolId) return;
    setError(false);
    try {
      const d = await apiFetch<Inbox>("/notifications", { schoolId, query: { page_size: 8 } });
      setItems(d.items); setUnread(d.unread);
    } catch { setError(true); }
  }, [schoolId]);

  useEffect(() => {
    if (!open) return;
    void loadList();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open, loadList]);

  async function choose(it: InboxItem) {
    setOpen(false);
    if (!it.read) {
      setUnread((n) => Math.max(0, n - 1));
      void apiFetch(`/notifications/${it.id}/read`, { schoolId, method: "POST" }).catch(() => undefined);
    }
    if (it.link) openLink(it.link);
  }

  async function readAll() {
    await apiFetch("/notifications/read-all", { schoolId, method: "POST" }).catch(() => undefined);
    setUnread(0);
    setItems((xs) => xs?.map((x) => ({ ...x, read: true })) ?? null);
  }

  if (!schoolId) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} data-testid="notification-bell"
        className="relative rounded-md p-2 text-muted hover:bg-ink/5 hover:text-ink">
        <Bell className="size-5" aria-hidden />
        <span className="sr-only">Notifications{unread ? ` (${unread} unread)` : ""}</span>
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 grid min-w-[1.15rem] place-items-center rounded-full bg-danger-600 px-1 text-[0.65rem] font-semibold leading-[1.15rem] text-white"
            data-testid="notification-count" aria-hidden>{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {open && (
        <div role="menu" className="fixed inset-x-4 top-16 z-40 overflow-hidden sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-1 sm:w-[22rem] rounded-md border border-line bg-white shadow-lg" data-testid="notification-menu">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <button onClick={readAll} className="flex items-center gap-1 text-xs font-medium text-leaf-700 hover:underline" data-testid="notifications-read-all">
                <CheckCheck className="size-3.5" aria-hidden /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[22rem] overflow-y-auto">
            {error ? <p className="px-3 py-6 text-center text-sm text-muted">Couldn&apos;t load notifications.</p>
              : items === null ? <p className="px-3 py-6 text-center text-sm text-muted">Loading…</p>
              : items.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted">No notifications yet.</p>
              : (
                <ul className="divide-y divide-line">
                  {items.map((it) => (
                    <li key={it.id}>
                      <button role="menuitem" onClick={() => void choose(it)} data-testid="notification-item"
                        className={clsx("flex w-full gap-2.5 px-3 py-2.5 text-left hover:bg-paper", !it.read && "bg-leaf-50/50")}>
                        <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", it.read ? "bg-transparent" : "bg-leaf-600")} aria-hidden />
                        <span className="min-w-0">
                          <span className={clsx("block text-sm", !it.read && "font-semibold")}>{it.title}</span>
                          <span className="line-clamp-2 block text-xs text-muted">{it.body}</span>
                          <span className="mt-0.5 block text-[0.7rem] text-muted">{timeAgo(it.created_at)}{!it.read && <span className="sr-only"> · unread</span>}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
          <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-3 py-2 text-center text-sm font-medium text-leaf-700 hover:bg-paper"
            data-testid="notifications-see-all">See all notifications</Link>
        </div>
      )}
    </div>
  );
}
