"use client";

import { clsx } from "clsx";
import { ArrowLeft, Copy, Plus } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { RecordStatusBadge } from "@/components/classes/status";
import { CopyStructureModal } from "@/components/fees/copy-modal";
import { FeeItemModal } from "@/components/fees/item-modal";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatINR, MONTH_NAMES, monthLabel, sessionMonths } from "@/lib/money";
import { FREQUENCY_LABELS, type AcademicSession, type FeeHead, type FeeItem, type FeeStructureDetail } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function when(i: FeeItem, months: number[]): string {
  if (i.frequency === "monthly") {
    if (!i.billing_months) return "Every month";
    const skipped = months.filter((m) => !i.billing_months!.includes(m)).map((m) => MONTH_NAMES[m - 1]);
    return skipped.length ? `Except ${skipped.join(", ")}` : "Every month";
  }
  return i.due_months.map((d) => monthLabel(d).split(" ")[0]).join(", ");
}

function Detail({ id }: { id: string }) {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const [d, setD] = useState<FeeStructureDetail | null>(null);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [heads, setHeads] = useState<FeeHead[]>([]);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [itemOpen, setItemOpen] = useState(false);
  const [editing, setEditing] = useState<FeeItem | null>(null);
  const [removing, setRemoving] = useState<FeeItem | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detail, ss, hs] = await Promise.all([
        apiFetch<FeeStructureDetail>(`/fee-structures/${id}`, { schoolId }),
        apiFetch<AcademicSession[]>("/sessions", { schoolId }),
        apiFetch<FeeHead[]>("/fee-heads", { schoolId }),
      ]);
      setD(detail);
      setSessions(ss);
      setHeads(hs);
    } catch (e) {
      setError({ message: errorMessage(e), notFound: e instanceof ApiError && (e.status === 404 || e.status === 422) });
    }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error.notFound ? "This fee structure doesn't exist in this school." : error.message} onRetry={error.notFound ? undefined : load} />;
  if (!d) return <LoadingState />;

  const session = sessions.find((s) => s.id === d.academic_session_id);
  const months = session ? sessionMonths(session.start_date, session.end_date) : [];
  const writable = can("fee_structures:manage") && !d.session_is_archived;
  const nextSession = sessions.filter((s) => !s.is_archived && session && s.start_date > session.start_date).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];

  async function newHead(name: string): Promise<FeeHead> {
    const h = await apiFetch<FeeHead>("/fee-heads", { method: "POST", schoolId, body: { name } });
    setHeads((x) => [...x, h]);
    return h;
  }

  async function removeItem() {
    if (!removing) return;
    setBusy(true);
    try {
      setD(await apiFetch<FeeStructureDetail>(`/fee-structures/${d!.id}/items/${removing.id}`, { method: "DELETE", schoolId }));
      toast.success(`${removing.fee_head_name} removed.`);
      setRemoving(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    try {
      setD(await apiFetch<FeeStructureDetail>(`/fee-structures/${d!.id}`, { method: "PATCH", schoolId, body: { is_active: !d!.is_active } }));
      toast.success(d!.is_active ? "Fee structure deactivated." : "Fee structure activated.");
      setToggling(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const compulsory = d.items.filter((i) => !i.is_optional);
  const optional = d.items.filter((i) => i.is_optional);

  const table = (rows: FeeItem[], title: string) => rows.length === 0 ? null : (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="px-5 pb-1 pt-4 text-left text-xs font-semibold text-muted">{title}</caption>
        <thead className="text-left text-xs text-muted">
          <tr>
            <th scope="col" className="px-5 py-2">Fee</th>
            <th scope="col" className="px-3 py-2 text-right">Amount</th>
            <th scope="col" className="px-3 py-2">Frequency</th>
            <th scope="col" className="hidden px-3 py-2 md:table-cell">When</th>
            <th scope="col" className="px-3 py-2 text-right">Per year</th>
            {writable && <th scope="col" className="w-12 px-3 py-2"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((i) => (
            <tr key={i.id} data-testid={`fee-item-${i.fee_head_name}`}>
              <td className="px-5 py-2.5 font-medium">{i.fee_head_name}</td>
              <td className="tabular px-3 py-2.5 text-right">{formatINR(i.amount)}</td>
              <td className="px-3 py-2.5">{FREQUENCY_LABELS[i.frequency]}{i.occurrences > 1 && i.frequency !== "monthly" ? ` ×${i.occurrences}` : ""}</td>
              <td className="hidden px-3 py-2.5 text-muted md:table-cell">{when(i, months)}</td>
              <td className="tabular px-3 py-2.5 text-right" data-testid="annual-amount">{formatINR(i.annual_amount)}</td>
              {writable && (
                <td className="px-3 py-2.5">
                  <ActionMenu label={`Actions for ${i.fee_head_name}`} actions={[
                    { label: "Edit", onSelect: () => { setEditing(i); setItemOpen(true); } },
                    { label: "Remove", onSelect: () => setRemoving(i), tone: "danger" },
                  ]} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <Link href={`/fees?session=${d.academic_session_id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> All fee structures
      </Link>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{d.class_name} fees</h1>
            <RecordStatusBadge active={d.is_active} />
          </div>
          <p className="mt-1 text-sm text-muted">Session {d.session_name}{d.session_is_archived ? " (archived, read-only)" : ""}</p>
        </div>
        {can("fee_structures:manage") && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setCopyOpen(true)} disabled={d.items.length === 0}><Copy className="size-4" /> Copy</Button>
            {!d.session_is_archived && (
              <Button variant="secondary" onClick={() => setToggling(true)} data-testid="toggle-structure">{d.is_active ? "Deactivate" : "Activate"}</Button>
            )}
            {writable && <Button onClick={() => { setEditing(null); setItemOpen(true); }}><Plus className="size-4" /> Add fee item</Button>}
          </div>
        )}
      </div>

      {!d.is_active && (
        <p className="mb-4 rounded-md bg-pencil-100 px-4 py-3 text-sm" role="status">This structure is inactive and won&apos;t be used for new fee assignments.</p>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="totals">
        {[
          ["Compulsory per year", d.totals.annual_compulsory, true],
          ["Monthly (compulsory)", d.totals.monthly_compulsory, false],
          ["One-time (compulsory)", d.totals.one_time_compulsory, false],
          ["Optional per year", d.totals.annual_optional, false],
        ].map(([label, value, strong]) => (
          <div key={label as string} className={clsx("rounded-lg p-4", strong ? "bg-board-900 text-white" : "border border-line bg-white")}>
            <p className={clsx("text-xs", strong ? "text-white/60" : "text-muted")}>{label as string}</p>
            <p className="tabular mt-1 text-xl font-semibold" data-testid={`total-${(label as string).split(" ")[0].toLowerCase()}`}>{formatINR(value as string)}</p>
          </div>
        ))}
      </div>

      <section className="mb-6 rounded-lg border border-line bg-white">
        <h2 className="border-b border-line px-5 py-3.5 font-semibold">Fee items</h2>
        {d.items.length === 0 ? (
          <EmptyState icon={Plus} title="No fee items yet"
            message={writable ? "Add tuition, admission, exam, transport and other fees. Set each one's amount and how often it's charged." : "No fees have been set."}
            action={writable ? <Button onClick={() => { setEditing(null); setItemOpen(true); }}><Plus className="size-4" /> Add fee item</Button> : undefined} />
        ) : (
          <div className="pb-2">
            {table(compulsory, "Compulsory")}
            {table(optional, "Optional")}
          </div>
        )}
      </section>

      {d.schedule.length > 0 && (
        <section className="rounded-lg border border-line bg-white">
          <div className="border-b border-line px-5 py-3.5">
            <h2 className="font-semibold">Month by month</h2>
            <p className="text-sm text-muted">What falls due in each month of {d.session_name}.</p>
          </div>
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm" data-testid="schedule">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-5 py-2">Month</th>
                  <th scope="col" className="px-3 py-2">Fees due</th>
                  <th scope="col" className="px-3 py-2 text-right">Compulsory</th>
                  <th scope="col" className="px-5 py-2 text-right">Optional</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.schedule.map((m) => (
                  <tr key={m.month} data-testid={`schedule-${monthLabel(m.month)}`}>
                    <td className="whitespace-nowrap px-5 py-2.5 font-medium">{monthLabel(m.month)}</td>
                    <td className="px-3 py-2.5 text-muted">{m.lines.map((l) => l.fee_head_name + (l.is_optional ? " (optional)" : "")).join(", ")}</td>
                    <td className="tabular px-3 py-2.5 text-right">{formatINR(m.compulsory)}</td>
                    <td className="tabular px-5 py-2.5 text-right text-muted">{Number(m.optional) ? formatINR(m.optional) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <FeeItemModal open={itemOpen} schoolId={schoolId} structureId={d.id} item={editing} heads={heads}
        usedHeadIds={d.items.map((i) => i.fee_head_id)} months={months} onNewHead={newHead}
        onClose={() => setItemOpen(false)}
        onSaved={(nd) => { setD(nd); setItemOpen(false); toast.success(editing ? "Fee item saved." : "Fee item added."); }} />
      <ConfirmDialog open={removing !== null} title={`Remove ${removing?.fee_head_name}?`}
        message="It's removed from this structure; the totals update straight away." confirmLabel="Remove" loading={busy}
        onConfirm={removeItem} onCancel={() => setRemoving(null)} />
      <ConfirmDialog open={toggling} title={d.is_active ? "Deactivate this fee structure?" : "Activate this fee structure?"}
        message={d.is_active ? "It stays visible but won't be used for new fee assignments until activated again." : "It will be used for fee assignments again."}
        confirmLabel={d.is_active ? "Deactivate" : "Activate"} tone="primary" loading={busy}
        onConfirm={toggleActive} onCancel={() => setToggling(false)} />
      <CopyStructureModal open={copyOpen} schoolId={schoolId} structureId={d.id} className={d.class_name} sessions={sessions}
        defaultSessionId={(nextSession ?? session)?.id ?? d.academic_session_id}
        onClose={() => setCopyOpen(false)}
        onDone={(created, skipped) => {
          setCopyOpen(false);
          toast.success(`Copied to ${created} class${created === 1 ? "" : "es"}${skipped.length ? `; ${skipped.length} already had one` : ""}.`);
        }} />
    </>
  );
}

export default function FeeStructurePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="fee_structures:view"><Detail id={id} /></RequirePermission>;
}
