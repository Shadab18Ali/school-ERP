"use client";

import { CreditCard, UserPlus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { EntitlementList, InvoiceTable, PaymentsTable, StatusSummary, UsageView, useInvoicePdf } from "@/components/platform/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { loadCheckout, openCheckout } from "@/lib/payments";
import type { Invoice, SchoolBilling } from "@/lib/platform";
import { useAuth } from "@/providers/auth-provider";

function Card({ title, description, action, children, testId }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="mb-6 rounded-lg border border-line bg-white" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div><h2 className="font-semibold">{title}</h2>{description && <p className="text-xs text-muted">{description}</p>}</div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** The school's plan, where its subscription stands, its invoices (paid online or by bank transfer), and its usage. */
export function PlanAndBillingCard({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const { refresh } = useAuth();
  const [d, setD] = useState<SchoolBilling | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [cancel, setCancel] = useState<"at_period_end" | "resume" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { download } = useInvoicePdf();
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch<SchoolBilling>("/school/billing", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function pay(inv: Invoice) {
    setPaying(inv.id);
    try {
      const o = await apiFetch<{ key_id: string; order_id: string; amount: number; currency: "INR"; name: string; description: string; prefill: { name: string; email: string } }>(
        `/school/billing/invoices/${inv.id}/pay`, { method: "POST", schoolId });
      await loadCheckout();
      const r = await openCheckout({ online_payment_id: "", key_id: o.key_id, order_id: o.order_id, amount: "", amount_paise: o.amount, currency: o.currency,
        name: o.name, description: o.description, prefill: { ...o.prefill, contact: "" } });
      if (r.kind === "success") {
        const v = await apiFetch<SchoolBilling & { outcome: string }>("/school/billing/payments/verify", { method: "POST", schoolId, body: r.data });
        setD(v);
        if (v.outcome === "paid") toast.success(`Payment received for ${inv.invoice_number}. Thank you.`);
        else if (v.outcome === "failed") toast.error("The payment didn't go through. No money was taken, or your bank will return it.");
        else toast.success("Payment received by Razorpay; it will show here as soon as it is confirmed.");
        await refresh();   // the school's access may have changed
      } else if (r.kind === "failed") {
        toast.error(r.data.error.description ?? "The payment didn't go through.");
      }
    } catch (e) { toast.error(errorMessage(e)); } finally { setPaying(null); }
  }

  async function doCancel() {
    if (!cancel) return;
    setBusy(true);
    try {
      setD(await apiFetch<SchoolBilling>("/school/billing/cancel", { method: "POST", schoolId, body: { mode: cancel, reason: reason.trim() || null } }));
      toast.success(cancel === "resume" ? "Your subscription continues." : "Your subscription will end at the end of the period. It won't renew.");
      setCancel(null); setReason("");
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }

  const st = d?.status;
  const canCancel = st && ["trialing", "active", "grace"].includes(st.status) && !st.cancel_at_period_end;
  return (
    <Card title="Plan and billing" testId="plan-card"
      description="Your school's subscription with the platform. To change plan, contact the platform's team."
      action={st && (st.cancel_at_period_end && st.status === "cancelling"
        ? <Button size="sm" variant="secondary" onClick={() => setCancel("resume")} data-testid="school-resume">Keep subscription</Button>
        : canCancel ? <Button size="sm" variant="secondary" onClick={() => setCancel("at_period_end")} data-testid="school-cancel">Cancel subscription</Button> : null)}>
      {error ? <ErrorState message={error} onRetry={load} /> : !d ? <LoadingState /> : <>
        {d.subscription ? <>
          <StatusSummary status={d.status} sub={d.subscription} />
          <h3 className="mb-2 mt-6 text-sm font-semibold">Your plan includes</h3>
          <EntitlementList rows={d.entitlements} />
          <h3 className="mb-2 mt-6 text-sm font-semibold">Invoices</h3>
          <div className="-mx-5 border-y border-line">
            <InvoiceTable invoices={d.invoices} pdf={(i) => download(`/school/billing/invoices/${i.id}/pdf`, i.id, i.invoice_number, schoolId)}
              actions={(i) => ["open", "overdue", "partly_paid"].includes(i.state) && (d.online_payments
                ? <Button size="sm" onClick={() => pay(i)} loading={paying === i.id} disabled={paying !== null} data-testid="pay-invoice">
                    Pay {formatINR((Number(i.total) - Number(i.paid)).toFixed(2))}</Button>
                : <span className="text-xs text-muted">Pay by bank transfer; the platform records it</span>)} />
          </div>
          {d.payments.length > 0 && <>
            <h3 className="mb-2 mt-6 text-sm font-semibold">Payments</h3>
            <div className="-mx-5 border-y border-line"><PaymentsTable payments={d.payments} /></div>
          </>}
        </> : (
          <EmptyState icon={CreditCard} title="No plan recorded yet" message="The platform's team hasn't recorded a plan for your school yet. Nothing is limited until they do." />
        )}
        <h3 className="mb-2 mt-6 text-sm font-semibold">Usage</h3>
        <UsageView usage={d.usage} />
      </>}
      <ConfirmDialog open={cancel !== null}
        title={cancel === "resume" ? "Keep your subscription?" : "Cancel your subscription?"}
        message={cancel === "resume" ? "It will renew as usual." : <>
          <span className="block">Nothing more will be billed. Everything keeps working until {st?.on_trial ? "your trial" : "the period you've paid for"} ends; after that the school becomes read-only (your records stay and can be downloaded).</span>
          <span className="mt-3 block"><TextField label="Why are you leaving? (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} data-testid="school-cancel-reason" /></span>
        </>}
        confirmLabel={cancel === "resume" ? "Keep it" : "Cancel at period end"} tone={cancel === "resume" ? "primary" : "danger"}
        loading={busy} onConfirm={doCancel} onCancel={() => { setCancel(null); setReason(""); }} />
    </Card>
  );
}

interface StaffAccount { user_id: string; role: string; status: string; full_name: string; email: string; created_at: string; managed_here: boolean; managed_by: string }
const ROLE_LABEL: Record<string, string> = { school_admin: "Administrator", accountant: "Accountant", teacher: "Teacher", librarian: "Library duty" };

/** Staff sign-ins: accountants are added and turned off here; the rest says where it's managed. */
export function StaffAccountsCard({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<StaffAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<StaffAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setRows(await apiFetch<StaffAccount[]>("/school/staff-accounts", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function toggle(a: StaffAccount) {
    setBusy(true);
    try {
      await apiFetch(`/school/staff-accounts/accountants/${a.user_id}`, { method: "PATCH", schoolId, body: { status: a.status === "active" ? "disabled" : "active" } });
      toast.success(a.status === "active" ? `${a.full_name} can no longer sign in as an accountant.` : `${a.full_name} can sign in again.`);
      setConfirm(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Card title="Staff sign-ins" testId="staff-accounts"
      description="Who can sign in to run the school. Administrators are added by the platform; teachers get theirs on their teacher record."
      action={<Button size="sm" variant="secondary" onClick={() => setAdding(true)} data-testid="add-accountant"><UserPlus className="size-4" /> Add accountant</Button>}>
      {error ? <ErrorState message={error} onRetry={load} /> : !rows ? <LoadingState /> : (
        <ul className="divide-y divide-line" data-testid="staff-list">
          {rows.map((a) => (
            <li key={`${a.user_id}-${a.role}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0" data-testid="staff-row">
              <div>
                <p className="text-sm font-medium">{a.full_name} <span className="font-normal text-muted">· {ROLE_LABEL[a.role] ?? a.role}</span></p>
                <p className="text-xs text-muted">{a.email} · {a.status === "active" ? `since ${formatDate(a.created_at)}` : "turned off"}</p>
              </div>
              {a.managed_here ? (
                <Button size="sm" variant="secondary" onClick={() => setConfirm(a)} data-testid="toggle-accountant">{a.status === "active" ? "Turn off" : "Turn on"}</Button>
              ) : a.managed_by === "teacher_record" ? (
                <Link href="/teachers" className="text-xs text-leaf-700 hover:underline">On the teacher&apos;s record</Link>
              ) : <span className="text-xs text-muted">Managed by the platform</span>}
            </li>
          ))}
        </ul>
      )}
      <AddAccountantModal open={adding} schoolId={schoolId} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />
      <ConfirmDialog open={confirm !== null} title={confirm?.status === "active" ? "Turn off this sign-in?" : "Turn this sign-in back on?"}
        message={confirm?.status === "active" ? `${confirm.full_name} will no longer be able to sign in to this school as an accountant.` : `${confirm?.full_name} will be able to sign in as an accountant again.`}
        confirmLabel={confirm?.status === "active" ? "Turn off" : "Turn on"} tone={confirm?.status === "active" ? "danger" : "primary"}
        loading={busy} onConfirm={() => confirm && toggle(confirm)} onCancel={() => setConfirm(null)} />
    </Card>
  );
}

function AddAccountantModal({ open, schoolId, onClose, onAdded }: { open: boolean; schoolId: string; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setName(""); setEmail(""); setError(null); } }, [open]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError("Enter their name.");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError("Enter a valid email.");
    setSaving(true); setError(null);
    try {
      const r = await apiFetch<{ invited: boolean }>("/school/staff-accounts/accountants", { method: "POST", schoolId, body: { email: email.trim(), full_name: name.trim() } });
      toast.success(r.invited ? `Invitation sent to ${email.trim()}.` : `${email.trim()} already had a sign-in and is now an accountant here.`);
      onAdded();
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }
  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} size="sm" title="Add an accountant" description="They can collect fees, issue receipts and see fee reports and analytics."
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="acct-form" loading={saving} data-testid="send-accountant">Add</Button></>}>
      <form id="acct-form" onSubmit={submit} className="space-y-4" noValidate>
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="accountant-error">{error}</p>}
        <TextField label="Full name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} data-testid="accountant-name" />
        <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="New emails get an invitation to set a password." data-testid="accountant-email" />
      </form>
    </Modal>
  );
}
