"use client";

import { clsx } from "clsx";
import { FileSpreadsheet, FileText, FileDown, Search, Table2 } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { formatINR } from "@/lib/money";
import type { AcademicSession, ClassList, Permission, SchoolClass } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

type ReportKey = "students" | "classes" | "fee-collection" | "pending-fees" | "payments" | "attendance";
type FilterKey = "session" | "class" | "section" | "search" | "status" | "gender" | "dates" | "mode" | "group_by" | "overdue_only" | "below";

const REPORTS: { key: ReportKey; label: string; permission: Permission; filters: FilterKey[]; hint: string }[] = [
  { key: "students", label: "Students", permission: "students:view", filters: ["session", "class", "section", "status", "gender", "search"], hint: "Every student enrolled in the session." },
  { key: "classes", label: "Classes", permission: "students:view", filters: ["session", "class", "dates", "search"], hint: "Each section: students, attendance and fees (columns depend on your role)." },
  { key: "fee-collection", label: "Fee collection", permission: "fees:collect", filters: ["dates", "group_by", "mode", "class"], hint: "Money received in the period, grouped as you choose." },
  { key: "pending-fees", label: "Pending fees", permission: "fees:collect", filters: ["session", "class", "section", "overdue_only", "search"], hint: "Students who still owe fees this session, largest first." },
  { key: "payments", label: "Payment history", permission: "fees:collect", filters: ["dates", "mode", "class", "search"], hint: "Every receipt issued in the period." },
  { key: "attendance", label: "Attendance", permission: "attendance:mark", filters: ["session", "class", "section", "dates", "below", "search"], hint: "Attendance % per student for the period (present ÷ days marked)." },
];

interface Column { key: string; label: string; kind: "text" | "int" | "money" | "percent" | "date" }
interface Result { title: string; subtitle: string; columns: Column[]; rows: Record<string, string | number | null>[]; totals: Record<string, string | number> | null; total: number; page: number; page_size: number }

function show(v: string | number | null | undefined, kind: Column["kind"]) {
  if (v === null || v === undefined || v === "") return "—";
  if (kind === "money") return formatINR(String(v));
  if (kind === "percent") return `${v}%`;
  if (kind === "date") return formatDate(String(v));
  if (kind === "int") return Number(v).toLocaleString("en-IN");
  return String(v);
}

