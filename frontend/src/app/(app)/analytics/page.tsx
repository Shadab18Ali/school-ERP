"use client";

import { clsx } from "clsx";
import { CalendarRange, Loader2, RefreshCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdmissionsTab } from "@/components/analytics/admissions-tab";
import { FeesTab } from "@/components/analytics/fees-tab";
import { StudentsTab } from "@/components/analytics/students-tab";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import {
  type AdmissionAnalytics, type AnalyticsTab, type FeeAnalytics, presetRange, type RangePreset, type StudentAnalytics,
} from "@/lib/analytics";
import { formatDate, todayISO } from "@/lib/format";
import type { AcademicSession, ClassList, Permission, SchoolClass } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const TABS: { key: AnalyticsTab; label: string; permission: Permission; hint: string }[] = [
  { key: "students", label: "Students", permission: "analytics:students", hint: "Enrollment, class strength, attendance and exam results." },
  { key: "fees", label: "Fees", permission: "analytics:fees", hint: "Collection, pending fees, classes, payment methods and outstanding over time." },
  { key: "admissions", label: "Admissions", permission: "analytics:admissions", hint: "Enquiries, online applications, conversion and admissions." },
];
const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "session", label: "Whole session" },
  { key: "this_month", label: "This month" },
  { key: "last_3", label: "Last 3 months" },
  { key: "last_6", label: "Last 6 months" },
  { key: "custom", label: "Custom dates" },
];

type Data = StudentAnalytics | FeeAnalytics | AdmissionAnalytics;
interface Filters { session: string; class: string; period: RangePreset; from: string; to: string; exam: string }

