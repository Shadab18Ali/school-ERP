"use client";

import { clsx } from "clsx";
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock3, Download, MinusCircle, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatINR } from "@/lib/money";
import {
  CYCLE_LABEL, formatBytes, INVOICE_LABEL, INVOICE_TONE, limitText, METHOD_LABEL, STATUS_LABEL, STATUS_TONE,
  type EntitlementRow, type Invoice, type InvoiceState, type StatusInfo, type SubPayment, type SubscriptionFacts, type SubStatus, type Usage,
} from "@/lib/platform";

const TONE = {
  good: { cls: "bg-leaf-50 text-leaf-700", icon: CheckCircle2 },
  warning: { cls: "bg-pencil-100 text-ink", icon: Clock3 },
  serious: { cls: "bg-danger-50 text-danger-600", icon: AlertTriangle },
  neutral: { cls: "bg-paper text-muted border border-line", icon: CircleDashed },
};

function Badge({ tone, label, icon, testId }: { tone: keyof typeof TONE; label: string; icon?: typeof CheckCircle2; testId?: string }) {
  const t = TONE[tone];
  const Icon = icon ?? t.icon;
  return (
    <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", t.cls)} data-testid={testId}>
      <Icon className="size-3.5" aria-hidden /> {label}
    </span>
  );
}

/** Where a subscription stands: icon + words, never colour alone. */
export function StateBadge({ state, testId }: { state: SubStatus | null | undefined; testId?: string }) {
  if (!state || state === "none") return <Badge tone="neutral" label="No plan" icon={XCircle} testId={testId} />;
  return <Badge tone={STATUS_TONE[state]} label={STATUS_LABEL[state]} icon={state === "cancelled" ? Ban : undefined} testId={testId} />;
}

export function InvoiceBadge({ state, testId }: { state: InvoiceState; testId?: string }) {
  return <Badge tone={INVOICE_TONE[state]} label={INVOICE_LABEL[state]} icon={state === "void" ? MinusCircle : undefined} testId={testId} />;
}

