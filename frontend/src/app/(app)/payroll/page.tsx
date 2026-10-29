"use client";

import { clsx } from "clsx";
import { Lock } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { ComponentsTab, PayrollSettingsTab, RunsTab, SalariesTab } from "@/components/payroll/tabs";
import { LoadingState } from "@/components/ui/states";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["Monthly payroll", "Salaries", "Allowances & deductions", "Settings"] as const;
type Tab = (typeof TABS)[number];

function Payroll() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>("Monthly payroll");
  useEffect(() => { const t = params.get("tab") as Tab | null; if (t && TABS.includes(t)) setTab(t); }, [params]);
  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "Monthly payroll" ? "/payroll" : `/payroll?tab=${encodeURIComponent(t)}`); } catch { /* ignore */ }
  }
  return (
    <>
      <PageHeader title="Payroll" description="Salary structures, the monthly payroll and salary slips." />
      <p className="-mt-3 mb-5 flex items-center gap-1.5 text-xs text-muted" data-testid="payroll-private"><Lock className="size-3.5" aria-hidden /> Visible only to this school&apos;s administrators. Every payroll action and slip download is recorded.</p>
      <div role="tablist" aria-label="Payroll" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)} data-testid={`payroll-tab-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {tab === "Monthly payroll" ? <RunsTab schoolId={schoolId} />
        : tab === "Salaries" ? <SalariesTab schoolId={schoolId} />
        : tab === "Allowances & deductions" ? <ComponentsTab schoolId={schoolId} />
        : <PayrollSettingsTab schoolId={schoolId} />}
    </>
  );
}

export default function Page() {
  return <RequirePermission permission="payroll:manage"><Suspense fallback={<LoadingState />}><Payroll /></Suspense></RequirePermission>;
}
