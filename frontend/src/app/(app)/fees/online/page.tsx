"use client";

import { clsx } from "clsx";
import { ChevronDown, CreditCard, RefreshCw, Search, Undo2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { ReceiptActions } from "@/components/fees/receipt-actions";
import { PageHeader } from "@/components/layout/app-shell";
import { StatusPill } from "@/components/payments/pay-online";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { type OnlinePayment, type OnlineStatus, ONLINE_STATUS_LABEL } from "@/lib/payments";
import { useAuth } from "@/providers/auth-provider";

const PAGE_SIZE = 25;
const TABS: (OnlineStatus | "")[] = ["", "paid", "needs_review", "created", "failed", "refund_pending", "refunded", "refund_failed", "cancelled"];
const VIA: Record<string, string> = { checkout: "the payment window", webhook: "a Razorpay webhook", reconcile: "a check with Razorpay" };
interface ListOut { items: OnlinePayment[]; total: number; counts: Partial<Record<OnlineStatus, number>>; received: string; refunded: string }

function RefundModal({ schoolId, p, onClose, onDone }: { schoolId: string; p: OnlinePayment | null; onClose: () => void; onDone: (x: OnlinePayment) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(""); setError(null); }, [p]);
  if (!p) return null;
  async function go() {
    if (reason.trim().length < 3) return setError("Give the reason for the refund.");
    setBusy(true); setError(null);
    try { onDone(await apiFetch<OnlinePayment>(`/payments/online/${p!.id}/refund`, { schoolId, method: "POST", body: { reason: reason.trim() } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Refund ${formatINR(p.amount)}?`} description={`${p.student_name} · ${p.gateway_payment_id}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" onClick={go} loading={busy} data-testid="confirm-refund">Refund {formatINR(p.amount)}</Button></>}>
      <div className="space-y-3 text-sm">
        <p>The full amount goes back to the parent&apos;s account through Razorpay (usually 5–7 working days).</p>
        {p.receipt_number && <p className="rounded-md bg-pencil-100/60 p-3">Receipt <b>{p.receipt_number}</b> will be cancelled, and the fees it paid become due again.</p>}
        <TextField label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Paid twice by mistake" data-testid="refund-reason" />
        {error && <p className="text-danger-600" role="alert" data-testid="refund-error">{error}</p>}
      </div>
    </Modal>
  );
}

function Row({ p, schoolId, onChange, onRefund }: { p: OnlinePayment; schoolId: string; onChange: (x: OnlinePayment) => void; onRefund: (x: OnlinePayment) => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function recheck() {
    setBusy(true);
    try { const x = await apiFetch<OnlinePayment>(`/payments/online/${p.id}/reconcile`, { schoolId, method: "POST" }); onChange(x); toast.success(`Checked with Razorpay: ${ONLINE_STATUS_LABEL[x.status]}.`); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  const refundable = can("payments:refund") && ["paid", "needs_review", "refund_failed"].includes(p.status);
  return (
    <li data-testid={`online-row-${p.id}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-sm hover:bg-paper">
        <span className="min-w-0 flex-1"><span className="font-medium">{p.student_name}</span> <span className="text-muted">· {p.class_section}</span>
          <span className="block text-xs text-muted">{formatDateTime(p.created_at)}{p.method_detail ? ` · ${p.method_detail}` : ""}{p.receipt_number ? ` · ${p.receipt_number}` : ""}</span></span>
        <StatusPill status={p.status} />
        <span className="tabular w-28 text-right font-medium">{formatINR(p.amount)}</span>
        <ChevronDown className={clsx("size-4 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-line bg-paper/60 px-4 py-3 text-sm" data-testid="online-detail">
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div><dt className="inline text-muted">For: </dt><dd className="inline">{p.description}</dd></div>
            <div><dt className="inline text-muted">Razorpay order: </dt><dd className="inline font-mono text-xs">{p.gateway_order_id ?? "—"}</dd></div>
            <div><dt className="inline text-muted">Razorpay payment: </dt><dd className="inline font-mono text-xs">{p.gateway_payment_id ?? "—"}</dd></div>
            <div><dt className="inline text-muted">Confirmed by: </dt><dd className="inline">{p.verified_via ? VIA[p.verified_via] : "—"}{p.paid_at ? `, ${formatDateTime(p.paid_at)}` : ""}</dd></div>
          </dl>
          {p.failure_reason && <p className={p.status === "needs_review" ? "rounded-md bg-pencil-100 p-2" : "text-danger-600"} data-testid="online-reason">{p.failure_reason}</p>}
          {p.refunds.map((r) => (
            <p key={r.gateway_refund_id} data-testid="online-refund">Refund {formatINR(r.amount)} · <b>{r.status}</b> · {formatDate(r.created_at)} · {r.reason}
              {r.failure_reason ? ` · ${r.failure_reason}` : ""} <span className="font-mono text-xs text-muted">{r.gateway_refund_id}</span></p>
          ))}
          <div className="flex flex-wrap gap-2">
            {p.fee_payment_id && p.receipt_number && <ReceiptActions paymentId={p.fee_payment_id} receiptNumber={p.receipt_number} schoolId={schoolId} size="sm" />}
            <Link href={`/fees/collect/${p.student_id}`} className="inline-flex h-8 items-center rounded-md px-2 text-sm font-medium text-leaf-700 hover:underline">Student&apos;s fees</Link>
            {can("fees:collect") && (p.status === "created" || p.status === "failed") && (
              <Button size="sm" variant="secondary" onClick={recheck} loading={busy} data-testid="reconcile"><RefreshCw className="size-4" /> Check with Razorpay</Button>
            )}
            {refundable && <Button size="sm" variant="ghost" className="text-danger-600" onClick={() => onRefund(p)} data-testid="refund"><Undo2 className="size-4" /> Refund</Button>}
          </div>
        </div>
      )}
    </li>
  );
}

function OnlinePayments() {
  const toast = useToast();
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [status, setStatus] = useState<OnlineStatus | "">("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<ListOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<OnlinePayment | null>(null);
  const latest = useRef(0);
  useEffect(() => { const t = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setError(null);
    try {
      const r = await apiFetch<ListOut>("/payments/online/list", { schoolId, query: { status: status || undefined, search: query || undefined, date_from: from || undefined, date_to: to || undefined, page, page_size: PAGE_SIZE } });
      if (mine === latest.current) setD(r);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [schoolId, status, query, from, to, page]);
  useEffect(() => { void load(); }, [load]);
  const replace = (x: OnlinePayment) => setD((cur) => cur && { ...cur, items: cur.items.map((i) => (i.id === x.id ? x : i)) });
  const all = d ? Object.values(d.counts).reduce((a, b) => a + (b ?? 0), 0) : 0;

  return (
    <>
      <PageHeader title="Online payments" description="Fees paid by parents through Razorpay: UPI, cards and net banking." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-board-900 p-4 text-white"><p className="text-xs text-white/60">Received online</p><p className="tabular mt-1 text-2xl font-semibold" data-testid="online-received">{d ? formatINR(d.received) : "…"}</p></div>
        <div className="rounded-lg border border-line bg-white p-4"><p className="text-xs text-muted">Refunded</p><p className="tabular mt-1 text-2xl font-semibold" data-testid="online-refunded">{d ? formatINR(d.refunded) : "…"}</p></div>
        <div className="rounded-lg border border-line bg-white p-4"><p className="text-xs text-muted">Need review</p>
          <p className={clsx("tabular mt-1 text-2xl font-semibold", (d?.counts.needs_review ?? 0) > 0 && "text-danger-600")}>{d ? d.counts.needs_review ?? 0 : "…"}</p>
          <p className="text-xs text-muted">paid online for fees already paid</p></div>
      </div>
      <section className="rounded-lg border border-line bg-white">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <TextField label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          <TextField label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          <div className="relative min-w-52 flex-1">
            <TextField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Student, receipt or Razorpay id" maxLength={100} />
            <Search className="pointer-events-none absolute right-3 top-9 size-4 text-muted" aria-hidden />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3" role="tablist" aria-label="Status">
          {TABS.map((s) => (
            <button key={s || "all"} role="tab" aria-selected={status === s} data-testid={`online-tab-${s || "all"}`} onClick={() => { setStatus(s); setPage(1); }}
              className={clsx("rounded-full border px-3 py-1 text-xs font-medium", status === s ? "border-leaf-600 bg-leaf-600 text-white" : "border-line text-muted hover:text-ink")}>
              {s ? ONLINE_STATUS_LABEL[s] : "All"} <span className="tabular">({d ? (s ? d.counts[s] ?? 0 : all) : "…"})</span>
            </button>
          ))}
        </div>
        {error ? <ErrorState message={error} onRetry={load} /> : !d ? <LoadingState /> : d.items.length === 0 ? (
          <EmptyState icon={CreditCard} title="No online payments" message={all === 0 ? "Payments parents make from the parent portal appear here. Set up Razorpay under Settings." : "None match these filters."} />
        ) : (
          <>
            <ul className="divide-y divide-line" data-testid="online-list">
              {d.items.map((p) => <Row key={p.id} p={p} schoolId={schoolId} onChange={(x) => { replace(x); void load(); }} onRefund={setRefunding} />)}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={d.total} onChange={setPage} />
          </>
        )}
      </section>
      <RefundModal schoolId={schoolId} p={refunding} onClose={() => setRefunding(null)}
        onDone={(x) => { setRefunding(null); replace(x); void load(); toast.success(x.status === "refunded" ? "Refunded." : "Refund started; Razorpay will confirm it."); }} />
    </>
  );
}

export default function OnlinePaymentsPage() {
  return <RequirePermission permission="fees:view"><OnlinePayments /></RequirePermission>;
}
