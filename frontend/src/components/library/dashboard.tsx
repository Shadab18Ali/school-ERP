"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import type { LibraryDashboard as Data } from "@/lib/library";
import { formatINR } from "@/lib/money";

function Tile({ label, value, sub, tone, href, testId }: { label: string; value: string; sub?: string; tone?: "dark" | "danger"; href?: string; testId: string }) {
  const body = (
    <div className={tone === "dark" ? "h-full rounded-lg bg-board-900 p-5 text-white" : "h-full rounded-lg border border-line bg-white p-5 hover:border-leaf-600/40"} data-testid={testId}>
      <p className={tone === "dark" ? "text-sm text-white/60" : "text-sm text-muted"}>{label}</p>
      <p className={tone === "danger" ? "tabular mt-2 text-3xl font-semibold tracking-tight text-danger-600" : "tabular mt-2 text-3xl font-semibold tracking-tight"} data-testid={`${testId}-value`}>{value}</p>
      {sub && <p className={tone === "dark" ? "mt-1 text-xs text-white/60" : "mt-1 text-xs text-muted"}>{sub}</p>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

const n = (x: number) => x.toLocaleString("en-IN");

export function LibraryKpis({ schoolId, compact = false }: { schoolId: string; compact?: boolean }) {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch<Data>("/library/dashboard", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  const owed = Number(d.fines_unpaid) + Number(d.fines_accruing);
  const maxCat = Math.max(1, ...d.by_category.map((c) => c.copies));
  return (
    <div className="space-y-6" data-testid="library-dashboard">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Total books" value={n(d.copies)} sub={`${n(d.titles)} title${d.titles === 1 ? "" : "s"}${d.lost ? ` · ${n(d.lost)} lost` : ""}${d.damaged ? ` · ${n(d.damaged)} damaged` : ""}`} tone="dark" testId="kpi-books" href="/library?tab=Catalogue" />
        <Tile label="Issued" value={n(d.issued)} sub={`${n(d.borrowers)} borrower${d.borrowers === 1 ? "" : "s"} · ${n(d.issued_today)} today`} testId="kpi-issued" href="/library?tab=Loans&state=open" />
        <Tile label="Available" value={n(d.available)} sub={`${n(d.returned_today)} returned today`} testId="kpi-available" href="/library?tab=Catalogue" />
        <Tile label="Overdue" value={n(d.overdue)} sub={d.overdue ? "past the due date" : "nothing late"} tone={d.overdue ? "danger" : undefined} testId="kpi-overdue" href="/library?tab=Loans&state=overdue" />
        <Tile label="Fines" value={formatINR(String(owed))} testId="kpi-fines" href="/library?tab=Loans&state=fines_unpaid"
          sub={Number(d.fine_per_day) === 0 ? "No fine rate set (Settings)" : `${formatINR(d.fines_unpaid)} to collect · ${formatINR(d.fines_accruing)} building up · ${formatINR(d.fines_collected_month)} collected this month`} />
      </div>
      {!compact && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-lg border border-line bg-white p-5">
            <h2 className="mb-3 font-semibold">Books by category</h2>
            {d.by_category.length === 0 ? <p className="text-sm text-muted">No books yet.</p> : (
              <ul className="space-y-2.5" data-testid="by-category">
                {d.by_category.map((c) => (
                  <li key={c.name} className="text-sm">
                    <div className="mb-1 flex justify-between"><span>{c.name}</span><span className="tabular text-muted">{n(c.issued)} out of {n(c.copies)}</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-ink/5" aria-hidden>
                      <div className="flex h-full" style={{ width: `${(c.copies / maxCat) * 100}%` }}>
                        <div className="h-full bg-leaf-600" style={{ width: `${c.copies ? (c.issued / c.copies) * 100 : 0}%` }} />
                        <div className="h-full flex-1 bg-leaf-600/25" />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted"><span className="inline-block size-2 rounded-full bg-leaf-600" /> issued <span className="ml-2 inline-block size-2 rounded-full bg-leaf-600/25" /> on the shelf or out of use</p>
          </section>
          <section className="rounded-lg border border-line bg-white p-5">
            <h2 className="mb-3 font-semibold">Most borrowed (last 90 days)</h2>
            {d.top_books.length === 0 ? <p className="text-sm text-muted">Nothing borrowed yet.</p> : (
              <ol className="space-y-2 text-sm" data-testid="top-books">
                {d.top_books.map((b, i) => (
                  <li key={b.id} className="flex items-center gap-3">
                    <span className="grid size-6 place-items-center rounded-full bg-paper text-xs text-muted">{i + 1}</span>
                    <Link href={`/library/books/${b.id}`} className="min-w-0 flex-1 truncate hover:underline">{b.title}</Link>
                    <span className="tabular text-muted">{n(b.loans)} loan{b.loans === 1 ? "" : "s"}</span>
                  </li>
                ))}
              </ol>
            )}
            <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
              <div><dt className="text-muted">Fines collected (all time)</dt><dd className="tabular font-medium">{formatINR(d.fines_collected_total)}</dd></div>
              <div><dt className="text-muted">Fines waived</dt><dd className="tabular font-medium">{formatINR(d.fines_waived_total)}</dd></div>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
