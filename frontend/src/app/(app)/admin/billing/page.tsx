"use client";

import { CheckCircle2, PlayCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { config } from "@/lib/config";
import { formatDateTime } from "@/lib/format";
import type { BillingSettings, BillingSettingsView, WebhookEvent } from "@/lib/platform";

const EMPTY: Record<keyof Omit<BillingSettings, "updated_at">, string> = {
  legal_name: "", gstin: "", address: "", state: "", email: "", phone: "", invoice_prefix: "", tax_label: "", tax_rate: "", renewal_lead_days: "", payment_due_days: "",
};

function SettingsForm({ view, onSaved }: { view: BillingSettingsView; onSaved: (v: BillingSettingsView) => void }) {
  const toast = useToast();
  const [f, setF] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const s = view.settings;
    setF(s ? Object.fromEntries(Object.keys(EMPTY).map((k) => [k, String(s[k as keyof BillingSettings] ?? "")])) as typeof EMPTY : EMPTY);
  }, [view]);
  const set = (k: keyof typeof EMPTY, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (f.legal_name.trim().length < 2 || f.address.trim().length < 3 || f.state.trim().length < 2) return setError("Enter the legal name, address and state printed on invoices.");
    if (f.gstin && !/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(f.gstin)) return setError("The GSTIN should be 15 characters, e.g. 07ABCDE1234F1Z5.");
    if (!/^[A-Z0-9-]{1,10}$/.test(f.invoice_prefix)) return setError("The invoice prefix is 1–10 capital letters, numbers or hyphens, e.g. INV.");
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(f.tax_rate) || Number(f.tax_rate) > 100) return setError("Enter the tax rate in percent, e.g. 18.");
    if (!/^\d{1,2}$/.test(f.renewal_lead_days) || Number(f.renewal_lead_days) > 60) return setError("Renewal invoices: 0 to 60 days ahead.");
    if (!/^\d{1,2}$/.test(f.payment_due_days) || Number(f.payment_due_days) > 90) return setError("Days to pay a first invoice: 0 to 90.");
    setSaving(true); setError(null);
    try {
      const v = await apiFetch<BillingSettingsView>("/admin/billing/settings", { method: "PUT", body: {
        ...f, gstin: f.gstin || null, email: f.email || null, phone: f.phone || null, tax_label: f.tax_label.trim(),
        renewal_lead_days: Number(f.renewal_lead_days), payment_due_days: Number(f.payment_due_days),
      } });
      toast.success("Billing details saved. New invoices use them.");
      onSaved(v);
    } catch (err) { setError(errorMessage(err)); } finally { setSaving(false); }
  }

  return (
    <form onSubmit={save} className="grid gap-4 p-5 sm:grid-cols-2" noValidate data-testid="billing-settings-form">
      {!view.settings && <p className="rounded-md bg-pencil-100 px-3 py-2 text-sm sm:col-span-2" role="status">No invoice can be issued until these details are entered.</p>}
      {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="billing-error">{error}</p>}
      <TextField label="Legal name (seller on invoices)" value={f.legal_name} maxLength={200} onChange={(e) => set("legal_name", e.target.value)} data-testid="bs-legal-name" />
      <TextField label="GSTIN (optional)" value={f.gstin} maxLength={15} onChange={(e) => set("gstin", e.target.value.toUpperCase().trim())} data-testid="bs-gstin" />
      <div className="sm:col-span-2"><TextField label="Address" value={f.address} maxLength={500} onChange={(e) => set("address", e.target.value)} data-testid="bs-address" /></div>
      <TextField label="State" value={f.state} maxLength={100} onChange={(e) => set("state", e.target.value)} data-testid="bs-state"
        hint="Schools in this state are charged CGST + SGST; others IGST" />
      <TextField label="Billing email (optional)" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
      <TextField label="Invoice number prefix" value={f.invoice_prefix} maxLength={10} onChange={(e) => set("invoice_prefix", e.target.value.toUpperCase().trim())}
        hint="Numbers run PREFIX/2026-27/00001 within each financial year" data-testid="bs-prefix" />
      <TextField label="Phone (optional)" value={f.phone} maxLength={20} onChange={(e) => set("phone", e.target.value)} />
      <TextField label="Tax name" value={f.tax_label} maxLength={20} onChange={(e) => set("tax_label", e.target.value)} hint="e.g. GST" data-testid="bs-tax-label" />
      <TextField label="Tax rate (%)" inputMode="decimal" value={f.tax_rate} onChange={(e) => set("tax_rate", e.target.value.trim())} hint="0 if you don't charge tax" data-testid="bs-tax-rate" />
      <TextField label="Issue renewal invoices (days ahead)" inputMode="numeric" value={f.renewal_lead_days} onChange={(e) => set("renewal_lead_days", e.target.value.trim())}
        hint="A renewal is due on the day the new period starts" data-testid="bs-lead" />
      <TextField label="Days to pay a first invoice" inputMode="numeric" value={f.payment_due_days} onChange={(e) => set("payment_due_days", e.target.value.trim())}
        hint="A school isn't cut off before its first invoice falls due" data-testid="bs-due" />
      <div className="sm:col-span-2"><Button type="submit" loading={saving} data-testid="save-billing-settings">Save billing details</Button></div>
    </form>
  );
}

