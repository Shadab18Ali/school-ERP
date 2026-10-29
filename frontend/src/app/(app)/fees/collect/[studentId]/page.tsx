"use client";

import { clsx } from "clsx";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { CancelReceipt } from "@/components/fees/cancel-receipt";
import { ReceiptActions } from "@/components/fees/receipt-actions";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { formatINR, monthLabel, paiseToAmount, toPaise } from "@/lib/money";
import {
  MODE_LABELS, PAYMENT_MODE_LABELS, REFERENCE_LABELS, type Due, type PaymentDetail, type PaymentMode, type StudentFeeAccount,
} from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const newKey = () => crypto.randomUUID();
const thisMonth = () => `${todayISO().slice(0, 7)}-01`;

function status(d: Due): { label: string; tone: string } {
  if (Number(d.balance) === 0) return { label: "Paid", tone: "bg-leaf-50 text-leaf-700" };
  if (Number(d.paid) > 0) return { label: "Part paid", tone: "bg-pencil-100 text-ink" };
  if (d.due_month <= thisMonth()) return { label: "Overdue", tone: "bg-danger-50 text-danger-600" };
  return { label: "Due", tone: "bg-paper text-muted" };
}

function period(d: Due, session: string | null) {
  return d.frequency === "yearly" || d.frequency === "one_time" ? `${session ?? ""} (${monthLabel(d.due_month)})` : monthLabel(d.due_month);
}