export function Figure({ label, value, hint, testId, warn }: { label: string; value: ReactNode; hint?: ReactNode; testId?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-white p-4" data-testid={testId}>
      <p className="flex items-center gap-1 text-xs font-medium text-muted">
        {warn && <AlertTriangle className="size-3.5 text-danger-600" aria-hidden />}{label}
      </p>
      <p className={clsx("mt-1 text-xl font-semibold tabular-nums tracking-tight", warn && "text-danger-600")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** A count against a plan's limit, with a thin bar. */
function Meter({ label, used, usedText, limit, limitLabel, testId }: {
  label: string; used: number; usedText?: string; limit: number | null | undefined; limitLabel?: string; testId?: string;
}) {
  const over = limit != null && used > limit;
  const pct = limit ? Math.min(100, Math.round((100 * used) / limit)) : limit === 0 ? 100 : null;
  return (
    <div className="rounded-lg border border-line bg-white p-4" data-testid={testId}>
      <p className="flex items-center gap-1 text-xs font-medium text-muted">
        {over && <AlertTriangle className="size-3.5 text-danger-600" aria-hidden />}{label}
      </p>
      <p className={clsx("mt-1 text-xl font-semibold tabular-nums", over && "text-danger-600")}>
        {usedText ?? used.toLocaleString("en-IN")}
        <span className="text-sm font-normal text-muted"> {limit != null ? `of ${limitLabel ?? limit.toLocaleString("en-IN")}` : "· no limit"}</span>
      </p>
      {pct !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper" role="img" aria-label={`${pct}% of the limit`}>
          <div className={clsx("h-full rounded-full", over ? "bg-danger-600" : "bg-leaf-600")} style={{ width: `${pct}%` }} />
        </div>
      )}
      {over && <p className="mt-1 text-xs text-danger-600">Over the plan&apos;s limit: nothing new can be added until it is back within it</p>}
    </div>
  );
}

export function UsageView({ usage }: { usage: Usage }) {
  const p = usage.people;
  const l = usage.last_30_days;
  const e = usage.entitlements;
  const storageLimit = e?.storage_mb?.limit;
  return (
    <div className="space-y-4" data-testid="usage">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Meter label="Active students" used={usage.students.active} limit={e?.students?.limit} testId="usage-students" />
        <Meter label="Active teachers" used={usage.teachers} limit={e?.teachers?.limit} testId="usage-teachers" />
        <Meter label="Files stored" used={usage.storage_bytes ?? 0} usedText={formatBytes(usage.storage_bytes)}
          limit={storageLimit == null ? storageLimit : storageLimit * 1048576} limitLabel={e?.storage_mb ? limitText(e.storage_mb) : undefined} testId="usage-storage" />
        <Figure label="Classes · sections" value={`${usage.classes} · ${usage.sections}`} hint={usage.session ? `Sections in ${usage.session.name}` : "No current session"} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">Sign-ins by role</h3>
          <dl className="grid grid-cols-3 gap-3 text-sm" data-testid="usage-roles">
            {([["Admins", p.school_admins], ["Accountants", p.accountants], ["Teachers", p.teachers], ["Librarians", p.librarians],
              ["Parents", p.parents], ["Students", p.students]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="font-medium tabular-nums">{v.toLocaleString("en-IN")}</dd></div>
            ))}
          </dl>
        </section>
        <section className="rounded-lg border border-line bg-white p-4">
          <h3 className="mb-2 text-sm font-semibold">Last 30 days</h3>
          <dl className="grid grid-cols-3 gap-3 text-sm" data-testid="usage-activity">
            <div><dt className="text-xs text-muted">Attendance days</dt><dd className="font-medium tabular-nums">{l.attendance_days}</dd></div>
            <div><dt className="text-xs text-muted">Receipts</dt><dd className="font-medium tabular-nums">{l.receipts.toLocaleString("en-IN")}</dd></div>
            <div><dt className="text-xs text-muted">Fees collected</dt><dd className="font-medium tabular-nums">{formatINR(String(l.collected))}</dd></div>
            <div><dt className="text-xs text-muted">Notifications</dt><dd className="font-medium tabular-nums">{l.notifications.toLocaleString("en-IN")}</dd></div>
            <div><dt className="text-xs text-muted">WhatsApp sent</dt><dd className="font-medium tabular-nums">{l.whatsapp_sent.toLocaleString("en-IN")}</dd></div>
            <div><dt className="text-xs text-muted">Last activity</dt><dd className="font-medium">{usage.last_activity_at ? formatDate(usage.last_activity_at) : "—"}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}

/** What the plan includes: limits as numbers, features on or off (and which modules aren't built yet). */
export function EntitlementList({ rows }: { rows: EntitlementRow[] }) {
  return (
    <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2" data-testid="entitlements">
      {rows.map((r) => (
        <li key={r.key} className="flex items-start gap-2" data-testid={`ent-${r.key}`}>
          {r.kind === "limit" || r.included
            ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-leaf-600" aria-hidden />
            : <XCircle className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}
          <span className={clsx(r.kind === "feature" && !r.included && "text-muted")}>
            {r.label}
            {r.kind === "limit" ? <>: <span className="font-medium">{limitText(r)}</span></> : r.included ? "" : " — not included"}
            {r.kind === "feature" && r.included && !r.available && <span className="text-xs text-muted"> (coming later)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One line on what the status means, from the facts the database worked out. */
export function statusSentence(s: StatusInfo): string {
  const d = (x?: string | null) => (x ? formatDate(x) : "—");
  switch (s.status) {
    case "none": return "No subscription is recorded.";
    case "trialing": return `Free trial until ${d(s.trial_ends_at)}.${s.paid_through ? ` Paid up to ${d(s.paid_through)}.` : ""}`;
    case "active": return `Paid up to ${d(s.paid_through)}.`;
    case "cancelling": return `Set to end on ${d(s.on_trial ? s.trial_ends_at : s.paid_through)}. It won't renew.`;
    case "grace": return `Payment due. Everything keeps working until ${d(s.grace_until)}; after that the school becomes read-only.`;
    case "expired": return `Expired${s.grace_until ? ` on ${d(s.grace_until)}` : ""}. The school is read-only until a renewal is paid.`;
    case "cancelled": return "Cancelled. The school is read-only.";
  }
}

export function StatusSummary({ status, sub, extra }: { status: StatusInfo; sub: SubscriptionFacts; extra?: ReactNode }) {
  const per = sub.billing_cycle === "yearly" ? "year" : "month";
  const price = sub.agreed_price ?? sub.plan_price;
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_auto]" data-testid="plan-summary">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-lg font-semibold" data-testid="plan-name">{sub.plan_name}</p>
          <StateBadge state={status.status} testId="plan-state" />
        </div>
        <p className="mt-0.5 text-sm text-muted">
          <span data-testid="plan-price">{formatINR(price)}</span> a {per} + tax · {CYCLE_LABEL[sub.billing_cycle]} billing
          {sub.agreed_price && sub.agreed_price !== sub.plan_price && <> · agreed price (plan: {formatINR(sub.plan_price)})</>}
        </p>
        <p className="mt-2 text-sm" data-testid="status-sentence">{statusSentence(status)}</p>
        {extra}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:min-w-72">
        <div><dt className="text-xs text-muted">Started</dt><dd>{formatDate(sub.started_on)}</dd></div>
        {sub.trial_ends_at && <div><dt className="text-xs text-muted">Trial {status.on_trial ? "ends" : "ended"}</dt><dd data-testid="trial-ends">{formatDate(sub.trial_ends_at)}</dd></div>}
        <div><dt className="text-xs text-muted">Paid up to</dt><dd data-testid="paid-through">{status.paid_through ? formatDate(status.paid_through) : "—"}</dd></div>
        <div><dt className="text-xs text-muted">Balance due</dt><dd className="tabular-nums" data-testid="balance-due">{formatINR(String(status.balance_due ?? 0))}</dd></div>
        <div><dt className="text-xs text-muted">Grace after a missed renewal</dt><dd>{sub.grace_period_days} {sub.grace_period_days === 1 ? "day" : "days"}</dd></div>
        {sub.billing_gstin && <div><dt className="text-xs text-muted">GSTIN on invoices</dt><dd>{sub.billing_gstin}</dd></div>}
      </dl>
    </div>
  );
}

export function useInvoicePdf() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function download(path: string, id: string, number: string, schoolId?: string) {
    setBusy(id);
    try {
      const { blob, filename } = await apiFetchBlob(path, schoolId ? { schoolId } : {});
      saveBlob(blob, filename ?? `${number.replaceAll("/", "-")}.pdf`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  return { busy, download };
}

export function InvoiceTable({ invoices, actions, pdf }: {
  invoices: Invoice[]; actions?: (i: Invoice) => ReactNode; pdf: (i: Invoice) => void;
}) {
  if (invoices.length === 0) return <p className="px-5 py-4 text-sm text-muted">No invoices yet.</p>;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm" data-testid="invoice-table">
        <thead className="bg-paper text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Invoice</th><th className="px-4 py-2 font-medium">Period</th>
            <th className="px-4 py-2 text-right font-medium">Total</th><th className="px-4 py-2 text-right font-medium">Paid</th>
            <th className="px-4 py-2 font-medium">Due</th><th className="px-4 py-2 font-medium">State</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {invoices.map((i) => (
            <tr key={i.id} data-testid="invoice-row" data-number={i.invoice_number}>
              <td className="whitespace-nowrap px-4 py-2"><span className="font-medium">{i.invoice_number}</span>
                <span className="block text-xs text-muted">{i.plan_name} · {CYCLE_LABEL[i.billing_cycle]}{i.kind === "imported" ? " · recorded earlier" : ""}</span></td>
              <td className="whitespace-nowrap px-4 py-2">{formatDate(i.period_start)} – {formatDate(i.period_end)}</td>
              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatINR(i.total)}
                {Number(i.tax_amount) > 0 && <span className="block text-xs text-muted">incl. {formatINR(i.tax_amount)} tax</span>}</td>
              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums" data-testid="invoice-paid">{formatINR(i.paid)}</td>
              <td className="whitespace-nowrap px-4 py-2">{formatDate(i.due_on)}</td>
              <td className="px-4 py-2"><InvoiceBadge state={i.state} testId="invoice-state" />
                {i.void_reason && <span className="block text-xs text-muted">{i.void_reason}</span>}</td>
              <td className="px-4 py-2">
                <div className="flex flex-wrap justify-end gap-2">
                  {actions?.(i)}
                  <Button size="sm" variant="secondary" onClick={() => pdf(i)} aria-label={`Download ${i.invoice_number} as PDF`} data-testid="invoice-pdf">
                    <Download className="size-4" /> PDF
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PaymentsTable({ payments, actions }: { payments: SubPayment[]; actions?: (p: SubPayment) => ReactNode }) {
  if (payments.length === 0) return <p className="px-5 py-4 text-sm text-muted">No payments yet.</p>;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm" data-testid="payment-table">
        <thead className="bg-paper text-left text-xs text-muted">
          <tr><th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Invoice</th><th className="px-4 py-2 font-medium">Method</th>
            <th className="px-4 py-2 font-medium">Reference</th><th className="px-4 py-2 text-right font-medium">Amount</th>{actions && <th className="px-4 py-2"><span className="sr-only">Actions</span></th>}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {payments.map((p) => (
            <tr key={p.id} data-testid="payment-row">
              <td className="whitespace-nowrap px-4 py-2">{formatDate(p.paid_on)}</td>
              <td className="whitespace-nowrap px-4 py-2">{p.invoice_number}</td>
              <td className="px-4 py-2">{METHOD_LABEL[p.method]}{p.method_detail && <span className="block text-xs text-muted">{p.method_detail}</span>}</td>
              <td className="px-4 py-2 text-muted">{p.reference ?? p.gateway_payment_id ?? "—"}</td>
              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatINR(p.amount)}
                {Number(p.refunded_amount) > 0 && <span className="block text-xs text-danger-600" data-testid="payment-refunded">{formatINR(p.refunded_amount)} refunded</span>}</td>
              {actions && <td className="px-4 py-2 text-right">{actions(p)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
