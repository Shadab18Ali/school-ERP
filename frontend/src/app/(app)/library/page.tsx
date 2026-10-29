"use client";

import { clsx } from "clsx";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Catalogue } from "@/components/library/catalogue";
import { LibraryKpis } from "@/components/library/dashboard";
import { Desk } from "@/components/library/desk";
import { BorrowersTab, LoansTab, MyBooks } from "@/components/library/loans";
import { LibrarySettingsTab } from "@/components/library/settings";
import { LoadingState } from "@/components/ui/states";
import type { LoanState } from "@/lib/library";
import type { Permission } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const ALL_TABS: { name: string; permission: Permission; staffOnly?: boolean }[] = [
  { name: "Dashboard", permission: "library:fines" },
  { name: "Issue & return", permission: "library:manage" },
  { name: "Catalogue", permission: "library:view" },
  { name: "Loans", permission: "library:fines" },
  { name: "Borrowers", permission: "library:manage" },
  { name: "My books", permission: "library:view", staffOnly: true },
  { name: "Settings", permission: "library:fines" },
];

function Library() {
  const { can, currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  // "My books": staff who borrow but don't run the library (teachers); librarians see everything else
  const tabs = useMemo(() => ALL_TABS.filter((t) => can(t.permission) && !(t.staffOnly && can("library:manage")) && !(t.name === "My books" && !can("teaching:view"))), [can]);
  const [tab, setTab] = useState(tabs[0]?.name ?? "Catalogue");
  const [loanState, setLoanState] = useState<LoanState>("open");

  const params = useSearchParams();  // follows links such as /library?tab=Loans&state=overdue
  useEffect(() => {
    const t = params.get("tab");
    if (t && tabs.some((x) => x.name === t)) setTab(t);
    const st = params.get("state") as LoanState | null;
    if (st) setLoanState(st);
  }, [params, tabs]);
  function choose(t: string) {
    setTab(t);
    try { window.history.replaceState(null, "", t === tabs[0]?.name ? "/library" : `/library?tab=${encodeURIComponent(t)}`); } catch { /* ignore */ }
  }

  return (
    <>
      <PageHeader title="Library" description={can("library:manage") ? "Books, copies, issues and returns, fines." : "The school library's books and your own loans."} />
      <div role="tablist" aria-label="Library" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <button key={t.name} role="tab" aria-selected={tab === t.name} onClick={() => choose(t.name)} data-testid={`library-tab-${t.name.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t.name ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t.name}</button>
        ))}
      </div>
      {tab === "Dashboard" ? <LibraryKpis schoolId={schoolId} />
        : tab === "Issue & return" ? <Desk schoolId={schoolId} />
        : tab === "Catalogue" ? <Catalogue schoolId={schoolId} />
        : tab === "Loans" ? <LoansTab key={loanState} schoolId={schoolId} initialState={loanState} />
        : tab === "Borrowers" ? <BorrowersTab schoolId={schoolId} />
        : tab === "My books" ? <MyBooks schoolId={schoolId} />
        : <LibrarySettingsTab schoolId={schoolId} />}
    </>
  );
}

export default function LibraryPage() {
  return <RequirePermission permission="library:view"><Suspense fallback={<LoadingState />}><Library /></Suspense></RequirePermission>;
}