function AnalyticsView() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const params = useSearchParams();
  const available = TABS.filter((t) => can(t.permission));
  const [tab, setTab] = useState<AnalyticsTab>(() => {
    const wanted = params.get("tab");
    return available.find((t) => t.key === wanted)?.key ?? available[0]?.key ?? "fees";
  });
  const today = todayISO();
  const [f, setF] = useState<Filters>(() => ({
    session: params.get("session") ?? "", class: params.get("class") ?? "",
    period: (PRESETS.find((p) => p.key === params.get("period"))?.key ?? "session") as RangePreset,
    from: params.get("from") ?? `${today.slice(0, 7)}-01`, to: params.get("to") ?? today, exam: params.get("exam") ?? "",
  }));
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [data, setData] = useState<{ tab: AnalyticsTab; body: Data } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  useEffect(() => { apiFetch<AcademicSession[]>("/sessions", { schoolId }).then(setSessions).catch(() => setSessions([])); }, [schoolId]);
  useEffect(() => {
    apiFetch<ClassList>("/classes", { schoolId, query: { session_id: f.session || undefined } })
      .then((r) => setClasses(r.items)).catch(() => setClasses([]));
  }, [schoolId, f.session]);

  const range = useMemo(() => (f.period === "custom" ? { from: f.from, to: f.to } : presetRange(f.period, today)), [f.period, f.from, f.to, today]);
  const query = useMemo(() => {
    const q: Record<string, string> = {};
    if (f.session) q.session_id = f.session;
    if (f.class) q.class_id = f.class;
    if (range) { q.from = range.from; q.to = range.to; }
    if (tab === "students" && f.exam) q.exam_id = f.exam;
    return q;
  }, [f.session, f.class, f.exam, range, tab]);

  // the address keeps the view, so it can be bookmarked or shared with a colleague who may see it
  useEffect(() => {
    const u = new URLSearchParams({ tab });
    if (f.session) u.set("session", f.session);
    if (f.class) u.set("class", f.class);
    if (f.period !== "session") u.set("period", f.period);
    if (f.period === "custom") { u.set("from", f.from); u.set("to", f.to); }
    if (tab === "students" && f.exam) u.set("exam", f.exam);
    try { window.history.replaceState(null, "", `/analytics?${u}`); } catch { /* ignore */ }
  }, [tab, f]);

  const customInvalid = f.period === "custom" && f.from > f.to;
  const latest = useRef(0); // only the newest request may update the screen
  const load = useCallback(async () => {
    if (customInvalid) return;
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const body = await apiFetch<Data>(`/analytics/${tab}`, { schoolId, query });
      if (mine === latest.current) { setData({ tab, body }); setLoadedAt(new Date()); }
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
    finally { if (mine === latest.current) setLoading(false); }
  }, [tab, schoolId, query, customInvalid]);
  useEffect(() => { void load(); }, [load]);

  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const def = TABS.find((t) => t.key === tab)!;
  const shown = data && data.tab === tab ? data.body : null; // never draw one tab's figures under another's
  const exams = tab === "students" && shown ? (shown as StudentAnalytics).performance?.exams ?? [] : [];

  if (available.length === 0) return <ErrorState message="Your role doesn't include analytics." />;

  return (
    <>
      <PageHeader title="Analytics" description="Trends across the school, worked out from your school's records each time you open them."
        actions={
          <div className="flex items-center gap-3">
            {loadedAt && <span className="text-xs text-muted" data-testid="analytics-updated">Updated {loadedAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</span>}
            <Button variant="secondary" size="sm" onClick={() => void load()} loading={loading && !!shown} data-testid="analytics-refresh"><RefreshCw className="size-4" /> Refresh</Button>
          </div>
        } />

      <div role="tablist" aria-label="Analytics" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {available.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} data-testid={`analytics-tab-${t.key}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t.key ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>

      {/* one row of filters, above every chart */}
      <div className="sticky top-14 z-10 -mx-4 mb-5 border-b border-line bg-paper/95 px-4 pb-3 pt-1 backdrop-blur sm:static sm:mx-0 sm:rounded-lg sm:border sm:bg-white sm:p-4" data-testid="analytics-filters">
        <div className="grid grid-cols-2 gap-3 md:flex md:flex-wrap md:items-end">
          <SelectField label="Session" className="md:w-44" value={f.session} data-testid="filter-session"
            onChange={(e) => set({ session: e.target.value, class: "", exam: "" })}>
            <option value="">Current session</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
          </SelectField>
          <SelectField label="Class" className="md:w-40" value={f.class} data-testid="filter-class" onChange={(e) => set({ class: e.target.value })}>
            <option value="">All classes</option>
            {classes.filter((c) => !c.is_deleted).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
          <SelectField label="Period" className="md:w-40" value={f.period} data-testid="filter-period" onChange={(e) => set({ period: e.target.value as RangePreset })}>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </SelectField>
          {f.period === "custom" && <>
            <TextField label="From" type="date" className="md:w-40" value={f.from} max={f.to} data-testid="filter-from" onChange={(e) => e.target.value && set({ from: e.target.value })} />
            <TextField label="To" type="date" className="md:w-40" value={f.to} min={f.from} data-testid="filter-to" onChange={(e) => e.target.value && set({ to: e.target.value })} />
          </>}
          {tab === "students" && (
            <SelectField label="Exam" className="md:w-44" value={f.exam} data-testid="filter-exam" onChange={(e) => set({ exam: e.target.value })}>
              <option value="">Latest with marks</option>
              {exams.filter((x) => x.has_marks).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </SelectField>
          )}
          <p className="col-span-2 flex items-center gap-1.5 text-xs text-muted md:ml-auto md:pb-2.5" data-testid="analytics-scope">
            {loading && shown ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CalendarRange className="size-3.5" aria-hidden />}
            {scopeText(tab, shown, range)}
          </p>
        </div>
        {customInvalid && <p className="mt-2 text-xs text-danger-600">The start date must be on or before the end date.</p>}
      </div>

      {error && !shown ? <ErrorState message={error} onRetry={load} />
        : !shown ? <LoadingState label="Working out the figures…" />
          : !shown.session ? (
            <EmptyState icon={CalendarRange} title="No academic session yet" message="Analytics follow a session. Set up the school's current session to see them." />
          ) : (
            <div className={clsx("transition-opacity", loading && "opacity-50")} aria-busy={loading} data-testid={`analytics-${tab}`}>
              {error && <p className="mb-4 rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error} Showing the previous figures.</p>}
              <p className="sr-only">{def.hint}</p>
              {tab === "students" && <StudentsTab data={shown as StudentAnalytics} />}
              {tab === "fees" && <FeesTab data={shown as FeeAnalytics} />}
              {tab === "admissions" && <AdmissionsTab data={shown as AdmissionAnalytics} />}
            </div>
          )}
    </>
  );
}

function scopeText(tab: AnalyticsTab, d: Data | null, range: { from: string; to: string } | null): string {
  if (!d?.session) return "";
  const s = d.session.name;
  if (tab === "admissions") return range ? `${s} admissions · ${formatDate(range.from)} – ${formatDate(range.to)}` : `${s} admissions, whenever they happened`;
  const w = d.window;
  return w.from && w.to ? `${s} · ${formatDate(w.from)} – ${formatDate(w.to)}` : s;
}

export default function AnalyticsPage() {
  return <RequirePermission permission="analytics:fees" feature="analytics"><Suspense fallback={<LoadingState />}><AnalyticsView /></Suspense></RequirePermission>;
}