function Account({ studentId }: { studentId: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const params = useSearchParams();
  const sessionId = params.get("session") ?? "";
  const [acc, setAcc] = useState<StudentFeeAccount | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({}); // due_id -> amount to pay (selected rows)
  const [date, setDate] = useState(todayISO());
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const [key, setKey] = useState(newKey); // one key per payment: a retried submit can never charge twice
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ payment: PaymentDetail; duplicate: boolean } | null>(null);
  const [optins, setOptins] = useState<Set<string>>(new Set());
  const [savingOptins, setSavingOptins] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const a = await apiFetch<StudentFeeAccount>(`/fee-collection/students/${studentId}`, { schoolId, query: { session_id: sessionId } });
      setAcc(a);
      setOptins(new Set(a.optional_fees.filter((o) => o.opted_in).map((o) => o.fee_item_id)));
    } catch (e) {
      setError({ message: errorMessage(e), notFound: e instanceof ApiError && (e.status === 404 || e.status === 422) });
    }
  }, [schoolId, studentId, sessionId]);
  useEffect(() => { void load(); }, [load]);

  const byDue = useMemo(() => new Map(acc?.dues.map((d) => [d.due_id, d]) ?? []), [acc]);
  const selected = Object.entries(amounts);
  const lineErrors = Object.fromEntries(selected.map(([id, amt]) => {
    const p = toPaise(amt);
    const max = toPaise(byDue.get(id)?.balance ?? "0") ?? 0;
    return [id, p === null || p <= 0 ? "Enter an amount" : p > max ? `Max ${formatINR(byDue.get(id)!.balance)}` : null];
  }));
  const totalPaise = selected.reduce((sum, [, amt]) => sum + (toPaise(amt) ?? 0), 0); // preview only; the server totals it

  if (error) return <ErrorState message={error.notFound ? "This student doesn't exist in this school." : error.message} onRetry={error.notFound ? undefined : load} />;
  if (!acc) return <LoadingState />;

  const canCollect = !!acc.enrollment_id && !acc.session_is_archived;
  const open = acc.dues.filter((d) => Number(d.balance) > 0);
  const toggle = (d: Due) => setAmounts((a) => {
    const n = { ...a };
    if (n[d.due_id] !== undefined) delete n[d.due_id]; else n[d.due_id] = String(Number(d.balance));
    return n;
  });
  const selectOverdue = () => setAmounts(Object.fromEntries(open.filter((d) => d.due_month <= thisMonth()).map((d) => [d.due_id, String(Number(d.balance))])));
  const refLabel = REFERENCE_LABELS[mode];

  async function pay() {
    setFormError(null);
    if (selected.length === 0) return setFormError("Select at least one fee to pay.");
    if (Object.values(lineErrors).some(Boolean)) return setFormError("Check the highlighted amounts.");
    if (mode !== "cash" && mode !== "other" && !reference.trim()) return setFormError(`Enter the ${refLabel}.`);
    if (date > todayISO()) return setFormError("The payment date can't be in the future.");
    setSaving(true);
    try {
      const res = await apiFetch<{ payment: PaymentDetail; duplicate: boolean }>(`/fee-collection/enrollments/${acc!.enrollment_id}/payments`, {
        method: "POST", schoolId,
        body: {
          idempotency_key: key, payment_date: date, payment_mode: mode,
          reference_number: reference.trim() || null, remarks: remarks.trim() || null,
          allocations: selected.map(([due_id, amount]) => ({ due_id, amount: paiseToAmount(toPaise(amount)!) })),
        },
      });
      setReceipt(res);
      setAmounts({}); setReference(""); setRemarks(""); setKey(newKey());
      await load();
    } catch (e) {
      setFormError(errorMessage(e)); // key kept: retrying the same payment can't create a second receipt
    } finally {
      setSaving(false);
    }
  }

  async function saveOptins() {
    setSavingOptins(true);
    try {
      const a = await apiFetch<StudentFeeAccount>(`/fee-collection/enrollments/${acc!.enrollment_id}/optins`, {
        method: "PUT", schoolId, body: { fee_item_ids: [...optins] },
      });
      setAcc(a);
      toast.success("Optional fees updated.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingOptins(false);
    }
  }

  const optinsChanged = acc.optional_fees.some((o) => o.opted_in !== optins.has(o.fee_item_id));

  return (
    <>
      <Link href="/fees/collect" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> All students</Link>
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">{acc.student_name}</h1>
        <p className="text-sm text-muted" data-testid="fee-student-summary">
          {acc.student_code}{acc.class_section ? ` · ${acc.class_section}` : ""}{acc.admission_number ? ` · Adm. ${acc.admission_number}` : ""} · Session {acc.session_name ?? "—"}
        </p>
      </div>

      {!acc.enrollment_id && <Notice>This student isn&apos;t enrolled in {acc.session_name ?? "the selected session"}.</Notice>}
      {acc.enrollment_id && !acc.has_structure && <Notice>Their class has no fee structure for {acc.session_name} yet. Set it up under Fees.</Notice>}
      {acc.has_structure && !acc.structure_active && <Notice>Their class&apos;s fee structure is inactive, so no new fees are added. Fees already paid are kept.</Notice>}
      {acc.session_is_archived && <Notice>{acc.session_name} is archived, so payments can&apos;t be recorded.</Notice>}
      {acc.status === "inactive" && <Notice>This student is inactive: existing dues are kept, but no new fees are added.</Notice>}

      <div className="mb-6 grid gap-3 sm:grid-cols-4" data-testid="fee-totals">
        {([["Total", acc.totals.total], ["Paid", acc.totals.paid], ["Outstanding", acc.totals.outstanding], ["Overdue", acc.totals.overdue]] as const).map(([label, v]) => (
          <div key={label} className={clsx("rounded-lg p-4", label === "Outstanding" ? "bg-board-900 text-white" : "border border-line bg-white")}>
            <p className={clsx("text-xs", label === "Outstanding" ? "text-white/60" : "text-muted")}>{label}</p>
            <p className={clsx("tabular mt-1 text-xl font-semibold", label === "Overdue" && Number(v) > 0 && "text-danger-600")} data-testid={`fee-total-${label.toLowerCase()}`}>{formatINR(v)}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {acc.optional_fees.length > 0 && (
            <section className="rounded-lg border border-line bg-white p-5">
              <h2 className="mb-3 font-semibold">Optional fees</h2>
              <div className="flex flex-wrap gap-3">
                {acc.optional_fees.map((o) => (
                  <label key={o.fee_item_id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
                    <input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" disabled={!canCollect} checked={optins.has(o.fee_item_id)}
                      onChange={(e) => setOptins((s) => { const n = new Set(s); if (e.target.checked) n.add(o.fee_item_id); else n.delete(o.fee_item_id); return n; })} />
                    {o.fee_head_name} <span className="text-muted">({formatINR(o.amount)})</span>
                  </label>
                ))}
              </div>
              {optinsChanged && <Button className="mt-3" size="sm" onClick={saveOptins} loading={savingOptins}>Save optional fees</Button>}
            </section>
          )}

          <section className="rounded-lg border border-line bg-white">
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="font-semibold">Fees</h2>
              {canCollect && open.some((d) => d.due_month <= thisMonth()) && <Button size="sm" variant="secondary" onClick={selectOverdue}>Select overdue</Button>}
            </div>
            {acc.dues.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="No fees" message="Nothing is due for this student in this session." />
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-sm" data-testid="dues">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th scope="col" className="w-10 px-4 py-2"><span className="sr-only">Pay</span></th>
                      <th scope="col" className="px-2 py-2">Fee</th>
                      <th scope="col" className="px-2 py-2">Period</th>
                      <th scope="col" className="px-2 py-2 text-right">Amount</th>
                      <th scope="col" className="hidden px-2 py-2 text-right sm:table-cell">Paid</th>
                      <th scope="col" className="px-2 py-2 text-right">Balance</th>
                      <th scope="col" className="px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {acc.dues.map((d) => {
                      const s = status(d);
                      const chosen = amounts[d.due_id] !== undefined;
                      return (
                        <tr key={d.due_id} className={clsx(chosen && "bg-leaf-50/60")} data-testid={`due-${d.fee_head_name}-${d.due_month.slice(0, 7)}`}>
                          <td className="px-4 py-2">
                            {Number(d.balance) > 0 && canCollect && (
                              <input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" checked={chosen} onChange={() => toggle(d)}
                                aria-label={`Pay ${d.fee_head_name} ${monthLabel(d.due_month)}`} />
                            )}
                          </td>
                          <td className="px-2 py-2 font-medium">{d.fee_head_name}{d.is_optional && <span className="ml-1 text-xs text-muted">(optional)</span>}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-muted">{period(d, acc.session_name)}</td>
                          <td className="tabular px-2 py-2 text-right">{formatINR(d.amount)}</td>
                          <td className="tabular hidden px-2 py-2 text-right text-muted sm:table-cell">{formatINR(d.paid)}</td>
                          <td className="tabular px-2 py-2 text-right" data-testid="due-balance">{formatINR(d.balance)}</td>
                          <td className="px-4 py-2"><span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", s.tone)}>{s.label}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-line bg-white">
            <h2 className="border-b border-line px-5 py-3.5 font-semibold">Payment history</h2>
            {acc.payments.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No payments yet.</p> : (
              <ul className="divide-y divide-line" data-testid="payment-history">
                {acc.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div>
                      <p className={p.cancelled_at ? "font-medium text-muted line-through" : "font-medium"}>{p.receipt_number} · {formatINR(p.amount)}</p>
                      <p className="text-xs text-muted">
                        {p.cancelled_at && <span className="mr-2 rounded-full bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-600" data-testid="receipt-cancelled">Cancelled</span>}
                        {formatDate(p.payment_date)} · {MODE_LABELS[p.payment_mode]}{p.reference_number ? ` (${p.reference_number})` : ""}
                        {p.received_by_name ? ` · by ${p.received_by_name}` : ""} · balance after {formatINR(p.balance_after)}
                      </p>
                    </div>
                    <span className="inline-flex gap-1">
                      <ReceiptActions paymentId={p.id} receiptNumber={p.receipt_number} schoolId={schoolId} size="sm" />
                      <CancelReceipt paymentId={p.id} receiptNumber={p.receipt_number} amount={p.amount} schoolId={schoolId}
                        mode={p.payment_mode} cancelled={!!p.cancelled_at} onDone={() => void load()} />
                    </span>
                    {p.cancelled_at && p.cancel_reason && <p className="w-full text-xs text-muted" data-testid="receipt-cancel-reason">Reason: {p.cancel_reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {canCollect && (
          <aside className="h-fit rounded-lg border border-line bg-white p-5 lg:sticky lg:top-20" aria-label="Record payment">
            <h2 className="mb-3 font-semibold">Record payment</h2>
            {formError && <p className="mb-3 rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="payment-error">{formError}</p>}
            {selected.length === 0 ? (
              <p className="text-sm text-muted">Tick the fees being paid. You can change an amount to take a part payment.</p>
            ) : (
              <ul className="mb-4 space-y-2">
                {selected.map(([id, amt]) => {
                  const d = byDue.get(id)!;
                  return (
                    <li key={id}>
                      <label className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{d.fee_head_name} · {monthLabel(d.due_month)}</span>
                        <span className="text-muted">₹</span>
                        <input value={amt} inputMode="decimal" aria-label={`Amount for ${d.fee_head_name} ${monthLabel(d.due_month)}`}
                          aria-invalid={lineErrors[id] ? true : undefined}
                          onChange={(e) => setAmounts((a) => ({ ...a, [id]: e.target.value }))}
                          className="h-8 w-24 rounded-md border border-line px-2 text-right text-sm aria-[invalid=true]:border-danger-600" />
                      </label>
                      {lineErrors[id] && <p className="text-right text-xs text-danger-600">{lineErrors[id]}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="space-y-3">
              <TextField label="Payment date" type="date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
              <SelectField label="Payment mode" value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
                {(Object.keys(PAYMENT_MODE_LABELS) as PaymentMode[]).map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</option>)}
              </SelectField>
              {refLabel && (
                <TextField label={mode === "other" ? `${refLabel} (optional)` : refLabel} required={mode !== "other"} maxLength={60}
                  value={reference} onChange={(e) => setReference(e.target.value)} />
              )}
              <TextField label="Remarks (optional)" maxLength={300} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
            <Button className="mt-4 w-full" onClick={pay} loading={saving} disabled={selected.length === 0} data-testid="record-payment">
              Record payment{totalPaise > 0 ? ` · ${formatINR(paiseToAmount(totalPaise))}` : ""}
            </Button>
          </aside>
        )}
      </div>

      {receipt && (
        <Modal open size="sm" onClose={() => setReceipt(null)} title={receipt.duplicate ? "Already recorded" : "Payment recorded"}
          description={receipt.duplicate ? "This payment had already been saved; no second payment was made." : undefined}
          footer={<Button onClick={() => setReceipt(null)}>Done</Button>}>
          <div className="space-y-3 text-sm" data-testid="receipt-dialog">
            <p>Receipt <span className="font-semibold" data-testid="receipt-number">{receipt.payment.receipt_number}</span></p>
            <ul className="divide-y divide-line rounded-md border border-line">
              {receipt.payment.lines.map((l, i) => (
                <li key={i} className="flex justify-between px-3 py-1.5"><span>{l.fee_head_name} · {monthLabel(l.due_month)}</span><span className="tabular">{formatINR(l.amount)}</span></li>
              ))}
              <li className="flex justify-between px-3 py-1.5 font-semibold"><span>Total paid</span><span className="tabular" data-testid="receipt-total">{formatINR(receipt.payment.amount)}</span></li>
            </ul>
            <p className="text-muted">Balance due now: <span className="font-medium text-ink">{formatINR(receipt.payment.balance_after)}</span></p>
            <ReceiptActions paymentId={receipt.payment.id} receiptNumber={receipt.payment.receipt_number} schoolId={schoolId} />
          </div>
        </Modal>
      )}
    </>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 rounded-md bg-pencil-100 px-4 py-3 text-sm" role="status">{children}</p>;
}

export default function StudentFeesPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = use(params);
  return <RequirePermission permission="fees:collect"><Suspense fallback={<LoadingState />}><Account studentId={studentId} /></Suspense></RequirePermission>;
}
