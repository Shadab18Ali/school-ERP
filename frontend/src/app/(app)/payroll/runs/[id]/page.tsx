"use client";

import { clsx } from "clsx";
import { AlertTriangle, ArrowLeft, Download, FileText, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { FormError, Section, TextArea } from "@/components/hr/shared";
import { RunStatusPill } from "@/components/payroll/tabs";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { days, monthName, PAYMENT_MODE_LABEL, plural, type PaymentMode, type Payslip, type RunDetail } from "@/lib/hr";
import { formatINR } from "@/lib/money";
import { useAuth } from "@/providers/auth-provider";

const inr = (n: number | string | null) => formatINR(n === null ? null : typeof n === "number" ? n.toFixed(2) : n);

function SlipModal({ schoolId, slipId, onClose, onChanged }: { schoolId: string; slipId: string | null; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<Payslip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<"add" | "recover">("add");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!slipId) return;
    setS(null); setError(null); setLabel(""); setAmount(""); setFormError(null);
    apiFetch<Payslip>(`/payroll/payslips/${slipId}`, { schoolId }).then(setS).catch((e) => setError(errorMessage(e)));
  }, [slipId, schoolId]);
  if (!slipId) return null;
  async function addAdjustment() {
    setFormError(null);
    if (label.trim().length < 2) return setFormError("Describe it, e.g. Exam duty or Advance recovery.");
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) === 0) return setFormError("Enter the amount in rupees.");
    setBusy(true);
    try { setS(await apiFetch<Payslip>(`/payroll/payslips/${slipId}/adjustments`, { schoolId, method: "POST", body: { label: label.trim(), amount: kind === "add" ? amount.trim() : `-${amount.trim()}` } })); setLabel(""); setAmount(""); onChanged(); }
    catch (e) { setFormError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function removeAdjustment(id: string) {
    try { setS(await apiFetch<Payslip>(`/payroll/adjustments/${id}`, { schoolId, method: "DELETE" })); onChanged(); } catch (e) { toast.error(errorMessage(e)); }
  }
  async function pdf() {
    try { const { blob, filename } = await apiFetchBlob(`/payroll/payslips/${slipId}/pdf`, { schoolId }); saveBlob(blob, filename ?? "salary-slip.pdf"); } catch (e) { toast.error(errorMessage(e)); }
  }
  const draft = s?.run_status === "draft";
  return (
    <Modal open size="lg" title={s ? `${s.staff_name} · ${monthName(s.month)}` : "Payslip"} description={s ? `${s.employee_id}${s.subject ? ` · ${s.subject}` : ""}` : undefined} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={pdf} disabled={!s} data-testid="slip-pdf"><Download className="size-4" /> Salary slip (PDF)</Button></>}>
      {error ? <ErrorState message={error} /> : !s ? <LoadingState /> : (
        <div className="space-y-5 text-sm" data-testid="payslip">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-paper p-3 sm:grid-cols-4">
            <span>Working days <b className="block tabular">{s.working_days}</b></span>
            <span>Present <b className="block tabular">{days(s.present_days)}</b></span>
            <span>Paid leave <b className="block tabular">{days(s.paid_leave_days)}</b></span>
            <span>Unmarked <b className="block tabular">{days(s.unmarked_days)}</b></span>
            <span>Absent <b className="block tabular">{days(s.absent_days)}</b></span>
            <span>Half days <b className="block tabular">{days(s.half_days)}</b></span>
            <span>Unpaid leave <b className="block tabular">{days(s.unpaid_leave_days)}</b></span>
            <span>Before joining <b className="block tabular">{days(s.not_joined_days)}</b></span>
            <span className="col-span-2 sm:col-span-4">Loss of pay: <b data-testid="slip-lop">{plural(s.lop_days, "day")}</b> of {s.basis_days} {s.basis_days === s.working_days ? "working" : "calendar"} days</span>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <table className="w-full">
              <thead className="text-left text-xs text-muted"><tr><th className="pb-1 font-medium">Earnings</th><th className="pb-1 text-right font-medium">Full month</th><th className="pb-1 text-right font-medium">Earned</th></tr></thead>
              <tbody>
                {s.earnings.map((e) => <tr key={e.name}><td className="py-0.5">{e.name}</td><td className="tabular text-right text-muted">{inr(e.full)}</td><td className="tabular text-right">{inr(e.earned)}</td></tr>)}
                <tr className="border-t border-line font-medium"><td className="pt-1">Gross</td><td className="tabular pt-1 text-right text-muted">{inr(s.gross_full)}</td><td className="tabular pt-1 text-right" data-testid="slip-gross">{inr(s.gross_earned)}</td></tr>
              </tbody>
            </table>
            <table className="w-full">
              <thead className="text-left text-xs text-muted"><tr><th className="pb-1 font-medium">Deductions</th><th className="pb-1 text-right font-medium">Amount</th></tr></thead>
              <tbody>
                <tr><td className="py-0.5">Leave / absence ({days(s.lop_days)} days)</td><td className="tabular text-right" data-testid="slip-lop-amount">{inr(s.lop_amount)}</td></tr>
                {s.deductions.map((d) => <tr key={d.name}><td className="py-0.5">{d.name}</td><td className="tabular text-right">{inr(d.amount)}</td></tr>)}
                <tr className="border-t border-line font-medium"><td className="pt-1">Deductions (excl. leave)</td><td className="tabular pt-1 text-right">{inr(s.total_deductions)}</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <p className="mb-1.5 font-medium">Adjustments</p>
            {s.adjustments.length === 0 ? <p className="text-muted">None.</p> : (
              <ul className="divide-y divide-line rounded-md border border-line" data-testid="adjustments">
                {s.adjustments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span>{a.label} <span className="text-xs text-muted">{a.created_by_name ? `by ${a.created_by_name}` : ""}</span></span>
                    <span className="flex items-center gap-2"><span className={clsx("tabular", Number(a.amount) < 0 && "text-danger-600")}>{Number(a.amount) < 0 ? "−" : "+"}{inr(Math.abs(Number(a.amount)))}</span>
                      {draft && <Button size="sm" variant="ghost" onClick={() => removeAdjustment(a.id)} aria-label={`Remove ${a.label}`}><Trash2 className="size-4" /></Button>}</span>
                  </li>
                ))}
              </ul>
            )}
            {draft && (
              <div className="mt-3 grid gap-2 sm:grid-cols-[8rem_1fr_8rem_auto] sm:items-end">
                <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as "add" | "recover")} data-testid="adj-kind">
                  <option value="add">Add</option><option value="recover">Recover</option>
                </SelectField>
                <TextField label="For" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Exam duty, Advance" data-testid="adj-label" />
                <TextField label="Amount (₹)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="adj-amount" />
                <Button onClick={addAdjustment} loading={busy} data-testid="add-adjustment">Add</Button>
                <div className="sm:col-span-4"><FormError error={formError} testId="adj-error" /></div>
              </div>
            )}
          </div>
          <p className="flex items-baseline justify-between rounded-md bg-leaf-50 px-4 py-3 text-base font-semibold">
            <span>Net pay</span><span className="tabular" data-testid="slip-net">{inr(s.net_pay)}</span>
          </p>
        </div>
      )}
    </Modal>
  );
}

