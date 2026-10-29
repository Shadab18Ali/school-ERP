"use client";

import { Download, ReceiptText } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Figure, InvoiceBadge, useInvoicePdf } from "@/components/platform/shared";
import { PaymentModal, ReasonModal } from "@/components/platform/subscription-panel";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatINR } from "@/lib/money";
import type { PlatformInvoice } from "@/lib/platform";

interface InvoiceList { items: PlatformInvoice[]; total: number; page: number; page_size: number; totals: { invoiced: string; received: string } }
const FILTERS = [["", "All invoices"], ["unpaid", "Unpaid"], ["overdue", "Overdue"], ["partly_paid", "Part paid"], ["paid", "Paid"], ["void", "Cancelled"]] as const;
const PAGE = 25;

function InvoicesView() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const state = params.get("state") ?? "";
  const [page, setPage] = useState(1);
  const [d, setD] = useState<InvoiceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<PlatformInvoice | null>(null);
  const [voiding, setVoiding] = useState<PlatformInvoice | null>(null);
  const { busy, download } = useInvoicePdf();
  const load = useCallback(async () => {
    setError(null);
    const q = new URLSearchParams({ page: String(page), page_size: String(PAGE), ...(state ? { state } : {}) });
    try { setD(await apiFetch<InvoiceList>(`/admin/invoices?${q}`)); } catch (e) { setError(errorMessage(e)); }
  }, [page, state]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => setPage(1), [state]);

  const pages = d ? Math.max(1, Math.ceil(d.total / PAGE)) : 1;
  return (
    <>
      <PageHeader title="Invoices" description="Every subscription invoice the platform has issued. Amounts are as invoiced, tax included."
        actions={<SelectField label="Show" value={state} onChange={(e) => router.replace(e.target.value ? `/admin/invoices?state=${e.target.value}` : "/admin/invoices")} data-testid="invoice-filter">
          {FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectField>} />
      {error ? <ErrorState message={error} onRetry={load} /> : !d ? <LoadingState /> : <>
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Figure label="Invoiced" value={formatINR(d.totals.invoiced)} hint={`${d.total} ${d.total === 1 ? "invoice" : "invoices"} (cancelled ones excluded)`} testId="inv-total-invoiced" />
          <Figure label="Received" value={formatINR(d.totals.received)} hint="less refunds" testId="inv-total-received" />
          <Figure label="Still due" value={formatINR((Number(d.totals.invoiced) - Number(d.totals.received)).toFixed(2))} testId="inv-total-due" />
        </div>
        <section className="rounded-lg border border-line bg-white">
          {d.items.length === 0 ? <EmptyState icon={ReceiptText} title="No invoices" message={state ? "None match this filter." : "Invoices appear here when subscriptions are started or renewed."} /> : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm" data-testid="platform-invoices">
                <thead className="bg-paper text-left text-xs text-muted">
                  <tr><th className="px-4 py-2 font-medium">Invoice</th><th className="px-4 py-2 font-medium">School</th><th className="px-4 py-2 font-medium">Period</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th><th className="px-4 py-2 text-right font-medium">Paid</th><th className="px-4 py-2 font-medium">Due</th>
                    <th className="px-4 py-2 font-medium">State</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.items.map((i) => (
                    <tr key={i.id} data-testid="platform-invoice-row">
                      <td className="whitespace-nowrap px-4 py-2 font-medium">{i.invoice_number}<span className="block text-xs font-normal text-muted">{i.plan_name}</span></td>
                      <td className="px-4 py-2"><Link className="hover:underline" href={`/admin/schools/${i.school_id}?tab=subscription`}>{i.school_name}</Link></td>
                      <td className="whitespace-nowrap px-4 py-2">{formatDate(i.period_start)} – {formatDate(i.period_end)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatINR(i.total)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatINR(i.paid)}</td>
                      <td className="whitespace-nowrap px-4 py-2">{formatDate(i.due_on)}</td>
                      <td className="px-4 py-2"><InvoiceBadge state={i.state} /></td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-2">
                          {["open", "overdue", "partly_paid"].includes(i.state) && <Button size="sm" onClick={() => setPaying(i)} data-testid="record-payment">Record payment</Button>}
                          {i.state !== "void" && Number(i.paid) === 0 && <Button size="sm" variant="secondary" onClick={() => setVoiding(i)}>Cancel</Button>}
                          <Button size="sm" variant="secondary" loading={busy === i.id} onClick={() => download(`/admin/invoices/${i.id}/pdf`, i.id, i.invoice_number)}
                            aria-label={`Download ${i.invoice_number} as PDF`}><Download className="size-4" /> PDF</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
              <span className="text-muted">Page {page} of {pages}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </section>
      </>}
      <PaymentModal invoice={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); void load(); }} />
      <ReasonModal open={voiding !== null} title={`Cancel invoice ${voiding?.invoice_number ?? ""}?`} label="Reason" testId="void"
        message="A cancelled invoice keeps its number and stays on record; nothing is owed on it." onClose={() => setVoiding(null)}
        onSubmit={async (reason) => {
          try {
            await apiFetch(`/admin/invoices/${voiding!.id}/void`, { method: "POST", body: { reason } });
            toast.success("Invoice cancelled."); setVoiding(null); await load();
          } catch (e) { toast.error(errorMessage(e)); }
        }} />
    </>
  );
}

export default function InvoicesPage() {
  return <RequirePermission permission="platform:schools.manage"><Suspense fallback={<LoadingState />}><InvoicesView /></Suspense></RequirePermission>;
}
