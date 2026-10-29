"use client";

import { CreditCard, FilePlus2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  EntitlementList, InvoiceTable, PaymentsTable, StatusSummary, useInvoicePdf,
} from "@/components/platform/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { formatINR } from "@/lib/money";
import {
  addDays, CYCLE_LABEL, EVENT_LABEL, type BillingCycle, type Invoice, type Plan, type SubPayment, type SubscriptionView,
} from "@/lib/platform";
import type { School } from "@/lib/types";

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/;

function Section({ title, action, children, testId }: { title: string; action?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>{action}
      </div>
      {children}
    </section>
  );
}

type CancelMode = "at_period_end" | "resume" | "now" | "reactivate";
const CANCEL_TEXT: Record<CancelMode, { title: string; message: string; label: string; tone: "danger" | "primary" }> = {
  at_period_end: { title: "End at the end of the period?", message: "Nothing more is billed. The school keeps working until its paid period (or trial) ends, then becomes read-only.", label: "End at period end", tone: "danger" },
  resume: { title: "Keep the subscription?", message: "It will renew as usual.", label: "Keep it", tone: "primary" },
  now: { title: "Cancel now?", message: "The school becomes read-only immediately. Its records stay; you can reactivate it later.", label: "Cancel now", tone: "danger" },
  reactivate: { title: "Reactivate the subscription?", message: "It continues on the same plan. Whether the school has full access depends on what is paid.", label: "Reactivate", tone: "primary" },
};

