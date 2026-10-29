"use client";

import { Search, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, useRef } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { FeeRemindersButton } from "@/components/notifications/history";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatINR } from "@/lib/money";
import type { AcademicSession, ClassList, Paginated, SchoolClass, StudentBalanceRow } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

type List = Paginated<StudentBalanceRow> & { session_id: string | null; session_name: string | null };

function CollectList() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const get = (k: string) => params.get(k) ?? "";
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(get("q"));

  const set = useCallback((next: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`${pathname}?${p}`, { scroll: false });
  }, [params, pathname, router]);

  // Search lives in state (debounced), not the URL: writing the URL after a delay
  // could pull the user back here if they clicked a student meanwhile.
  const [search, setSearch] = useState(get("q").trim());
  const [page, setPage] = useState(Number(get("page")) || 1);
  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPage(1), [params]);

  const latest = useRef(0); // only the newest request may update the list
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setError(null);
    try {
      const [ss, list] = await Promise.all([
        apiFetch<AcademicSession[]>("/sessions", { schoolId }),
        apiFetch<List>("/fee-collection/students", {
          schoolId, query: { session_id: get("session"), class_id: get("class"), search, balance: get("balance"), page },
        }),
      ]);
      if (mine !== latest.current) return;
      setSessions(ss);
      setData(list);
      if (list.session_id) {
        const c = await apiFetch<ClassList>("/classes", { schoolId, query: { session_id: list.session_id } });
        setClasses(c.items);
      }
    } catch (e) { setError(errorMessage(e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, params, search, page]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;

  return (
    <>
      <PageHeader title="Collect fees" description={data.session_name ? `Balances for ${data.session_name}. Choose a student to record a payment.` : undefined}
        actions={<FeeRemindersButton schoolId={schoolId} />} />
      <div className="rounded-lg border border-line bg-white">
        <div className="grid gap-3 border-b border-line p-4 md:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="fee-search" className="sr-only">Search students</label>
            <input id="fee-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Student ID, admission no. or parent"
              className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </div>
          <SelectField label="Session" hideLabel value={data.session_id ?? ""} onChange={(e) => set({ session: e.target.value, class: "" })}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
          </SelectField>
          <SelectField label="Class" hideLabel value={get("class")} onChange={(e) => set({ class: e.target.value })}>
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
          <SelectField label="Balance" hideLabel value={get("balance")} onChange={(e) => set({ balance: e.target.value })}>
            <option value="">All students</option>
            <option value="outstanding">With balance due</option>
            <option value="overdue">Overdue</option>
            <option value="cleared">Fully paid</option>
          </SelectField>
        </div>
        {data.items.length === 0 ? (
          <EmptyState icon={Wallet} title="No students match" message="Try another search or filter. Students appear here once they're enrolled in this session." />
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper text-left text-xs font-medium text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Student</th>
                    <th scope="col" className="hidden px-4 py-2.5 sm:table-cell">Class</th>
                    <th scope="col" className="hidden px-4 py-2.5 text-right md:table-cell">Total</th>
                    <th scope="col" className="hidden px-4 py-2.5 text-right md:table-cell">Paid</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Balance</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Overdue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((r) => (
                    <tr key={r.enrollment_id} className="hover:bg-paper/60" data-testid={`balance-row-${r.admission_number}`}>
                      <td className="px-4 py-2.5">
                        <Link className="font-medium hover:underline" href={`/fees/collect/${r.student_id}${data.session_id ? `?session=${data.session_id}` : ""}`}>{r.student_name}</Link>
                        <p className="text-xs text-muted">{r.student_code} · Adm. {r.admission_number}{r.status === "inactive" ? " · inactive" : ""}</p>
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-2.5 sm:table-cell">{r.class_section}</td>
                      <td className="tabular hidden px-4 py-2.5 text-right md:table-cell">{formatINR(r.totals.total)}</td>
                      <td className="tabular hidden px-4 py-2.5 text-right text-muted md:table-cell">{formatINR(r.totals.paid)}</td>
                      <td className="tabular px-4 py-2.5 text-right font-medium" data-testid="row-outstanding">{formatINR(r.totals.outstanding)}</td>
                      <td className={`tabular px-4 py-2.5 text-right ${Number(r.totals.overdue) > 0 ? "text-danger-600" : "text-muted"}`}>{formatINR(r.totals.overdue)}</td>
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

export default function CollectPage() {
  return <RequirePermission permission="fees:collect"><Suspense fallback={<LoadingState />}><CollectList /></Suspense></RequirePermission>;
}
