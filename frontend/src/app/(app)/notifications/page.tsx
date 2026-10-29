"use client";

import { clsx } from "clsx";
import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { useOpenLink } from "@/components/notifications/bell";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { notifyInboxChanged, timeAgo, type Inbox, type InboxItem } from "@/lib/notifications";
import { useAuth } from "@/providers/auth-provider";

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool?.school_id ?? null;
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openLink = useOpenLink();

  const load = useCallback(async () => {
    if (!schoolId) return;
    setError(null);
    try { setData(await apiFetch<Inbox>("/notifications", { schoolId, query: { unread: onlyUnread ? "true" : undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, onlyUnread, page]);
  useEffect(() => { void load(); }, [load]);

  async function markRead(it: InboxItem) {
    if (it.read) return;
    await apiFetch(`/notifications/${it.id}/read`, { schoolId, method: "POST" }).catch(() => undefined);
    setData((d) => d && { ...d, unread: Math.max(0, d.unread - 1), items: d.items.map((x) => (x.id === it.id ? { ...x, read: true } : x)) });
    notifyInboxChanged();
  }
  async function readAll() {
    await apiFetch("/notifications/read-all", { schoolId, method: "POST" }).catch(() => undefined);
    notifyInboxChanged();
    await load();
  }

  if (!schoolId) {
    return <><PageHeader title="Notifications" /><EmptyState icon={Bell} title="No school selected" message="Notifications belong to a school. Choose one at the top of the page." /></>;
  }
  return (
    <>
      <PageHeader title="Notifications" description="Messages from your school: fees, attendance, homework, exams and notices."
        actions={data && data.unread > 0 ? <Button variant="secondary" onClick={readAll} data-testid="inbox-read-all"><CheckCheck className="size-4" /> Mark all read</Button> : undefined} />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex gap-1.5" role="tablist" aria-label="Show">
          {[false, true].map((u) => (
            <button key={String(u)} role="tab" aria-selected={onlyUnread === u} onClick={() => { setOnlyUnread(u); setPage(1); }}
              className={clsx("rounded-full border px-3 py-1 text-sm", onlyUnread === u ? "border-leaf-600 bg-leaf-50 font-medium text-leaf-700" : "border-line bg-white text-muted hover:text-ink")}>
              {u ? `Unread${data ? ` (${data.unread})` : ""}` : "All"}
            </button>
          ))}
        </div>
        <Link href="/profile#notifications" className="text-sm text-leaf-700 hover:underline">Email, SMS &amp; WhatsApp choices</Link>
      </div>
      {error ? <ErrorState message={error} onRetry={load} />
        : !data ? <LoadingState />
        : data.items.length === 0 ? <EmptyState icon={Bell} title={onlyUnread ? "All caught up" : "No notifications yet"} message={onlyUnread ? "You have read everything." : "Messages from your school will appear here."} />
        : (
          <section className="overflow-hidden rounded-lg border border-line bg-white">
            <ul className="divide-y divide-line" data-testid="inbox-list">
              {data.items.map((it) => (
                <li key={it.id} className={clsx("flex gap-3 px-5 py-4", !it.read && "bg-leaf-50/40")} data-testid="inbox-item">
                  <span className={clsx("mt-2 size-2 shrink-0 rounded-full", it.read ? "bg-line" : "bg-leaf-600")} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className={clsx("text-sm", !it.read && "font-semibold")}>{it.title}{!it.read && <span className="sr-only"> (unread)</span>}</p>
                    <p className="mt-0.5 whitespace-pre-line text-sm text-muted">{it.body}</p>
                    <p className="mt-1 text-xs text-muted" title={formatDateTime(it.created_at)}>{timeAgo(it.created_at)}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {it.link && <Button size="sm" variant="secondary" onClick={() => { void markRead(it); openLink(it.link!); }}>Open</Button>}
                    {!it.read && <button onClick={() => void markRead(it)} className="text-xs text-leaf-700 hover:underline" data-testid="inbox-mark-read">Mark read</button>}
                  </div>
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-5 py-3"><Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} /></div>
          </section>
        )}
    </>
  );
}
