"use client";

import { clsx } from "clsx";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { EnquiryList, type ListFilters } from "@/components/enquiries/enquiry-list";
import { PipelineView } from "@/components/enquiries/pipeline";
import { EnquiryFormModal } from "@/components/enquiries/shared";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ENQUIRY_STATUS_LABEL, type EnquiryStatus } from "@/lib/enquiries";
import { useAuth } from "@/providers/auth-provider";

const EMPTY: ListFilters = { session: "", status: "", followUp: "" };

function Enquiries() {
  const router = useRouter();
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [tab, setTab] = useState<"pipeline" | "list">("pipeline");
  const [filters, setFilters] = useState<ListFilters>(EMPTY);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);

  // deep links: /enquiries?tab=list&status=follow_up&follow_up=today
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const st = q.get("status");
    const fu = q.get("follow_up");
    if (q.get("tab") === "list" || st || fu) {
      setFilters({
        session: "",
        status: st && st in ENQUIRY_STATUS_LABEL ? (st as EnquiryStatus) : "",
        followUp: fu === "overdue" || fu === "today" || fu === "week" || fu === "none" ? fu : "",
      });
      setTab("list");
    }
  }, []);
  const openList = (f: ListFilters) => { setFilters(f); setVersion((v) => v + 1); setTab("list"); };

  return (
    <>
      <PageHeader title="Enquiries" description="Admission enquiries from parents: follow-ups, status and the admission pipeline."
        actions={can("enquiries:manage") ? <Button onClick={() => setAdding(true)} data-testid="new-enquiry"><Plus className="size-4" /> New enquiry</Button> : undefined} />
      <div role="tablist" aria-label="Enquiries" className="mb-4 flex gap-1 border-b border-line">
        {([["pipeline", "Pipeline"], ["list", "All enquiries"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => { if (k === "list") setFilters(EMPTY); setVersion((v) => v + 1); setTab(k); }}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === k ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{l}</button>
        ))}
      </div>
      {tab === "pipeline"
        ? <PipelineView key={version} schoolId={schoolId}
            onPickStatus={(status, session) => openList({ session, status, followUp: "" })}
            onPickFollowUp={(followUp, session) => openList({ session, status: "", followUp })} />
        : <EnquiryList key={`${version}-${filters.session}-${filters.status}-${filters.followUp}`} schoolId={schoolId} initial={filters} />}
      <EnquiryFormModal schoolId={schoolId} open={adding} onClose={() => setAdding(false)} onSaved={(e) => router.push(`/enquiries/${e.id}`)} />
    </>
  );
}

export default function EnquiriesPage() {
  return <RequirePermission permission="enquiries:view"><Enquiries /></RequirePermission>;
}