function BillingView() {
  const toast = useToast();
  const [view, setView] = useState<BillingSettingsView | null>(null);
  const [events, setEvents] = useState<WebhookEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, ev] = await Promise.all([apiFetch<BillingSettingsView>("/admin/billing/settings"), apiFetch<WebhookEvent[]>("/admin/billing/webhook-events")]);
      setView(v); setEvents(ev);
    } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run() {
    setRunning(true);
    try {
      const r = await apiFetch<{ invoices_issued: number }>("/admin/billing/run", { method: "POST" });
      toast.success(r.invoices_issued === 0 ? "No renewal is due right now." : `${r.invoices_issued} renewal ${r.invoices_issued === 1 ? "invoice" : "invoices"} issued.`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setRunning(false); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!view || !events) return <LoadingState />;
  const op = view.online_payments;
  return (
    <>
      <PageHeader title="Billing setup" description="The platform as the seller: what is printed on invoices, tax, when renewals are issued, and online payment."
        actions={<Button variant="secondary" onClick={run} loading={running} data-testid="run-billing"><PlayCircle className="size-4" /> Issue due renewals now</Button>} />
      <section className="mb-6 rounded-lg border border-line bg-white">
        <h2 className="border-b border-line px-5 py-3.5 font-semibold">Invoice details</h2>
        <SettingsForm view={view} onSaved={setView} />
      </section>
      <section className="mb-6 rounded-lg border border-line bg-white" data-testid="online-payments-status">
        <h2 className="border-b border-line px-5 py-3.5 font-semibold">Online payment (the platform&apos;s Razorpay account)</h2>
        <div className="space-y-2 p-5 text-sm">
          <p className="flex items-center gap-2">
            {op.enabled ? <CheckCircle2 className="size-4 text-leaf-600" aria-hidden /> : <XCircle className="size-4 text-danger-600" aria-hidden />}
            {op.enabled ? <>Schools can pay invoices online (key <code className="rounded bg-paper px-1">{op.key_id}</code>).</>
              : "Not set up: schools pay by bank transfer and you record it."}
          </p>
          <p className="flex items-center gap-2">
            {op.webhook_secret_set ? <CheckCircle2 className="size-4 text-leaf-600" aria-hidden /> : <XCircle className="size-4 text-danger-600" aria-hidden />}
            {op.webhook_secret_set ? "Webhook secret set: Razorpay's notices are accepted." : "No webhook secret: Razorpay's notices are refused."}
          </p>
          <p className="text-muted">
            The keys and webhook secret are set on the API server (PLATFORM_RAZORPAY_KEY_ID, PLATFORM_RAZORPAY_KEY_SECRET, PLATFORM_RAZORPAY_WEBHOOK_SECRET) and never reach a browser.
            In the Razorpay dashboard, point a webhook at <code className="break-all rounded bg-paper px-1">{config.apiUrl}{op.webhook_path}</code> with
            the events payment.captured, payment.failed, order.paid and refund.processed. Online payments are refunded in the Razorpay dashboard; the refund is recorded here when Razorpay reports it.
          </p>
        </div>
      </section>
      <section className="rounded-lg border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="font-semibold">Razorpay notices received</h2>
          <Button size="sm" variant="secondary" onClick={load}>Refresh</Button>
        </div>
        {events.length === 0 ? <p className="px-5 py-4 text-sm text-muted">None yet.</p> : (
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm" data-testid="webhook-events">
              <thead className="bg-paper text-left text-xs text-muted">
                <tr><th className="px-4 py-2 font-medium">Received</th><th className="px-4 py-2 font-medium">Event</th><th className="px-4 py-2 font-medium">Order / payment</th>
                  <th className="px-4 py-2 font-medium">Outcome</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.map((e) => (
                  <tr key={e.id} data-testid="webhook-event">
                    <td className="whitespace-nowrap px-4 py-2">{formatDateTime(e.received_at)}</td>
                    <td className="px-4 py-2">{e.kind}</td>
                    <td className="px-4 py-2 text-xs text-muted">{e.order_id ?? "—"}<span className="block">{e.payment_id ?? ""}</span></td>
                    <td className="px-4 py-2">{e.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-5 py-3 text-xs text-muted">Each notice is handled once, however many times Razorpay sends it. See every invoice under <Link className="text-leaf-700 hover:underline" href="/admin/invoices">Invoices</Link>.</p>
      </section>
    </>
  );
}

export default function BillingPage() {
  return <RequirePermission permission="platform:schools.manage"><BillingView /></RequirePermission>;
}