export function SubscriptionPanel({ school }: { school: School }) {
  const toast = useToast();
  const [view, setView] = useState<SubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [voiding, setVoiding] = useState<Invoice | null>(null);
  const [refunding, setRefunding] = useState<SubPayment | null>(null);
  const [cancel, setCancel] = useState<CancelMode | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { download } = useInvoicePdf();
  const load = useCallback(async () => {
    setError(null);
    try { setView(await apiFetch<SubscriptionView>(`/admin/schools/${school.id}/subscription`)); } catch (e) { setError(errorMessage(e)); }
  }, [school.id]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<SubscriptionView>, done: string) {
    setBusy(true);
    try { setView(await fn()); toast.success(done); return true; } catch (e) { toast.error(errorMessage(e)); return false; } finally { setBusy(false); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!view) return <LoadingState />;
  const sub = view.subscription;
  const st = view.status;

  return (
    <div className="space-y-6">
      <Section title="Subscription" testId="subscription-card" action={
        <div className="flex flex-wrap gap-2">
          {sub && st.status !== "cancelled" && (
            <Button size="sm" variant="secondary" disabled={busy} data-testid="issue-invoice"
              onClick={() => run(() => apiFetch(`/admin/schools/${school.id}/invoices`, { method: "POST" }), "Invoice issued.")}>
              <FilePlus2 className="size-4" /> Issue next invoice
            </Button>
          )}
          {sub && (st.status === "cancelled"
            ? <Button size="sm" variant="secondary" onClick={() => setCancel("reactivate")} data-testid="sub-reactivate">Reactivate</Button>
            : st.cancel_at_period_end
              ? <Button size="sm" variant="secondary" onClick={() => setCancel("resume")} data-testid="sub-resume">Keep subscription</Button>
              : <>
                <Button size="sm" variant="secondary" onClick={() => setCancel("at_period_end")} data-testid="sub-cancel-end">End at period end</Button>
                <Button size="sm" variant="secondary" onClick={() => setCancel("now")} data-testid="sub-cancel-now">Cancel now</Button>
              </>)}
          <Button size="sm" variant={sub ? "secondary" : "primary"} onClick={() => setEditing(true)} data-testid="change-subscription">
            {sub ? "Change" : "Start subscription"}
          </Button>
        </div>}>
        <div className="p-5">
          {sub ? <>
            <StatusSummary status={st} sub={sub} extra={<>
              {!sub.plan_is_active && <p className="mt-2 text-xs text-muted">This plan is retired: the school keeps it, but it can&apos;t be given to other schools.</p>}
              {sub.cancel_reason && <p className="mt-2 text-sm"><span className="text-muted">Reason given: </span>{sub.cancel_reason}</p>}
              {sub.notes && <p className="mt-2 rounded-md bg-paper px-3 py-2 text-sm"><span className="text-muted">Platform notes (not shown to the school): </span>{sub.notes}</p>}
            </>} />
            <h3 className="mb-2 mt-6 text-sm font-semibold">What the plan includes</h3>
            <EntitlementList rows={view.entitlements} />
          </> : (
            <EmptyState icon={CreditCard} title="No subscription yet" message="Start one: choose the plan, monthly or yearly billing, and whether it begins with a trial. Until then nothing is limited." />
          )}
        </div>
      </Section>

      {sub && <>
        <Section title="Invoices" testId="invoices-card">
          <InvoiceTable invoices={view.invoices} pdf={(i) => download(`/admin/invoices/${i.id}/pdf`, i.id, i.invoice_number)}
            actions={(i) => <>
              {["open", "overdue", "partly_paid"].includes(i.state) && (
                <Button size="sm" onClick={() => setPaying(i)} data-testid="record-payment">Record payment</Button>
              )}
              {i.state !== "void" && Number(i.paid) === 0 && (
                <Button size="sm" variant="secondary" onClick={() => setVoiding(i)} data-testid="void-invoice">Cancel invoice</Button>
              )}
            </>} />
        </Section>
        <Section title="Payments" testId="payments-card">
          <PaymentsTable payments={view.payments} actions={(p) => Number(p.amount) > Number(p.refunded_amount) && (
            p.method === "razorpay"
              ? <span className="text-xs text-muted">Refund in Razorpay</span>
              : <Button size="sm" variant="secondary" onClick={() => setRefunding(p)} data-testid="refund-payment">Record refund</Button>
          )} />
        </Section>
      </>}

      {view.history && view.history.length > 0 && (
        <Section title="History">
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm" data-testid="subscription-history">
              <thead className="bg-paper text-left text-xs text-muted">
                <tr><th className="px-4 py-2 font-medium">When</th><th className="px-4 py-2 font-medium">What</th><th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 text-right font-medium">Price</th><th className="px-4 py-2 font-medium">Trial ends</th><th className="px-4 py-2 font-medium">By</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {view.history.map((h) => (
                  <tr key={h.id}>
                    <td className="whitespace-nowrap px-4 py-2">{formatDate(h.changed_at)}</td>
                    <td className="px-4 py-2">{EVENT_LABEL[h.action] ?? h.action}{h.details?.reason ? <span className="block text-xs text-muted">{h.details.reason}</span> : null}</td>
                    <td className="px-4 py-2">{h.plan_name} · {CYCLE_LABEL[h.billing_cycle]}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{h.price ? formatINR(h.price) : "Plan's price"}</td>
                    <td className="whitespace-nowrap px-4 py-2">{h.trial_ends_at ? formatDate(h.trial_ends_at) : "—"}</td>
                    <td className="px-4 py-2 text-muted">{h.changed_by ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <SubscriptionModal open={editing} school={school} current={view} onClose={() => setEditing(false)}
        onSaved={(v) => { setView(v); setEditing(false); }} />
      <PaymentModal invoice={paying} onClose={() => setPaying(null)} onSaved={(v) => { setView(v); setPaying(null); }} />
      <ReasonModal open={voiding !== null} title={`Cancel invoice ${voiding?.invoice_number ?? ""}?`} label="Reason" testId="void"
        message="A cancelled invoice keeps its number and stays on record; nothing is owed on it. Only an invoice with no payments can be cancelled."
        onClose={() => setVoiding(null)}
        onSubmit={async (r) => { if (await run(() => apiFetch(`/admin/invoices/${voiding!.id}/void`, { method: "POST", body: { reason: r } }), "Invoice cancelled.")) setVoiding(null); }} />
      <RefundModal payment={refunding} onClose={() => setRefunding(null)} onSaved={(v) => { setView(v); setRefunding(null); }} />
      <ConfirmDialog open={cancel !== null} title={cancel ? CANCEL_TEXT[cancel].title : ""}
        message={<>
          <span className="block">{cancel ? CANCEL_TEXT[cancel].message : ""}</span>
          {(cancel === "at_period_end" || cancel === "now") && (
            <span className="mt-3 block"><TextField label="Reason (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-testid="cancel-reason" /></span>
          )}
        </>}
        confirmLabel={cancel ? CANCEL_TEXT[cancel].label : ""} tone={cancel ? CANCEL_TEXT[cancel].tone : "primary"} loading={busy}
        onCancel={() => { setCancel(null); setReason(""); }}
        onConfirm={async () => {
          if (!cancel) return;
          const ok = await run(() => apiFetch(`/admin/schools/${school.id}/subscription/cancel`, { method: "POST", body: { mode: cancel, reason: reason.trim() || null } }),
            cancel === "resume" ? "The subscription continues." : cancel === "reactivate" ? "Reactivated." : cancel === "now" ? "Cancelled." : "It will end at the end of the period.");
          if (ok) { setCancel(null); setReason(""); }
        }} />
    </div>
  );
}

type TrialChoice = "plan" | "none" | "until";

function SubscriptionModal({ open, school, current, onClose, onSaved }: {
  open: boolean; school: School; current: SubscriptionView; onClose: () => void; onSaved: (v: SubscriptionView) => void;
}) {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[]>([]);
  const sub = current.subscription;
  const today = todayISO();
  const blank = { plan_id: "", billing_cycle: "yearly" as BillingCycle, price: "", started_on: today, trial: "plan" as TrialChoice,
    trial_ends_at: addDays(today, 13), gstin: "", notes: "" };
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    apiFetch<Plan[]>("/admin/plans").then(setPlans).catch((e) => setError(errorMessage(e)));
    setF(sub ? {
      plan_id: sub.plan_id, billing_cycle: sub.billing_cycle, price: sub.agreed_price ?? "", started_on: sub.started_on, trial: "plan",
      trial_ends_at: sub.trial_ends_at ?? "", gstin: sub.billing_gstin ?? "", notes: sub.notes ?? "",
    } : { ...blank, started_on: todayISO(), trial_ends_at: addDays(todayISO(), 13) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sub]);

  const plan = plans.find((p) => p.id === f.plan_id);
  const listPrice = plan ? (f.billing_cycle === "yearly" ? plan.price_yearly : plan.price_monthly) : null;
  const offered = plans.filter((p) => p.is_active || p.id === sub?.plan_id);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const onTrial = current.status.status === "trialing" || (current.status.status === "cancelling" && current.status.on_trial);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!f.plan_id) return setError("Choose a plan.");
    if (f.price && !MONEY.test(f.price)) return setError("Enter the price in rupees, e.g. 15000 or 1499.50 — or leave it empty for the plan's price.");
    if (f.gstin && !GSTIN.test(f.gstin)) return setError("The GSTIN should be 15 characters, e.g. 07ABCDE1234F1Z5.");
    if (!sub && f.started_on > today) return setError("A subscription starts today or earlier.");
    if (!sub && f.trial === "until" && (!f.trial_ends_at || f.trial_ends_at < f.started_on)) return setError("Choose when the trial ends (on or after the start).");
    const body: Record<string, unknown> = { plan_id: f.plan_id, billing_cycle: f.billing_cycle, price: f.price || null, billing_gstin: f.gstin || null, notes: f.notes.trim() || null };
    if (!sub) Object.assign(body, { started_on: f.started_on, trial: f.trial, trial_ends_at: f.trial === "until" ? f.trial_ends_at : null });
    else if (onTrial && f.trial_ends_at && f.trial_ends_at !== sub.trial_ends_at) body.trial_ends_at = f.trial_ends_at;
    setSaving(true); setError(null);
    try {
      const v = await apiFetch<SubscriptionView>(`/admin/schools/${school.id}/subscription`, { method: "PUT", body });
      toast.success(sub ? "Subscription updated." : `${school.name} is on ${v.subscription?.plan_name}${v.issued_invoice ? `; invoice ${v.issued_invoice} issued` : ""}.`);
      onSaved(v);
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title={sub ? "Change subscription" : "Start a subscription"} description={school.name} size="lg"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="submit" form="sub-form" loading={saving} data-testid="save-subscription">{sub ? "Save" : "Start"}</Button></>}>
      <form id="sub-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="sub-error">{error}</p>}
        <SelectField label="Plan" value={f.plan_id} onChange={(e) => set({ plan_id: e.target.value })} data-testid="sub-plan">
          <option value="">Choose…</option>
          {offered.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_active ? "" : " (retired)"}</option>)}
        </SelectField>
        <SelectField label="Billing" value={f.billing_cycle} data-testid="sub-cycle" onChange={(e) => set({ billing_cycle: e.target.value as BillingCycle })}>
          {(Object.keys(CYCLE_LABEL) as BillingCycle[]).map((c) => <option key={c} value={c}>{CYCLE_LABEL[c]}</option>)}
        </SelectField>
        <TextField label="Agreed price per cycle (₹, before tax)" inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value.trim() })} data-testid="sub-price"
          placeholder={listPrice ?? ""} hint={listPrice ? `Empty: the plan's price at each invoice (now ${formatINR(listPrice)})` : "Choose a plan first"} />
        <TextField label="School's GSTIN (optional)" value={f.gstin} maxLength={15} onChange={(e) => set({ gstin: e.target.value.toUpperCase().trim() })} data-testid="sub-gstin"
          hint="Printed on its invoices" />
        {!sub ? <>
          <TextField label="Starts" type="date" value={f.started_on} max={today} onChange={(e) => e.target.value && set({ started_on: e.target.value })} data-testid="sub-start" />
          <SelectField label="Trial" value={f.trial} onChange={(e) => set({ trial: e.target.value as TrialChoice })} data-testid="sub-trial-choice">
            <option value="plan">{plan ? (plan.trial_days > 0 ? `The plan's trial (${plan.trial_days} days)` : "The plan's trial (none)") : "The plan's trial"}</option>
            <option value="none">No trial: invoice now</option>
            <option value="until">Trial until a date…</option>
          </SelectField>
          {f.trial === "until" && <TextField label="Trial ends" type="date" value={f.trial_ends_at} min={f.started_on} onChange={(e) => set({ trial_ends_at: e.target.value })} data-testid="sub-trial" />}
          <p className="text-xs text-muted sm:col-span-2">
            {(f.trial === "none" || (f.trial === "plan" && plan?.trial_days === 0))
              ? "The first invoice is issued as soon as you start (once the platform's billing details are entered)."
              : "No invoice during the trial. The renewal run issues the first one shortly before the trial ends."}
          </p>
        </> : <>
          {onTrial && <TextField label="Trial ends" type="date" value={f.trial_ends_at} onChange={(e) => set({ trial_ends_at: e.target.value })} data-testid="sub-trial"
            hint="Extend or shorten the running trial" />}
          <p className="text-xs text-muted sm:col-span-2">A new plan applies at once to what the school can use (limits and features); a new price or billing period applies from the next invoice. Nothing is prorated.</p>
        </>}
        <div className="sm:col-span-2">
          <TextField label="Platform notes" hint="Only the platform sees these." value={f.notes} maxLength={1000}
            onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. agreed discount, contact person" />
        </div>
      </form>
    </Modal>
  );
}

