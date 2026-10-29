"use client";

import { clsx } from "clsx";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { CardsTab, PeopleTab } from "@/components/documents/id-cards";
import { DocumentSettingsPanel } from "@/components/documents/settings";
import { PageHeader } from "@/components/layout/app-shell";
import { LoadingState } from "@/components/ui/states";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["Students", "Teachers", "Staff", "Issued cards", "Settings"] as const;
type Tab = (typeof TABS)[number];

function IdCards() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>("Students");
  useEffect(() => {
    const t = params.get("tab") as Tab | null;
    if (t && TABS.includes(t)) setTab(t);
  }, [params]);
  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "Students" ? "/id-cards" : `/id-cards?tab=${encodeURIComponent(t)}`); } catch { /* ignore */ }
  }
  return (
    <>
      <PageHeader title="ID cards" description="Printable ID cards for students, teachers and staff, with photo, logo, signature and a QR code that shows whether the card is still valid." />
      <div role="tablist" aria-label="ID cards" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)} data-testid={`idcards-tab-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {tab === "Students" ? <PeopleTab key="student" schoolId={schoolId} kind="student" />
        : tab === "Teachers" ? <PeopleTab key="teacher" schoolId={schoolId} kind="teacher" />
        : tab === "Staff" ? <PeopleTab key="staff" schoolId={schoolId} kind="staff" />
        : tab === "Issued cards" ? <CardsTab schoolId={schoolId} />
        : <DocumentSettingsPanel schoolId={schoolId} />}
    </>
  );
}

export default function IdCardsPage() {
  return <RequirePermission permission="id_cards:manage"><Suspense fallback={<LoadingState />}><IdCards /></Suspense></RequirePermission>;
}
