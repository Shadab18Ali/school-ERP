"use client";

import { ReceiptIndianRupee, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, useRef } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { CancelReceipt } from "@/components/fees/cancel-receipt";
import { ReceiptActions } from "@/components/fees/receipt-actions";
import { PageHeader } from "@/components/layout/app-shell";
import { SelectField, TextField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { MODE_LABELS, type RecordedMode } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

interface Row { id: string; receipt_number: string; payment_date: string; amount: string; payment_mode: RecordedMode; cancelled?: boolean;
  reference_number: string | null; student_id: string; student_name: string; student_code: string; received_by_name: string | null }
interface Register { items: Row[]; total: number; amount_total: string; page: number; page_size: number }

function Payments() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [from, setFrom] = useState(todayISO().slice(0, 8) + "01");
  const [to, setTo] = useState(todayISO());
  const [mode, setMode] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Register | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const latest = useRef(0); // only the newest request may update the register
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setError(null);
    try {
      const result = await apiFetch<Register>("/fee-payments", { schoolId, query: { date_from: from, date_to: to, mode, search, page } });
      if (mine === latest.current) setData(result);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [schoolId, from, to, mode, search, page]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  return (
    <>
      <PageHeader title="Payments" description="Every receipt issued. Receipts can't be edited or deleted." />
      <div className="rounded-lg border border-line bg-white">
        <div className="grid gap-3 border-b border-line p-4 md:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative self-end">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="pay-search" className="sr-only">Search payments</label>
            <input id="pay-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Receipt no., student or reference"
              className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </div>
          <TextField label="From" type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          <TextField label="To" type="date" value={to} min={from} max={todayISO()} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          <SelectField label="Mode" value={mode} onChange={(e) => { setMode(e.target.value); setPage(1); }}>
            <option value="">All modes</option>
            {(Object.keys(MODE_LABELS) as RecordedMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
          </SelectField>
        </div>
        <p className="tabular border-b border-line px-4 py-2.5 text-sm" data-testid="register-total">
          {data.total} receipt{data.total === 1 ? "" : "s"} · <span className="font-semibold">{formatINR(data.amount_total)}</span> collected
        </p>
        {data.items.length === 0 ? (
          <EmptyState icon={ReceiptIndianRupee} title="No payments in this period" message="Change the dates or filters to see other payments." />
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper text-left text-xs font-medium text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Receipt</th>
                    <th scope="col" className="px-4 py-2.5">Student</th>
                    <th scope="col" className="hidden px-4 py-2.5 md:table-cell">Mode</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Amount</th>
                    <th scope="col" className="w-24 px-4 py-2.5"><span className="sr-only">Receipt</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((r) => (
                    <tr key={r.id} data-testid={`register-${r.receipt_number}`}>
                      <td className="px-4 py-2.5"><p className={r.cancelled ? "font-medium text-muted line-through" : "font-medium"}>{r.receipt_number}</p>{r.cancelled && <p className="text-xs font-medium text-danger-600">Cancelled (not counted)</p>}<p className="text-xs text-muted">{formatDate(r.payment_date)}</p></td>
                      <td className="px-4 py-2.5"><Link className="hover:underline" href={`/fees/collect/${r.student_id}`}>{r.student_name}</Link><p className="text-xs text-muted">{r.student_code}</p></td>
                      <td className="hidden px-4 py-2.5 text-muted md:table-cell">{MODE_LABELS[r.payment_mode]}{r.reference_number ? ` · ${r.reference_number}` : ""}</td>
                      <td className="tabular px-4 py-2.5 text-right font-medium">{formatINR(r.amount)}</td>
                      <td className="px-4 py-2.5"><span className="inline-flex gap-1">
                        <ReceiptActions paymentId={r.id} receiptNumber={r.receipt_number} schoolId={schoolId} size="sm" />
                        <CancelReceipt paymentId={r.id} receiptNumber={r.receipt_number} amount={r.amount} schoolId={schoolId}
                          mode={r.payment_mode} cancelled={!!r.cancelled} onDone={() => void load()} />
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.page_size} total={data.total} onChange={setPage} />
          </>
        )}
      </div>
    </>
  );
}

export default function PaymentsPage() {
  return <RequirePermission permission="fees:collect"><Payments /></RequirePermission>;
}