function PaidModal({ schoolId, run, open, onClose, onDone }: { schoolId: string; run: RunDetail; open: boolean; onClose: () => void; onDone: (r: RunDetail) => void }) {
  const [date, setDate] = useState(todayISO());
  const [mode, setMode] = useState<PaymentMode>("bank_transfer");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setDate(todayISO()); setMode("bank_transfer"); setRef(""); setError(null); } }, [open]);
  async function go() {
    setBusy(true); setError(null);
    try { onDone(await apiFetch<RunDetail>(`/payroll/runs/${run.id}/paid`, { schoolId, method: "POST", body: { paid_on: date, payment_mode: mode, payment_reference: ref.trim() || null } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} size="sm" title={`Mark ${monthName(run.month)} salaries paid`} description={`${run.staff} staff · ${formatINR(run.net)}`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={go} loading={busy} data-testid="confirm-paid">Mark paid</Button></>}>
      <div className="space-y-3">
        <FormError error={error} testId="paid-error" />
        <TextField label="Paid on" type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} data-testid="paid-on" />
        <SelectField label="Paid by" value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)} data-testid="paid-mode">
          {(Object.keys(PAYMENT_MODE_LABEL) as PaymentMode[]).map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
        </SelectField>
        <TextField label="Reference (optional)" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} placeholder="Bank batch / cheque no." />
        <p className="text-xs text-muted">A paid payroll is closed for good.</p>
      </div>
    </Modal>
  );
}

