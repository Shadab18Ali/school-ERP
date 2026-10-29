"use client";

import { clsx } from "clsx";
import { CheckCircle2, CreditCard, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReceiptActions } from "@/components/fees/receipt-actions";
import { Button } from "@/components/ui/button";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, todayISO } from "@/lib/format";
import { formatINR } from "@/lib/money";
import {
  type OnlinePayment, type OnlineStatus, type OrderOut, loadCheckout, ONLINE_STATUS_LABEL, openCheckout, PARENT_STATUS_HINT,
} from "@/lib/payments";
import type { Due } from "@/lib/types";

type Result =
  | { kind: "paid"; receipt: string | null; feePaymentId: string | null; amount: string }
  | { kind: "processing"; id: string }
  | { kind: "failed"; message: string }
  | { kind: "review" }
  | { kind: "dismissed" };

const monthLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
const paise = (v: string) => Math.round(Number(v) * 100); // display totals only; the server decides the amount

export function StatusPill({ status }: { status: OnlineStatus }) {
  return (
    <span data-testid="online-status" className={clsx("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
      status === "paid" ? "bg-leaf-600 text-white"
        : status === "failed" || status === "refund_failed" ? "bg-danger-50 text-danger-600"
          : status === "refunded" || status === "refund_pending" ? "bg-pencil-100 text-ink"
            : status === "needs_review" ? "bg-pencil-100 text-ink ring-1 ring-inset ring-pencil-400"
              : "bg-paper text-muted ring-1 ring-inset ring-line")}>
      {ONLINE_STATUS_LABEL[status]}
    </span>
  );
}

