"use client";

import { CalendarOff, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { ApplyLeaveModal, BalanceCards, CancelLeaveModal, LeaveSummary, Section, SessionSelect } from "@/components/hr/shared";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { todayISO } from "@/lib/format";
import { plural, type Leave, type MyLeave } from "@/lib/hr";
import { useAuth } from "@/providers/auth-provider";

function MyLeavePage() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const [session, setSession] = useState("");
  const [d, setD] = useState<MyLeave | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState<Leave | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { const r = await apiFetch<MyLeave>("/hr/my", { schoolId, query: { session_id: session || undefined } }); setD(r); if (!session && r.session) setSession(r.session.id); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, session]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  if (!d.staff) {
    return (
      <>
        <PageHeader title="My leave" />
        <div className="rounded-lg border border-line bg-white" data-testid="no-staff-record">
          <EmptyState icon={CalendarOff} title="Your login isn't linked to a staff record" message="Leave is applied for on a staff record. Ask the school office to link your login to your record on the Teachers page." />
        </div>
      </>
    );
  }
  const current = d.sessions.find((s) => s.id === d.session?.id)?.is_current ?? true;
  return (
    <>
      <PageHeader title="My leave" description={`${d.staff.full_name} · ${d.staff.employee_id}${d.session ? ` · ${d.session.name}` : ""}`} />
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SessionSelect sessions={d.sessions} value={session} onChange={setSession} />
          <Button onClick={() => setApplying(true)} data-testid="apply-leave"><Plus className="size-4" /> Apply for leave</Button>
        </div>
        {d.session ? <BalanceCards balances={d.balances} /> : <p className="text-sm text-muted">No academic session is set up yet.</p>}
        <Section title="My applications" description={current ? undefined : "An earlier session"} testId="my-applications">
          {d.items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No leave applied for in this session.</p> : (
            <ul className="divide-y divide-line">
              {d.items.map((l) => {
                const cancellable = l.status === "pending" || (l.status === "approved" && l.start_date > todayISO());
                return (
                  <li key={l.id} className="flex flex-wrap items-start gap-3 px-5 py-3" data-testid="my-leave">
                    <LeaveSummary l={l} showStaff={false} />
                    {cancellable && <Button size="sm" variant="secondary" onClick={() => setCancelling(l)} data-testid="cancel-leave">Cancel</Button>}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
      <ApplyLeaveModal schoolId={schoolId} open={applying} balances={d.balances} onClose={() => setApplying(false)}
        onDone={(l) => { setApplying(false); toast.success(`Applied for ${plural(l.days, "day")} of ${l.leave_type}. It's pending approval.`); void load(); }} />
      <CancelLeaveModal schoolId={schoolId} leave={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); toast.success("Leave cancelled."); void load(); }} />
    </>
  );
}

export default function Page() {
  return <RequirePermission permission="leave:self"><MyLeavePage /></RequirePermission>;
}