function RunView({ id }: { id: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const toast = useToast();
  const [r, setR] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slip, setSlip] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"finalize" | "discard" | "reopen" | "paid" | null>(null);
  const [reopenNote, setReopenNote] = useState("");
  const load = useCallback(async () => {
    setError(null);
    try { setR(await apiFetch<RunDetail>(`/payroll/runs/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function act(action: "recalculate" | "finalize" | "reopen", body: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      setR(await apiFetch<RunDetail>(`/payroll/runs/${id}/${action}`, { schoolId, method: "POST", body }));
      toast.success(action === "recalculate" ? "Recalculated from the latest attendance, leave and salaries." : action === "finalize" ? "Payroll finalized. The month's attendance and leave are now locked." : "Payroll reopened.");
      setConfirm(null);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  async function discard() {
    setBusy("discard");
    try { await apiFetch(`/payroll/runs/${id}`, { schoolId, method: "DELETE" }); toast.success("Draft discarded."); router.push("/payroll"); }
    catch (e) { toast.error(errorMessage(e)); setBusy(null); }
  }
  async function register() {
    try { const { blob, filename } = await apiFetchBlob(`/payroll/runs/${id}/register.csv`, { schoolId }); saveBlob(blob, filename ?? "salary-register.csv"); } catch (e) { toast.error(errorMessage(e)); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!r) return <LoadingState />;
  const draft = r.status === "draft";
  const canFinalize = todayISO() >= r.can_finalize_from;
  return (
    <div className="space-y-6">
      <Link href="/payroll" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Payroll</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="run-heading">Payroll · {monthName(r.month)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <RunStatusPill status={r.status} />
            {r.status === "paid" ? `Paid ${formatDate(r.paid_on)} by ${PAYMENT_MODE_LABEL[r.payment_mode!].toLowerCase()}${r.payment_reference ? ` (${r.payment_reference})` : ""}`
              : r.status === "finalized" ? `Finalized ${formatDate(r.finalized_at)}${r.finalized_by_name ? ` by ${r.finalized_by_name}` : ""}` : `Calculated ${formatDate(r.generated_at)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {draft && <Button variant="secondary" size="sm" onClick={() => act("recalculate")} loading={busy === "recalculate"} data-testid="recalculate"><RefreshCw className="size-4" /> Recalculate</Button>}
          {draft && <Button size="sm" onClick={() => setConfirm("finalize")} disabled={!canFinalize || r.payslips.length === 0} data-testid="finalize"
            title={canFinalize ? undefined : `From ${formatDate(r.can_finalize_from)}`}>Finalize</Button>}
          {r.status === "finalized" && <Button size="sm" onClick={() => setConfirm("paid")} data-testid="mark-paid">Mark paid</Button>}
          <Button variant="secondary" size="sm" onClick={register} disabled={r.payslips.length === 0} data-testid="register-csv"><Download className="size-4" /> Salary register</Button>
          {(draft || r.status === "finalized") && (
            <ActionMenu label="More payroll actions" actions={draft
              ? [{ label: "Discard draft…", onSelect: () => setConfirm("discard"), tone: "danger" }]
              : [{ label: "Reopen…", onSelect: () => { setReopenNote(""); setConfirm("reopen"); } }]} />
          )}
        </div>
      </div>

      {draft && !canFinalize && <p className="rounded-md bg-paper px-4 py-2.5 text-sm text-muted">This month isn&apos;t over: you can calculate and adjust now, and finalize from {formatDate(r.can_finalize_from)}.</p>}
      {r.reopen_note && draft && <p className="rounded-md bg-pencil-100/60 px-4 py-2.5 text-sm">Reopened: “{r.reopen_note}”</p>}
      {draft && r.pending_leave > 0 && (
        <p className="flex items-center gap-2 rounded-md bg-danger-50 px-4 py-2.5 text-sm text-danger-600" data-testid="pending-leave-warning"><AlertTriangle className="size-4" aria-hidden />
          {r.pending_leave} leave application{r.pending_leave === 1 ? " is" : "s are"} still pending for this month. <Link href="/staff-leave" className="underline">Decide them</Link>, then recalculate.
        </p>
      )}
      {draft && r.without_salary.length > 0 && (
        <p className="rounded-md bg-pencil-100/60 px-4 py-2.5 text-sm" data-testid="without-salary">
          Not included (no salary structure): {r.without_salary.map((s, i) => <span key={s.id}>{i > 0 && ", "}<Link href={`/payroll/staff/${s.id}`} className="underline">{s.full_name}</Link></span>)}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[["Staff", String(r.staff), "run-staff"], ["Gross earned", formatINR(r.gross), "run-gross"], ["Leave / absence deducted", formatINR(r.lop), "run-lop"], ["Deductions", formatINR(r.deductions), "run-deductions"], ["Net pay", formatINR(r.net), "run-net"]].map(([l, v, t]) => (
          <div key={t} className={clsx("rounded-lg border border-line p-4", t === "run-net" ? "bg-board-900 text-white" : "bg-white")}>
            <p className={clsx("text-sm", t === "run-net" ? "text-white/60" : "text-muted")}>{l}</p>
            <p className="tabular mt-1 text-xl font-semibold" data-testid={t}>{v}</p>
          </div>
        ))}
      </div>

      <Section title="Payslips" description={draft ? "Open a payslip to see the working, add an exam-duty payment or recover an advance, or download the slip." : "Open a payslip to download the salary slip."} testId="payslips">
        {r.payslips.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No payslips. Give staff a salary structure, then recalculate.</p> : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs text-muted">
                <tr><th className="px-4 py-2 font-medium">Staff</th><th className="px-3 py-2 text-right font-medium">Loss-of-pay days</th><th className="px-3 py-2 text-right font-medium">Gross earned</th>
                  <th className="px-3 py-2 text-right font-medium">Deductions</th><th className="px-3 py-2 text-right font-medium">Adjustments</th><th className="px-3 py-2 text-right font-medium">Net pay</th><th className="px-3 py-2"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.payslips.map((p) => (
                  <tr key={p.id} data-testid={`slip-${p.employee_id}`}>
                    <td className="px-4 py-2"><span className="font-medium">{p.staff_name}</span> <span className="text-xs text-muted">{p.employee_id}</span></td>
                    <td className={clsx("tabular px-3 py-2 text-right", Number(p.lop_days) > 0 && "text-danger-600")} data-testid="slip-row-lop">{days(p.lop_days)}</td>
                    <td className="tabular px-3 py-2 text-right">{formatINR(p.gross_earned)}</td>
                    <td className="tabular px-3 py-2 text-right">{formatINR(p.total_deductions)}</td>
                    <td className="tabular px-3 py-2 text-right">{Number(p.adjustments_total) === 0 ? "—" : formatINR(p.adjustments_total)}</td>
                    <td className="tabular px-3 py-2 text-right font-medium" data-testid="slip-row-net">{formatINR(p.net_pay)}</td>
                    <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => setSlip(p.id)} aria-label={`Open ${p.staff_name}'s payslip`} data-testid="open-slip"><FileText className="size-4" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <SlipModal schoolId={schoolId} slipId={slip} onClose={() => setSlip(null)} onChanged={() => void load()} />
      <ConfirmDialog open={confirm === "finalize"} tone="primary" title={`Finalize ${monthName(r.month)} payroll?`}
        message={`${r.staff} payslips, net ${formatINR(r.net)}. The month's staff attendance, holidays and leave decisions are locked, and payslips can't change unless the payroll is reopened.`}
        confirmLabel="Finalize" loading={busy === "finalize"} onConfirm={() => act("finalize")} onCancel={() => setConfirm(null)} />
      <ConfirmDialog open={confirm === "discard"} title="Discard this draft?" message="The draft payslips and their adjustments are deleted. You can calculate the month again." confirmLabel="Discard" loading={busy === "discard"} onConfirm={discard} onCancel={() => setConfirm(null)} />
      <Modal open={confirm === "reopen"} size="sm" title={`Reopen ${monthName(r.month)} payroll?`} onClose={() => setConfirm(null)}
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button><Button onClick={() => act("reopen", { note: reopenNote })} loading={busy === "reopen"} disabled={reopenNote.trim().length < 3} data-testid="confirm-reopen">Reopen</Button></>}>
        <div className="space-y-3 text-sm">
          <p>The month&apos;s attendance and leave can be corrected again and the payslips recalculated. The reason is kept with the payroll.</p>
          <TextArea label="Reason" required value={reopenNote} onChange={setReopenNote} maxLength={300} testId="reopen-note" />
        </div>
      </Modal>
      <PaidModal schoolId={schoolId} run={r} open={confirm === "paid"} onClose={() => setConfirm(null)} onDone={(x) => { setR(x); setConfirm(null); toast.success("Marked paid."); }} />
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="payroll:manage"><RunView id={id} /></RequirePermission>;
}