function ReportsView() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const pathname = usePathname();
  const params = useSearchParams();
  const available = REPORTS.filter((r) => can(r.permission));
  const [report, setReport] = useState<ReportKey>(() => {
    const wanted = params.get("report") as ReportKey | null;
    return available.find((r) => r.key === wanted)?.key ?? available[0]?.key ?? "students";
  });
  const def = REPORTS.find((r) => r.key === report)!;
  const firstOfMonth = `${todayISO().slice(0, 7)}-01`;
  const [f, setF] = useState<Record<string, string>>({ date_from: firstOfMonth, date_to: todayISO(), group_by: "head" });
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  useEffect(() => { window.history.replaceState(null, "", `${pathname}?report=${report}`); }, [report, pathname]);
  useEffect(() => { apiFetch<AcademicSession[]>("/sessions", { schoolId }).then(setSessions).catch(() => setSessions([])); }, [schoolId]);
  useEffect(() => {
    apiFetch<ClassList>("/classes", { schoolId, query: { session_id: f.session_id } }).then((r) => setClasses(r.items)).catch(() => setClasses([]));
  }, [schoolId, f.session_id]);
  useEffect(() => { const t = setTimeout(() => { setF((x) => ({ ...x, search: q.trim() })); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);

  const query = useMemo(() => {
    const out: Record<string, string> = {};
    const has = (k: FilterKey) => def.filters.includes(k);
    if (has("session") && f.session_id) out.session_id = f.session_id;
    if (has("class") && f.class_id) out.class_id = f.class_id;
    if (has("section") && f.section_id) out.section_id = f.section_id;
    if (has("search") && f.search) out.search = f.search;
    if (has("status") && f.status) out.status = f.status;
    if (has("gender") && f.gender) out.gender = f.gender;
    if (has("mode") && f.mode) out.mode = f.mode;
    if (has("group_by")) out.group_by = f.group_by || "head";
    if (has("overdue_only") && f.overdue_only === "true") out.overdue_only = "true";
    if (has("below") && f.below) out.below = f.below;
    if (has("dates")) { out.date_from = f.date_from; out.date_to = f.date_to; }
    return out;
  }, [def, f]);

  const latest = useRef(0); // only the newest request may update the screen
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<Result>(`/reports/${report}`, { schoolId, query: { ...query, page, page_size: 25 } });
      if (mine === latest.current) setData(result);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
    finally { if (mine === latest.current) setLoading(false); }
  }, [report, schoolId, query, page]);
  useEffect(() => { void load(); }, [load]);

  const set = (k: string, v: string) => { setF((x) => ({ ...x, [k]: v, ...(k === "class_id" ? { section_id: "" } : {}), ...(k === "session_id" ? { class_id: "", section_id: "" } : {}) })); setPage(1); };

  async function exportAs(format: "csv" | "xlsx" | "pdf") {
    setExporting(format);
    try {
      const { blob, filename } = await apiFetchBlob(`/reports/${report}`, { schoolId, query: { ...query, format } });
      saveBlob(blob, filename ?? `${report}.${format}`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setExporting(null); }
  }

  if (available.length === 0) return <ErrorState message="Your role doesn't include any reports." />;
  const sectionsOf = classes.find((c) => c.id === f.class_id)?.sections ?? [];
  const has = (k: FilterKey) => def.filters.includes(k);

  return (
    <>
      <PageHeader title="Reports" description="Search, filter and export. Every figure comes straight from your school's records." />
      <div role="tablist" aria-label="Report" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {available.map((r) => (
          <button key={r.key} role="tab" aria-selected={report === r.key} onClick={() => { setReport(r.key); setPage(1); setData(null); }}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", report === r.key ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-line bg-white">
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
          {has("search") && (
            <div className="relative self-end sm:col-span-2 lg:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <label htmlFor="report-search" className="sr-only">Search</label>
              <input id="report-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
                className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
            </div>
          )}
          {has("session") && (
            <SelectField label="Session" value={f.session_id ?? ""} onChange={(e) => set("session_id", e.target.value)}>
              <option value="">Current session</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
            </SelectField>
          )}
          {has("class") && (
            <SelectField label="Class" value={f.class_id ?? ""} onChange={(e) => set("class_id", e.target.value)}>
              <option value="">All classes</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
          )}
          {has("section") && (
            <SelectField label="Section" value={f.section_id ?? ""} disabled={!f.class_id} onChange={(e) => set("section_id", e.target.value)}>
              <option value="">All sections</option>
              {sectionsOf.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </SelectField>
          )}
          {has("dates") && <>
            <TextField label="From" type="date" value={f.date_from} max={f.date_to} onChange={(e) => e.target.value && set("date_from", e.target.value)} />
            <TextField label="To" type="date" value={f.date_to} min={f.date_from} max={todayISO()} onChange={(e) => e.target.value && set("date_to", e.target.value)} />
          </>}
          {has("group_by") && (
            <SelectField label="Group by" value={f.group_by ?? "head"} onChange={(e) => set("group_by", e.target.value)}>
              <option value="head">Fee head</option><option value="mode">Payment mode</option><option value="class">Class</option><option value="day">Day</option>
            </SelectField>
          )}
          {has("mode") && (
            <SelectField label="Payment mode" value={f.mode ?? ""} onChange={(e) => set("mode", e.target.value)}>
              <option value="">All modes</option><option value="cash">Cash</option><option value="upi">UPI</option>
              <option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option><option value="other">Other</option>
            </SelectField>
          )}
          {has("status") && (
            <SelectField label="Status" value={f.status ?? ""} onChange={(e) => set("status", e.target.value)}>
              <option value="">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option>
            </SelectField>
          )}
          {has("gender") && (
            <SelectField label="Gender" value={f.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
              <option value="">Any gender</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
            </SelectField>
          )}
          {has("below") && (
            <SelectField label="Attendance below" value={f.below ?? ""} onChange={(e) => set("below", e.target.value)}>
              <option value="">Any</option><option value="75">75%</option><option value="85">85%</option><option value="90">90%</option>
            </SelectField>
          )}
          {has("overdue_only") && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" checked={f.overdue_only === "true"} onChange={(e) => set("overdue_only", String(e.target.checked))} />
              Overdue only
            </label>
          )}
        </div>

        <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium" data-testid="report-summary">{data ? `${data.total.toLocaleString("en-IN")} row${data.total === 1 ? "" : "s"}${data.subtitle ? ` · ${data.subtitle}` : ""}` : def.hint}</p>
            <p className="text-xs text-muted">{def.hint}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => exportAs("csv")} loading={exporting === "csv"} disabled={!data?.total}><FileDown className="size-4" /> CSV</Button>
            <Button variant="secondary" size="sm" onClick={() => exportAs("xlsx")} loading={exporting === "xlsx"} disabled={!data?.total}><FileSpreadsheet className="size-4" /> Excel</Button>
            <Button variant="secondary" size="sm" onClick={() => exportAs("pdf")} loading={exporting === "pdf"} disabled={!data?.total}><FileText className="size-4" /> PDF</Button>
          </div>
        </div>

        {error ? <ErrorState message={error} onRetry={load} /> : !data ? <LoadingState /> : data.rows.length === 0 ? (
          <EmptyState icon={Table2} title="No matching records" message="Try a wider date range or fewer filters." />
        ) : (
          <div className={clsx(loading && "opacity-60")} aria-busy={loading}>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm" data-testid="report-table">
                <thead className="bg-paper text-left text-xs font-medium text-muted">
                  <tr>{data.columns.map((c) => <th key={c.key} scope="col" className={clsx("whitespace-nowrap px-3 py-2.5", ["int", "money", "percent"].includes(c.kind) && "text-right")}>{c.label}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.rows.map((r, i) => (
                    <tr key={i}>
                      {data.columns.map((c) => <td key={c.key} className={clsx("whitespace-nowrap px-3 py-2", ["int", "money", "percent"].includes(c.kind) && "tabular text-right")}>{show(r[c.key], c.kind)}</td>)}
                    </tr>
                  ))}
                </tbody>
                {data.totals && (
                  <tfoot className="border-t-2 border-board-900 font-semibold" data-testid="report-totals">
                    <tr>{data.columns.map((c, i) => <td key={c.key} className={clsx("whitespace-nowrap px-3 py-2", ["int", "money", "percent"].includes(c.kind) && "tabular text-right")}>{i === 0 ? "Total" : c.key in data.totals! ? show(data.totals![c.key], c.kind) : ""}</td>)}</tr>
                  </tfoot>
                )}
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.page_size} total={data.total} onChange={setPage} />
          </div>
        )}
      </div>
    </>
  );
}

export default function ReportsPage() {
  return <RequirePermission permission="reports:view" feature="reports"><Suspense fallback={<LoadingState />}><ReportsView /></Suspense></RequirePermission>;
}
