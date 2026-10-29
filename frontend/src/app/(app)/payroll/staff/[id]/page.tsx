"use client";

import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { FormError, Pill, Section } from "@/components/hr/shared";
import { RunStatusPill } from "@/components/payroll/tabs";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { days, monthName, type Calc, type Component, type StaffSalary, type Structure } from "@/lib/hr";
import { AMOUNT_PATTERN, formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

interface Line { component_id: string; include: boolean; calc: Calc; value: string }
const amountOf = (l: Line, basic: number) => (l.calc === "fixed" ? Number(l.value || 0) : Math.round(basic * Number(l.value || 0)) / 100);
const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function StructureModal({ schoolId, teacherId, open, structure, latest, onClose, onSaved }: {
  schoolId: string; teacherId: string; open: boolean; structure: Structure | null; latest: Structure | null; onClose: () => void; onSaved: (s: StaffSalary) => void;
}) {
  const [components, setComponents] = useState<Component[]>([]);
  const [from, setFrom] = useState(todayISO().slice(0, 7));
  const [basic, setBasic] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    apiFetch<Component[]>("/payroll/components", { schoolId }).then((cs) => {
      const base = structure ?? latest;   // a new structure starts from the latest one
      const usable = cs.filter((c) => c.is_active || base?.items.some((i) => i.component_id === c.id))
        .sort((x, y) => (x.kind === y.kind ? x.display_order - y.display_order || x.name.localeCompare(y.name) : x.kind === "earning" ? -1 : 1));
      setComponents(usable);
      setLines(usable.map((c) => {
        const it = base?.items.find((i) => i.component_id === c.id);
        return it ? { component_id: c.id, include: true, calc: it.calc, value: String(Number(it.value)) }
          : { component_id: c.id, include: !base, calc: c.calc, value: String(Number(c.default_value)) };
      }));
    }).catch((e) => setError(errorMessage(e)));
    setFrom(structure ? structure.effective_from.slice(0, 7) : todayISO().slice(0, 7));
    setBasic(structure ? String(Number(structure.basic)) : latest ? String(Number(latest.basic)) : "");
    setNote(structure?.note ?? "");
  }, [open, structure, latest, schoolId]);
  const b = Number(basic) || 0;
  const totals = useMemo(() => {
    let earn = b, ded = 0;
    for (const l of lines) {
      if (!l.include) continue;
      const c = components.find((x) => x.id === l.component_id);
      if (c?.kind === "earning") earn += amountOf(l, b); else ded += amountOf(l, b);
    }
    return { earn, ded };
  }, [lines, components, b]);

  async function save() {
    setError(null);
    if (!from) return setError("Choose the month it starts from.");
    if (!AMOUNT_PATTERN.test(basic.trim())) return setError("Enter the monthly basic salary in rupees.");
    for (const l of lines.filter((x) => x.include)) {
      const c = components.find((x) => x.id === l.component_id)!;
      if (!AMOUNT_PATTERN.test(l.value.trim())) return setError(`Enter ${c.name}.`);
      if (l.calc === "percent_basic" && Number(l.value) > 100) return setError(`${c.name}: a percentage of basic is at most 100.`);
    }
    setBusy(true);
    const body = { effective_from: `${from}-01`, basic: basic.trim(), note: note.trim() || null,
      items: lines.filter((l) => l.include).map((l) => ({ component_id: l.component_id, calc: l.calc, value: l.value.trim() })) };
    try { onSaved(await apiFetch<StaffSalary>(structure ? `/payroll/structures/${structure.id}` : `/payroll/staff/${teacherId}/structures`, { schoolId, method: structure ? "PUT" : "POST", body })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Modal open={open} size="lg" title={structure ? "Edit salary structure" : latest ? "New salary from a month (revision)" : "Set the salary"} onClose={busy ? () => {} : onClose}
      description={structure ? undefined : latest ? "Earlier months keep the old structure; this applies from the month you choose." : undefined}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-structure">Save</Button></>}>
      <div className="space-y-4">
        <FormError error={error} testId="structure-error" />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Applies from" type="month" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="structure-from" />
          <TextField label="Basic salary per month (₹)" inputMode="decimal" value={basic} onChange={(e) => setBasic(e.target.value)} data-testid="structure-basic" />
        </div>
        {components.length === 0 ? <p className="text-sm text-muted">No allowances or deductions set up yet (Payroll → Allowances &amp; deductions). The salary can be basic only.</p> : (
          <div className="relative overflow-x-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Component</th><th className="px-3 py-2 font-medium">Worked out as</th><th className="px-3 py-2 font-medium">Value</th><th className="px-3 py-2 text-right font-medium">Per month</th></tr></thead>
              <tbody className="divide-y divide-line">
                {lines.map((l, i) => {
                  const c = components.find((x) => x.id === l.component_id)!;
                  return (
                    <tr key={l.component_id} data-testid={`line-${c.name}`}>
                      <td className="px-3 py-2">
                        <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-leaf-600" checked={l.include} onChange={(e) => set(i, { include: e.target.checked })} data-testid="line-include" />
                          {c.name} <span className="text-xs text-muted">{c.kind === "earning" ? "allowance" : "deduction"}</span></label>
                      </td>
                      <td className="px-3 py-2">
                        <SelectField label={`${c.name} worked out as`} hideLabel value={l.calc} disabled={!l.include} onChange={(e) => set(i, { calc: e.target.value as Calc })}>
                          <option value="fixed">₹ amount</option><option value="percent_basic">% of basic</option>
                        </SelectField>
                      </td>
                      <td className="px-3 py-2"><TextField label={`${c.name} value`} className="w-28 [&_label]:sr-only" inputMode="decimal" value={l.value} disabled={!l.include} onChange={(e) => set(i, { value: e.target.value })} data-testid="line-value" /></td>
                      <td className="tabular px-3 py-2 text-right">{l.include ? `${c.kind === "deduction" ? "−" : ""}${formatINR(r2(amountOf(l, b)))}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <dl className="grid grid-cols-3 gap-3 rounded-md bg-paper p-3 text-sm" data-testid="structure-preview">
          <div><dt className="text-muted">Gross</dt><dd className="tabular font-semibold">{formatINR(r2(totals.earn))}</dd></div>
          <div><dt className="text-muted">Deductions</dt><dd className="tabular font-semibold">{formatINR(r2(totals.ded))}</dd></div>
          <div><dt className="text-muted">Net (full month)</dt><dd className="tabular font-semibold" data-testid="preview-net">{formatINR(r2(totals.earn - totals.ded))}</dd></div>
        </dl>
        <TextField label="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Annual increment" />
      </div>
    </Modal>
  );
}

function StaffSalaryView({ id }: { id: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const [d, setD] = useState<StaffSalary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Structure | "new" | null>(null);
  const [deleting, setDeleting] = useState<Structure | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch<StaffSalary>(`/payroll/staff/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  async function remove() {
    if (!deleting) return;
    try { setD(await apiFetch<StaffSalary>(`/payroll/structures/${deleting.id}`, { schoolId, method: "DELETE" })); toast.success("Removed."); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDeleting(null); }
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  const latest = d.structures[0] ?? null;
  const inForce = d.structures.find((s) => s.effective_from <= todayISO()) ?? null;
  return (
    <div className="space-y-6">
      <Link href="/payroll?tab=Salaries" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Salaries</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="salary-heading">{d.staff.full_name}</h1>
          <p className="mt-1 text-sm text-muted">{d.staff.employee_id}{d.staff.subject ? ` · ${d.staff.subject}` : ""} · joined {formatDate(d.staff.joining_date)}{d.staff.status !== "active" && " · inactive"}</p>
        </div>
        <Button onClick={() => setEditing("new")} data-testid="add-structure"><Plus className="size-4" /> {latest ? "Revise salary" : "Set salary"}</Button>
      </div>
      <Section title="Salary structures" description="The structure in force on a month's last day is used for that month's payroll." testId="structures">
        {d.structures.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No salary set. This staff member isn&apos;t included in payroll until one is.</p> : (
          <ul className="divide-y divide-line">
            {d.structures.map((s) => (
              <li key={s.id} className="space-y-2 px-5 py-4 text-sm" data-testid={`structure-${s.effective_from.slice(0, 7)}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">From {monthName(s.effective_from)}</p>
                  {s.id === inForce?.id && <Pill tone="ok">In force</Pill>}
                  {s.effective_from > todayISO() && <Pill tone="warn">Upcoming</Pill>}
                  {s.locked && <Pill tone="muted">Used in a finalized payroll</Pill>}
                  {s.note && <span className="text-muted">· {s.note}</span>}
                  {!s.locked && <span className="ml-auto"><ActionMenu label={`Actions for the structure from ${monthName(s.effective_from)}`} actions={[
                    { label: "Edit…", onSelect: () => setEditing(s) }, { label: "Remove…", onSelect: () => setDeleting(s), tone: "danger" }]} /></span>}
                </div>
                <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
                  <div>
                    <p className="flex justify-between"><span>Basic</span><span className="tabular">{formatINR(s.basic)}</span></p>
                    {s.items.filter((i) => i.kind === "earning").map((i) => <p key={i.component_id} className="flex justify-between"><span>{i.name}{i.calc === "percent_basic" ? ` (${Number(i.value)}% of basic)` : ""}</span><span className="tabular">{formatINR(i.amount)}</span></p>)}
                    <p className="flex justify-between border-t border-line pt-1 font-medium"><span>Gross</span><span className="tabular">{formatINR(s.gross)}</span></p>
                  </div>
                  <div>
                    {s.items.filter((i) => i.kind === "deduction").map((i) => <p key={i.component_id} className="flex justify-between"><span>{i.name}{i.calc === "percent_basic" ? ` (${Number(i.value)}% of basic)` : ""}</span><span className="tabular">−{formatINR(i.amount)}</span></p>)}
                    <p className="flex justify-between border-t border-line pt-1 font-medium"><span>Net (full month)</span><span className="tabular" data-testid="structure-net">{formatINR(s.net)}</span></p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Payslips" testId="staff-payslips">
        {d.payslips.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No payslips yet.</p> : (
          <ul className="divide-y divide-line text-sm">
            {d.payslips.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5">
                <Link href={`/payroll/runs/${p.run_id}`} className="min-w-0 flex-1 font-medium hover:underline">{monthName(p.month)}</Link>
                <RunStatusPill status={p.status} />
                <span className="text-muted">{Number(p.lop_days) > 0 ? `${days(p.lop_days)} days loss of pay` : "no loss of pay"}</span>
                <span className="tabular w-28 text-right font-medium">{formatINR(p.net_pay)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <StructureModal schoolId={schoolId} teacherId={id} open={editing !== null} structure={editing === "new" ? null : editing} latest={latest} onClose={() => setEditing(null)}
        onSaved={(x) => { setEditing(null); setD(x); toast.success("Salary saved."); }} />
      <ConfirmDialog open={deleting !== null} title="Remove this salary structure?" message="Draft payrolls pick up the structure in force when they're recalculated." confirmLabel="Remove" onConfirm={remove} onCancel={() => setDeleting(null)} />
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="payroll:manage"><StaffSalaryView id={id} /></RequirePermission>;
}
