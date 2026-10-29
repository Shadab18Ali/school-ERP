"use client";

import { clsx } from "clsx";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { IssueTab } from "@/components/documents/issue";
import { IssuedTab } from "@/components/documents/issued";
import { DocumentSettingsPanel } from "@/components/documents/settings";
import { TemplatesTab } from "@/components/documents/templates";
import { PageHeader } from "@/components/layout/app-shell";
import { LoadingState } from "@/components/ui/states";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["Issue", "Issued", "Templates", "Settings"] as const;
type Tab = (typeof TABS)[number];

function Certificates() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const params = useSearchParams(); // /certificates?tab=Issued  ·  /certificates?student=<id>
  const [tab, setTab] = useState<Tab>("Issue");
  useEffect(() => {
    const t = params.get("tab") as Tab | null;
    if (t && TABS.includes(t)) setTab(t);
  }, [params]);
  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "Issue" ? "/certificates" : `/certificates?tab=${t}`); } catch { /* ignore */ }
  }
  return (
    <>
      <PageHeader title="Certificates" description="Bonafide, character, transfer, study and your own certificates — filled in from the student's record, numbered, signed, with a QR code anyone can scan to check them." />
      <div role="tablist" aria-label="Certificates" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)} data-testid={`certificates-tab-${t.toLowerCase()}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {tab === "Issue" ? <IssueTab schoolId={schoolId} initialStudent={params.get("student")} />
        : tab === "Issued" ? <IssuedTab schoolId={schoolId} />
        : tab === "Templates" ? <TemplatesTab schoolId={schoolId} />
        : <DocumentSettingsPanel schoolId={schoolId} />}
    </>
  );
}

export default function CertificatesPage() {
  return <RequirePermission permission="certificates:manage"><Suspense fallback={<LoadingState />}><Certificates /></Suspense></RequirePermission>;
}
