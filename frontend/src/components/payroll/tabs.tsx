"use client";

import { AlertTriangle, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FormError, Pill, Section } from "@/components/hr/shared";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { monthName, RUN_STATUS_LABEL, type Component, type HrSettings, type Run, type RunDetail, type RunStatus, type SalaryStaff } from "@/lib/hr";
import { AMOUNT_PATTERN, formatINR } from "@/lib/money";

export function RunStatusPill({ status }: { status: RunStatus }) {
  return <Pill tone={status === "paid" ? "ok" : status === "finalized" ? "warn" : "muted"} testId="run-status">{RUN_STATUS_LABEL[status]}</Pill>;
}

// ------------------------------------------------------------------ monthly payroll
const prevMonth = () => { const d = new Date(`${todayISO().slice(0, 7)}-01T00:00:00`); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

export function RunsTab({ schoolId }: { schoolId: string }) {
  const router = useRouter();
  const [d, setD] = useState<{ items: Run[]; staff_without_salary: number; this_month: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(prevMonth());
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch("/payroll/runs", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  async function run(e: FormEvent) {
    e.preventDefault();
    setRunError(null);
    if (!month) return setRunError("Choose the month.");
    const existing = d?.items.find((r) => r.month.startsWith(month));
    if (existing) { router.push(`/payroll/runs/${existing.id}`); return; }
    setBusy(true);
    try { const r = await apiFetch<RunDetail>("/payroll/runs", { schoolId, method: "POST", body: { month: `${month}-01` } }); router.push(`/payroll/runs/${r.id}`); }
    catch (err) { setRunError(errorMessage(err)); setBusy(false); }
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  return (
    <div className="space-y-6">
      <Section title="Run payroll" description="Calculates every active staff member's pay for the month from their salary structure, attendance and approved leave. You can recalculate until you finalize." testId="run-payroll">
        <form onSubmit={run} className="flex flex-wrap items-end gap-3 p-5" noValidate>
          <TextField label="Month" type="month" value={month} max={todayISO().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} data-testid="run-month" />
          <Button type="submit" loading={busy} data-testid="run-payroll-button"><Wallet className="size-4" /> {d.items.some((r) => r.month.startsWith(month)) ? "Open" : "Calculate"}</Button>
          <div className="w-full"><FormError error={runError} testId="run-error" /></div>
          {d.staff_without_salary > 0 && (
            <p className="flex w-full items-center gap-2 text-sm text-danger-600"><AlertTriangle className="size-4" aria-hidden />
              {d.staff_without_salary} active staff member{d.staff_without_salary === 1 ? " has" : "s have"} no salary structure and won&apos;t be paid. <Link href="/payroll?tab=Salaries" className="underline">Salaries</Link>
            </p>
          )}
        </form>
      </Section>
      <Section title="Payroll by month" testId="runs">
        {d.items.length === 0 ? <div className="p-4"><EmptyState icon={Wallet} title="No payroll yet" message="Set up allowances and deductions, give each staff member a salary structure, then run the month." /></div> : (
          <ul className="divide-y divide-line">
            {d.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm" data-testid={`run-${r.month.slice(0, 7)}`}>
                <div className="min-w-0 flex-1 basis-48">
                  <Link href={`/payroll/runs/${r.id}`} className="font-medium hover:underline">{monthName(r.month)}</Link>
                  <p className="text-xs text-muted">{r.staff} staff{r.paid_on ? ` · paid ${formatDate(r.paid_on)}` : r.finalized_at ? ` · finalized ${formatDate(r.finalized_at)}` : ` · calculated ${formatDate(r.generated_at)}`}</p>
                </div>
                <RunStatusPill status={r.status} />
                <span className="tabular w-32 text-right font-medium">{formatINR(r.net)} <span className="block text-xs font-normal text-muted">net pay</span></span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ salaries
export function SalariesTab({ schoolId }: { schoolId: string }) {
  const [items, setItems] = useState<SalaryStaff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiFetch<SalaryStaff[]>("/payroll/staff", { schoolId }).then(setItems).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!items) return <LoadingState />;
  return (
    <Section title="Salaries" description="Each staff member's salary in force today. Open one to set or change it." testId="salaries">
      {items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No active staff. Add them on the Teachers page.</p> : (
        <ul className="divide-y divide-line">
          {items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm" data-testid={`salary-${s.employee_id}`}>
              <div className="min-w-0 flex-1 basis-48">
                <Link href={`/payroll/staff/${s.id}`} className="font-medium hover:underline">{s.full_name}</Link> <span className="text-xs text-muted">{s.employee_id}</span>
                <p className="text-xs text-muted">{s.effective_from ? `Since ${monthName(s.effective_from)}` : `Joined ${formatDate(s.joining_date)}`}</p>
              </div>
              {s.structure_id ? (
                <span className="tabular text-right">
                  <span className="block">Basic {formatINR(s.basic)} · gross {formatINR(s.gross ?? null)}</span>
                  <span className="block text-xs text-muted" data-testid="salary-net">net {formatINR(s.net ?? null)} a month</span>
                </span>
              ) : <Pill tone="bad" testId="no-salary">No salary set</Pill>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ components
function ComponentModal({ schoolId, open, component, onClose, onSaved }: { schoolId: string; open: boolean; component: Component | null; onClose: () => void; onSaved: (c: Component[]) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"earning" | "deduction">("earning");
  const [calc, setCalc] = useState<"fixed" | "percent_basic">("fixed");
  const [value, setValue] = useState("");
  const [order, setOrder] = useState("0");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(component?.name ?? ""); setKind(component?.kind ?? "earning"); setCalc(component?.calc ?? "fixed");
    setValue(component ? String(Number(component.default_value)) : ""); setOrder(String(component?.display_order ?? 0)); setActive(component?.is_active ?? true);
  }, [open, component]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Name it, e.g. House rent allowance or Provident fund.");
    if (!AMOUNT_PATTERN.test(value.trim() || "0")) return setError(calc === "fixed" ? "Enter the usual amount in rupees (0 if it varies)." : "Enter the percentage of basic.");
    if (calc === "percent_basic" && Number(value) > 100) return setError("A percentage of basic is at most 100.");
    setBusy(true);
    try {
      onSaved(await apiFetch<Component[]>(component ? `/payroll/components/${component.id}` : "/payroll/components", { schoolId, method: component ? "PUT" : "POST",
        body: { name, kind, calc, default_value: value.trim() || "0", display_order: Number(order) || 0, is_active: active } }));
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} title={component ? `Edit ${component.name}` : "Add an allowance or deduction"} onClose={busy ? () => {} : onClose}
      description="The value here is the default; each staff member's salary structure can use a different one."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="comp-form" loading={busy} data-testid="save-component">{component ? "Save" : "Add"}</Button></>}>
      <form id="comp-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="component-error" /></div>
        <TextField className="sm:col-span-2" label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="comp-name" />
        <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as "earning" | "deduction")} data-testid="comp-kind">
          <option value="earning">Allowance (adds to pay)</option>
          <option value="deduction">Deduction (taken from pay)</option>
        </SelectField>
        <SelectField label="Worked out as" value={calc} onChange={(e) => setCalc(e.target.value as "fixed" | "percent_basic")} data-testid="comp-calc">
          <option value="fixed">A fixed amount (₹)</option>
          <option value="percent_basic">A percentage of basic</option>
        </SelectField>
        <TextField label={calc === "fixed" ? "Default amount (₹)" : "Default percentage of basic"} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} data-testid="comp-value" />
        <TextField label="Order on the slip" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} />
        {component && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-4 accent-leaf-600" checked={active} onChange={(e) => setActive(e.target.checked)} /> In use (can be added to salary structures)</label>}
        <p className="text-xs text-muted sm:col-span-2">Percentage deductions (e.g. provident fund) are worked out on the basic actually earned in the month, after loss of pay.</p>
      </form>
    </Modal>
  );
}

export function ComponentsTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<Component[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Component | "new" | null>(null);
  useEffect(() => { apiFetch<Component[]>("/payroll/components", { schoolId }).then(setItems).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!items) return <LoadingState />;
  const row = (c: Component) => (
    <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm" data-testid={`component-${c.name}`}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{c.name} {!c.is_active && <Pill tone="muted">Not in use</Pill>}</p>
        <p className="text-xs text-muted">Default {c.calc === "fixed" ? formatINR(c.default_value) : `${Number(c.default_value)}% of basic`} · in {c.used} salary structure{c.used === 1 ? "" : "s"}</p>
      </div>
      <ActionMenu label={`Actions for ${c.name}`} actions={[{ label: "Edit…", onSelect: () => setEditing(c) }]} />
    </li>
  );
  const earn = items.filter((c) => c.kind === "earning");
  const ded = items.filter((c) => c.kind === "deduction");
  return (
    <div className="space-y-6">
      <div className="flex justify-end"><Button onClick={() => setEditing("new")} data-testid="add-component"><Plus className="size-4" /> Add allowance or deduction</Button></div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Allowances" testId="allowances">{earn.length ? <ul className="divide-y divide-line">{earn.map(row)}</ul> : <p className="px-5 py-6 text-sm text-muted">None yet, e.g. House rent allowance (40% of basic), Dearness allowance, Transport allowance (₹1,600).</p>}</Section>
        <Section title="Deductions" testId="deductions">{ded.length ? <ul className="divide-y divide-line">{ded.map(row)}</ul> : <p className="px-5 py-6 text-sm text-muted">None yet, e.g. Provident fund (12% of basic), Professional tax, TDS.</p>}</Section>
      </div>
      <p className="text-xs text-muted">Amounts and percentages are the school&apos;s own; nothing is built in. Statutory rates (PF, ESI, professional tax, TDS) are entered by the school as they apply.</p>
      <ComponentModal schoolId={schoolId} open={editing !== null} component={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={(list) => { setEditing(null); setItems(list); toast.success("Saved."); }} />
    </div>
  );
}

// ------------------------------------------------------------------ settings
export function PayrollSettingsTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [s, setS] = useState<HrSettings | null>(null);
  const [form, setForm] = useState<HrSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { apiFetch<HrSettings>("/hr/settings", { schoolId }).then((x) => { setS(x); setForm(x); }).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!s || !form) return <LoadingState />;
  async function save() {
    setBusy(true);
    try { const x = await apiFetch<HrSettings>("/hr/settings", { schoolId, method: "PUT", body: form }); setS(x); setForm(x); toast.success("Payroll settings saved. Recalculate draft payrolls to apply them."); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  const changed = form.lop_basis !== s.lop_basis || form.unmarked_as !== s.unmarked_as;
  return (
    <Section title="How pay is counted" testId="payroll-settings">
      <div className="max-w-2xl space-y-5 p-5 text-sm">
        <fieldset>
          <legend className="mb-2 font-medium">A day&apos;s pay is the month&apos;s pay divided by</legend>
          <label className="mb-1.5 flex items-start gap-2"><input type="radio" name="basis" className="mt-0.5 accent-leaf-600" checked={form.lop_basis === "working_days"} onChange={() => setForm({ ...form, lop_basis: "working_days" })} data-testid="basis-working" />
            <span>The month&apos;s working days<span className="block text-xs text-muted">Weekly offs and holidays aren&apos;t counted (e.g. 26 in a 30-day month with four Sundays).</span></span></label>
          <label className="flex items-start gap-2"><input type="radio" name="basis" className="mt-0.5 accent-leaf-600" checked={form.lop_basis === "calendar_days"} onChange={() => setForm({ ...form, lop_basis: "calendar_days" })} data-testid="basis-calendar" />
            <span>The month&apos;s calendar days<span className="block text-xs text-muted">28 to 31.</span></span></label>
        </fieldset>
        <fieldset>
          <legend className="mb-2 font-medium">A working day with no attendance marked counts as</legend>
          <label className="mb-1.5 flex items-center gap-2"><input type="radio" name="unmarked" className="accent-leaf-600" checked={form.unmarked_as === "present"} onChange={() => setForm({ ...form, unmarked_as: "present" })} data-testid="unmarked-present" /> Present (mark only absences)</label>
          <label className="flex items-center gap-2"><input type="radio" name="unmarked" className="accent-leaf-600" checked={form.unmarked_as === "absent"} onChange={() => setForm({ ...form, unmarked_as: "absent" })} data-testid="unmarked-absent" /> Absent (loss of pay unless marked present or on leave)</label>
        </fieldset>
        <p className="rounded-md bg-paper px-3 py-2 text-muted">Loss of pay = absent days + ½ for each half day + unpaid leave + working days before joining. Paid leave isn&apos;t deducted. Earnings are paid in proportion to the days not lost; the difference shows on the slip as the leave / absence deduction.</p>
        <Button onClick={save} loading={busy} disabled={!changed} data-testid="save-payroll-settings">Save</Button>
      </div>
    </Section>
  );
}