const METHODS = [["bank_transfer", "Bank transfer"], ["upi", "UPI"], ["cheque", "Cheque"], ["cash", "Cash"], ["other", "Other"]] as const;

export function PaymentModal({ invoice, onClose, onSaved }: {
  invoice: Pick<Invoice, "id" | "invoice_number" | "total" | "paid"> | null; onClose: () => void; onSaved: (v: SubscriptionView) => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({ amount: "", method: "bank_transfer", reference: "", paid_on: todayISO() });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const balance = invoice ? (Number(invoice.total) - Number(invoice.paid)).toFixed(2) : "0";
  useEffect(() => { if (invoice) { setF({ amount: balance, method: "bank_transfer", reference: "", paid_on: todayISO() }); setError(null); } }, [invoice, balance]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    if (!MONEY.test(f.amount) || Number(f.amount) <= 0) return setError("Enter the amount received.");
    if (f.method !== "cash" && !f.reference.trim()) return setError("Enter the reference (UTR, UPI transaction id or cheque number).");
    setSaving(true); setError(null);
    try {
      const v = await apiFetch<SubscriptionView>(`/admin/invoices/${invoice.id}/payments`, { method: "POST",
        body: { amount: f.amount, method: f.method, reference: f.reference.trim() || null, paid_on: f.paid_on } });
      toast.success(`Payment of ${formatINR(f.amount)} recorded.`);
      onSaved(v);
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }
  return (
    <Modal open={invoice !== null} onClose={saving ? () => {} : onClose} size="sm" title="Record a payment"
      description={invoice ? `${invoice.invoice_number} · ${formatINR(balance)} still due` : undefined}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="pay-form" loading={saving} data-testid="save-payment">Record</Button></>}>
      <form id="pay-form" onSubmit={save} className="space-y-4" noValidate>
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="payment-error">{error}</p>}
        <TextField label="Amount (₹)" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.trim() })} data-testid="payment-amount" />
        <SelectField label="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} data-testid="payment-method">
          {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectField>
        <TextField label={f.method === "cash" ? "Reference (optional)" : "Reference"} value={f.reference} maxLength={100} onChange={(e) => setF({ ...f, reference: e.target.value })}
          data-testid="payment-reference" hint="UTR, UPI transaction id or cheque number" />
        <TextField label="Received on" type="date" value={f.paid_on} max={todayISO()} onChange={(e) => e.target.value && setF({ ...f, paid_on: e.target.value })} />
      </form>
    </Modal>
  );
}

