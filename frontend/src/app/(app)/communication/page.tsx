"use client";

import { clsx } from "clsx";
import { useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { ChannelsTab } from "@/components/notifications/channels";
import { HistoryTab } from "@/components/notifications/history";
import { TemplatesTab } from "@/components/notifications/templates";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import type { EventInfo } from "@/lib/notifications";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["History", "Templates", "Channels"] as const;
type Tab = (typeof TABS)[number];

function Communication() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [tab, setTab] = useState<Tab>("History");
  const [events, setEvents] = useState<EventInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
      if (t && TABS.includes(t)) setTab(t);
    } catch { /* ignore */ }
  }, []);
  const load = useCallback(async () => {
    setError(null);
    try { setEvents(await apiFetch<EventInfo[]>("/notifications/admin/events", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);

  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "History" ? "/communication" : `/communication?tab=${t}`); } catch { /* ignore */ }
  }

  return (
    <>
      <PageHeader title="Communication" description="Messages to parents, students and staff: in the app, by email, SMS and WhatsApp." />
      <div role="tablist" aria-label="Communication" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)} data-testid={`comm-tab-${t.toLowerCase()}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {error ? <ErrorState message={error} onRetry={load} />
        : !events ? <LoadingState />
        : tab === "History" ? <HistoryTab schoolId={schoolId} events={events} />
        : tab === "Templates" ? <TemplatesTab schoolId={schoolId} events={events} onChange={setEvents} />
        : <ChannelsTab schoolId={schoolId} />}
    </>
  );
}

export default function CommunicationPage() {
  return <RequirePermission permission="notifications:manage"><Communication /></RequirePermission>;
}
