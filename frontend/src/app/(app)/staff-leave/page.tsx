"use client";

import { clsx } from "clsx";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { BalancesTab, CalendarTab, HistoryTab, RequestsTab, TypesTab } from "@/components/hr/admin";
import { PageHeader } from "@/components/layout/app-shell";
import { LoadingState } from "@/components/ui/states";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["Requests", "All leave", "Balances", "Leave types", "Holidays & week"] as const;
type Tab = (typeof TABS)[number];

function StaffLeave() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>("Requests");
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => { const t = params.get("tab") as Tab | null; if (t && TABS.includes(t)) setTab(t); }, [params]);
  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "Requests" ? "/staff-leave" : `/staff-leave?tab=${encodeURIComponent(t)}`); } catch { /* ignore */ }
  }
  return (
    <>
      <PageHeader title="Staff leave" description="Approve or reject leave, see balances and history, and set leave types, holidays and the working week." />
      <div role="tablist" aria-label="Staff leave" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)} data-testid={`hr-tab-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>
            {t}{t === "Requests" && pending ? <span className="ml-1.5 rounded-full bg-pencil-400 px-1.5 text-xs text-board-950" data-testid="pending-count">{pending}</span> : null}
          </button>
        ))}
      </div>
      {tab === "Requests" ? <RequestsTab schoolId={schoolId} onCount={setPending} />
        : tab === "All leave" ? <HistoryTab schoolId={schoolId} />
        : tab === "Balances" ? <BalancesTab schoolId={schoolId} />
        : tab === "Leave types" ? <TypesTab schoolId={schoolId} />
        : <CalendarTab schoolId={schoolId} />}
    </>
  );
}

export default function Page() {
  return <RequirePermission permission="hr:manage"><Suspense fallback={<LoadingState />}><StaffLeave /></Suspense></RequirePermission>;
}
