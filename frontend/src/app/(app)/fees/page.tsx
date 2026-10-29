"use client";

import { IndianRupee, Plus, Tags } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { RecordStatusBadge } from "@/components/classes/status";
import { FeeHeadsModal } from "@/components/fees/fee-heads-modal";
import { PageHeader } from "@/components/layout/app-shell";
import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatINR } from "@/lib/money";
import type { AcademicSession, FeeStructureDetail, FeeStructureList } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function Structures() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const canManage = can("fee_structures:manage");
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [sessions, setSessions] = useState<AcademicSession[] | null>(null);
  const [data, setData] = useState<FeeStructureList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [headsOpen, setHeadsOpen] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);

  const sessionId = params.get("session") ?? "";
  const load = useCallback(async () => {
    setError(null);
    try {
      const [ss, list] = await Promise.all([
        apiFetch<AcademicSession[]>("/sessions", { schoolId }),
        apiFetch<FeeStructureList>("/fee-structures", { schoolId, query: { session_id: sessionId } }),
      ]);
      setSessions(ss);
      setData(list);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [schoolId, sessionId]);
  useEffect(() => { void load(); }, [load]);

  async function create(classId: string) {
    if (!data?.session) return;
    setCreating(classId);
    try {
      const d = await apiFetch<FeeStructureDetail>("/fee-structures", {
        method: "POST", schoolId, body: { academic_session_id: data.session.id, class_id: classId },
      });
      router.push(`/fees/structures/${d.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setCreating(null);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data || !sessions) return <LoadingState />;
  const writable = canManage && data.session && !data.session_archived;

  return (
    <>
      <PageHeader title="Fee structures"
        description={data.session ? `What each class pays in ${data.session.name}. Totals are calculated from each item's amount and frequency.` : undefined}
        actions={<>
          {data.session && (
            <SelectField label="Academic session" hideLabel className="w-44" value={data.session.id}
              onChange={(e) => router.replace(`${pathname}?session=${e.target.value}`)}>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : s.is_archived ? " (archived)" : ""}</option>)}
            </SelectField>
          )}
          <Button variant="secondary" onClick={() => setHeadsOpen(true)}><Tags className="size-4" /> Fee heads</Button>
        </>}
      />

      {!data.session ? (
        <div className="rounded-lg border border-line bg-white"><EmptyState icon={IndianRupee} title="No academic session yet" message="Fee structures belong to an academic session." /></div>
      ) : (
        <>
          {data.session_archived && (
            <p className="mb-4 rounded-md bg-pencil-100 px-4 py-3 text-sm" role="status">{data.session.name} is archived, so its fee structures are read-only.</p>
          )}
          {data.items.length === 0 && data.classes_without_structure.length === 0 ? (
            <div className="rounded-lg border border-line bg-white"><EmptyState icon={IndianRupee} title="No classes yet" message="Add classes first, then set their fees here." /></div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.items.map((s) => (
                <Link key={s.id} href={`/fees/structures/${s.id}`} data-testid={`structure-card-${s.class_name}`}
                  className="rounded-lg border border-line bg-white p-5 transition-colors hover:border-leaf-600">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="font-semibold">{s.class_name}</h2>
                      <p className="text-xs text-muted">{s.totals.item_count} fee item{s.totals.item_count === 1 ? "" : "s"}{s.name ? ` · ${s.name}` : ""}</p>
                    </div>
                    <RecordStatusBadge active={s.is_active} />
                  </div>
                  <p className="tabular mt-4 text-2xl font-semibold tracking-tight" data-testid="annual-total">{formatINR(s.totals.annual_compulsory)}</p>
                  <p className="text-xs text-muted">compulsory per year</p>
                  <dl className="tabular mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 text-sm">
                    <div><dt className="text-xs text-muted">Monthly</dt><dd>{formatINR(s.totals.monthly_compulsory)}</dd></div>
                    <div><dt className="text-xs text-muted">Optional / year</dt><dd>{formatINR(s.totals.annual_optional)}</dd></div>
                  </dl>
                </Link>
              ))}
              {data.classes_without_structure.map((c) => (
                <div key={c.id} className="flex flex-col justify-between rounded-lg border border-dashed border-line bg-white/60 p-5" data-testid={`no-structure-${c.name}`}>
                  <div>
                    <h2 className="font-semibold">{c.name}</h2>
                    <p className="text-sm text-muted">No fee structure for {data.session!.name}.</p>
                  </div>
                  {writable && (
                    <Button className="mt-4 self-start" size="sm" variant="secondary" onClick={() => create(c.id)} loading={creating === c.id}>
                      <Plus className="size-4" /> Create
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <FeeHeadsModal open={headsOpen} schoolId={schoolId} canManage={canManage} onClose={() => setHeadsOpen(false)} onChanged={() => {}} />
    </>
  );
}

function FeesHome() {
  const { can } = useAuth();
  if (can("fee_structures:view")) return <Suspense fallback={<LoadingState />}><Structures /></Suspense>;
  // Parents: their own fees arrive with fee collection.
  return (
    <ModulePlaceholder title="Fees" description="Fees and payments." icon={IndianRupee}
      plannedFor={["See fees due for your child", "Pay fees online", "Download receipts"]} />
  );
}

export default function FeesPage() {
  return <RequirePermission permission="fees:view"><FeesHome /></RequirePermission>;
}