export function PayOnline({ schoolId, studentId, dues, onChanged }: { schoolId: string; studentId: string; dues: Due[]; onChanged: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const pending = useMemo(() => dues.filter((d) => Number(d.balance) > 0), [dues]);
  const month = `${todayISO().slice(0, 7)}-01`;
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<OnlinePayment[] | null>(null);
  const polls = useRef(0);

  useEffect(() => { apiFetch<{ enabled: boolean }>("/payments/config", { schoolId }).then((c) => setEnabled(c.enabled)).catch(() => setEnabled(false)); }, [schoolId]);
  // overdue fees are chosen to start with
  useEffect(() => { setChosen(new Set(pending.filter((d) => d.due_month <= month).map((d) => d.due_id))); }, [pending, month]);
  const loadHistory = useCallback(() => {
    apiFetch<OnlinePayment[]>(`/payments/students/${studentId}`, { schoolId }).then(setHistory).catch(() => setHistory([]));
  }, [schoolId, studentId]);
  useEffect(() => { if (enabled) loadHistory(); }, [enabled, loadHistory]);

  const total = pending.filter((d) => chosen.has(d.due_id)).reduce((s, d) => s + paise(d.balance), 0);
  const toggle = (id: string) => setChosen((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  function show(r: { status: string; receipt_number?: string | null; fee_payment_id?: string | null; message?: string }, id: string, amount: string) {
    if (r.status === "paid") setResult({ kind: "paid", receipt: r.receipt_number ?? null, feePaymentId: r.fee_payment_id ?? null, amount });
    else if (r.status === "needs_review") setResult({ kind: "review" });
    else if (r.status === "failed") setResult({ kind: "failed", message: r.message ?? "The payment did not go through." });
    else setResult({ kind: "processing", id });
  }

  // "processing": ask the server (which asks Razorpay) a few more times
  useEffect(() => {
    if (result?.kind !== "processing") return;
    if (polls.current >= 10) return;
    const t = setTimeout(async () => {
      polls.current += 1;
      try {
        const r = await apiFetch<{ status: string; receipt_number?: string; fee_payment_id?: string; message?: string }>(`/payments/${result.id}/check`, { schoolId, method: "POST" });
        if (r.status !== "created" && r.status !== "processing") {
          const p = await apiFetch<OnlinePayment>(`/payments/${result.id}`, { schoolId });
          show({ ...r, receipt_number: p.receipt_number, fee_payment_id: p.fee_payment_id }, result.id, p.amount);
          onChanged(); loadHistory();
        } else setResult({ ...result });
      } catch { setResult({ ...result }); }
    }, 3000);
    return () => clearTimeout(t);
  }, [result, schoolId, onChanged, loadHistory]);

  async function pay() {
    setError(null); setResult(null); polls.current = 0;
    if (chosen.size === 0) { setError("Choose at least one fee."); return; }
    setBusy("pay");
    try {
      // the server works out the amount from the dues; the browser only says which fees
      const order = await apiFetch<OrderOut>("/payments/orders", { schoolId, method: "POST", body: { student_id: studentId, due_ids: [...chosen] } });
      await loadCheckout();
      const outcome = await openCheckout(order);
      if (outcome.kind === "dismissed") {
        // closed without the success callback: the parent may still have paid, so ask Razorpay (via the server)
        const r = await apiFetch<{ status: string; receipt_number?: string; fee_payment_id?: string }>(`/payments/${order.online_payment_id}/check`, { schoolId, method: "POST" }).catch(() => null);
        if (r && r.status !== "created" && r.status !== "processing" && r.status !== "cancelled") {
          const p = await apiFetch<OnlinePayment>(`/payments/${order.online_payment_id}`, { schoolId });
          show({ ...r, receipt_number: p.receipt_number, fee_payment_id: p.fee_payment_id }, order.online_payment_id, p.amount);
          onChanged();
        } else setResult({ kind: "dismissed" });
        return;
      }
      if (outcome.kind === "failed") {
        // Checkout reported a failure: confirm with the server rather than trusting the browser
        const r = await apiFetch<{ status: string; message?: string }>(`/payments/${order.online_payment_id}/check`, { schoolId, method: "POST" }).catch(() => null);
        setResult(r?.status === "paid" ? { kind: "processing", id: order.online_payment_id } : { kind: "failed", message: r?.message ?? outcome.data.error.description ?? "The payment did not go through." });
        return;
      }
      setBusy("verify");
      const r = await apiFetch<{ status: string; receipt_number?: string; fee_payment_id?: string; message?: string }>(
        `/payments/${order.online_payment_id}/verify`, { schoolId, method: "POST", body: outcome.data });
      show(r, order.online_payment_id, order.amount);
      onChanged();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); loadHistory(); }
  }

  async function check(id: string) {
    setBusy(id);
    try { await apiFetch(`/payments/${id}/check`, { schoolId, method: "POST" }); onChanged(); loadHistory(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }

  if (!enabled) return null;
  return (
    <div className="space-y-6">
      {result && (
        <div role="status" data-testid="payment-result" data-result={result.kind}
          className={clsx("flex items-start gap-3 rounded-lg border p-4 text-sm",
            result.kind === "paid" ? "border-leaf-600 bg-leaf-50" : result.kind === "failed" ? "border-danger-600/40 bg-danger-50" : "border-line bg-white")}>
          {result.kind === "paid" ? <CheckCircle2 className="size-5 text-leaf-700" /> : result.kind === "failed" ? <XCircle className="size-5 text-danger-600" />
            : result.kind === "processing" ? <Loader2 className="size-5 animate-spin text-muted" /> : <CreditCard className="size-5 text-muted" />}
          <div className="flex-1">
            {result.kind === "paid" && <>
              <p className="font-semibold">Payment of {formatINR(result.amount)} received. Thank you!</p>
              <p className="text-muted">Confirmed with the bank. Receipt <span className="font-medium text-ink" data-testid="paid-receipt">{result.receipt}</span>.</p>
              {result.feePaymentId && result.receipt && <div className="mt-2"><ReceiptActions paymentId={result.feePaymentId} receiptNumber={result.receipt} schoolId={schoolId} size="sm"
                path={`/portal/children/${studentId}/payments/${result.feePaymentId}/receipt.pdf`} /></div>}
            </>}
            {result.kind === "processing" && <><p className="font-semibold">Confirming your payment with the bank…</p>
              <p className="text-muted">This can take a minute. Don&apos;t pay again; the receipt will appear here.</p></>}
            {result.kind === "failed" && <><p className="font-semibold">The payment did not go through.</p><p className="text-muted">{result.message} You can try again.</p></>}
            {result.kind === "review" && <><p className="font-semibold">Payment received; the school office will confirm it.</p>
              <p className="text-muted">Some of these fees had already been paid, so the office will check and refund any extra.</p></>}
            {result.kind === "dismissed" && <><p className="font-semibold">Payment not completed.</p>
              <p className="text-muted">If money was taken from your account, it will show here once the bank confirms it (use “Check status” below).</p></>}
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <section className="rounded-lg border border-line bg-white" data-testid="pay-online">
          <div className="border-b border-line px-5 py-3.5">
            <h3 className="font-semibold">Pay online</h3>
            <p className="text-xs text-muted">UPI, debit/credit cards or net banking, through Razorpay. Choose the fees to pay.</p>
          </div>
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">
            {pending.map((d) => (
              <li key={d.due_id}>
                <label className="flex cursor-pointer items-center gap-3 px-5 py-2 text-sm hover:bg-paper">
                  <input type="checkbox" className="size-4 accent-leaf-600" checked={chosen.has(d.due_id)} onChange={() => toggle(d.due_id)}
                    aria-label={`${d.fee_head_name} ${monthLabel(d.due_month)}`} />
                  <span className="flex-1">{d.fee_head_name} · {monthLabel(d.due_month)}{d.due_month <= month && <span className="ml-2 text-xs text-danger-600">Overdue</span>}</span>
                  <span className="tabular font-medium">{formatINR(d.balance)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="text-sm">{chosen.size} fee{chosen.size === 1 ? "" : "s"} · <span className="tabular font-semibold" data-testid="pay-total">{formatINR((total / 100).toFixed(2))}</span></p>
            <Button onClick={pay} loading={busy === "pay" || busy === "verify"} disabled={chosen.size === 0} data-testid="pay-now">
              <CreditCard className="size-4" /> {busy === "verify" ? "Confirming…" : `Pay ${formatINR((total / 100).toFixed(2))}`}
            </Button>
          </div>
          {error && <p className="px-5 pb-3 text-sm text-danger-600" role="alert" data-testid="pay-error">{error}</p>}
        </section>
      )}

      {history && history.length > 0 && (
        <section className="rounded-lg border border-line bg-white">
          <h3 className="border-b border-line px-5 py-3.5 font-semibold">Online payments</h3>
          <ul className="divide-y divide-line" data-testid="online-history">
            {history.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{formatINR(p.amount)}</span><StatusPill status={p.status} />
                    {p.receipt_number && <span className="text-xs text-muted">Receipt {p.receipt_number}</span>}</p>
                  <p className="text-xs text-muted">{formatDateTime(p.paid_at ?? p.created_at)}{p.method_detail ? ` · ${p.method_detail}` : ""}</p>
                  {PARENT_STATUS_HINT[p.status] && <p className="text-xs text-muted">{PARENT_STATUS_HINT[p.status]}</p>}
                  {p.refunds.map((r) => <p key={r.gateway_refund_id} className="text-xs">Refund {formatINR(r.amount)} · {r.status} · {formatDate(r.created_at)}</p>)}
                </div>
                {(p.status === "created" || p.status === "failed") && p.gateway_order_id && (
                  <Button size="sm" variant="ghost" onClick={() => check(p.id)} loading={busy === p.id} data-testid="check-status"><RefreshCw className="size-4" /> Check status</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