function RefundModal({ payment, onClose, onSaved }: { payment: SubPayment | null; onClose: () => void; onSaved: (v: SubscriptionView) => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const left = payment ? (Number(payment.amount) - Number(payment.refunded_amount)).toFixed(2) : "0";
  useEffect(() => { if (payment) { setAmount(left); setError(null); } }, [payment, left]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!payment) return;
    if (!MONEY.test(amount) || Number(amount) <= 0) return setError("Enter the amount given back.");
    setSaving(true); setError(null);
    try {
      const v = await apiFetch<SubscriptionView>(`/admin/payments/${payment.id}/refund`, { method: "POST", body: { amount } });
      toast.success(`Refund of ${formatINR(amount)} recorded.`);
      onSaved(v);
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }
  return (
    <Modal open={payment !== null} onClose={saving ? () => {} : onClose} size="sm" title="Record a refund"
      description={payment ? `Money given back on ${payment.invoice_number}. Up to ${formatINR(left)}.` : undefined}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="refund-form" loading={saving} data-testid="save-refund">Record refund</Button></>}>
      <form id="refund-form" onSubmit={save} className="space-y-4" noValidate>
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
        <TextField label="Amount (₹)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} data-testid="refund-amount"
          hint="The invoice is no longer paid by this much; the school's status follows." />
      </form>
    </Modal>
  );
}

export function ReasonModal({ open, title, message, label, testId, onClose, onSubmit }: {
  open: boolean; title: string; message: string; label: string; testId: string; onClose: () => void; onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setReason(""); setError(null); } }, [open]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) return setError("Give a short reason.");
    setSaving(true);
    try { await onSubmit(reason.trim()); } finally { setSaving(false); }
  }
  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} size="sm" title={title} description={message}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Back</Button>
        <Button type="submit" form={`${testId}-form`} variant="danger" loading={saving} data-testid={`${testId}-confirm`}>Confirm</Button></>}>
      <form id={`${testId}-form`} onSubmit={submit} className="space-y-3" noValidate>
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
        <TextField label={label} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid={`${testId}-reason`} />
      </form>
    </Modal>
  );
}
