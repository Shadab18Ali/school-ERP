"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { SectionPicker, type Pick } from "@/components/attendance/section-picker";
import { STATUS_TONE } from "@/components/attendance/student-attendance";
import { PageHeader } from "@/components/layout/app-shell";
import { TextField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import type { AttendanceCounts, AttendanceDay, AttendanceStatus, AttendanceTotals } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";
import { CalendarCheck } from "lucide-react";

type Tab = "daily" | "monthly" | "class";
const pct = (p: string | null) => (p === null ? "—" : `${p}%`);

function useReport<T>(path: string | null, query: Record<string, string>, schoolId: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(query);
  const latest = useRef(0); // only the newest request may update the screen
  const load = useCallback(async () => {
    const mine = ++latest.current;
    if (!path) { setData(null); return; }
    setError(null);
    setData(null);
    try {
      const result = await apiFetch<T>(path, { schoolId, query });
      if (mine === latest.current) setData(result);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, schoolId]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, load };
}

function Daily({ schoolId }: { schoolId: string }) {
  const [day, setDay] = useState(todayISO());
  const { data, error, load } = useReport<{ sections: (AttendanceCounts & { section_id: string; class_name: string; section_name: string; enrolled: number })[]; totals: AttendanceCounts }>(
    "/attendance/daily", { date: day }, schoolId);
  return (
    <>
      <TextField className="mb-4 max-w-xs" label="Date" type="date" max={todayISO()} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
      {error ? <ErrorState message={error} onRetry={load} /> : !data ? <LoadingState /> : (
        <div className="rounded-lg border border-line bg-white">
          <p className="tabular border-b border-line px-4 py-2.5 text-sm" data-testid="daily-totals">
            School: {data.totals.present} present · {data.totals.absent} absent · {data.totals.leave} leave · {data.totals.unmarked} not marked · <b>{pct(data.totals.percentage)}</b>
          </p>
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs text-muted">
                <tr><th className="px-4 py-2">Class</th><th className="px-3 py-2 text-right">Students</th><th className="px-3 py-2 text-right">P</th><th className="px-3 py-2 text-right">A</th><th className="px-3 py-2 text-right">L</th><th className="px-3 py-2 text-right">Not marked</th><th className="px-4 py-2 text-right">%</th></tr>
              </thead>
              <tbody className="tabular divide-y divide-line">
                {data.sections.map((s) => (
                  <tr key={s.section_id} data-testid={`daily-${s.class_name}-${s.section_name}`}>
                    <td className="px-4 py-2"><Link className="hover:underline" href={`/attendance?section=${s.section_id}&date=${day}`}>{s.class_name} – {s.section_name}</Link></td>
                    <td className="px-3 py-2 text-right">{s.enrolled}</td><td className="px-3 py-2 text-right">{s.present}</td><td className="px-3 py-2 text-right">{s.absent}</td>
                    <td className="px-3 py-2 text-right">{s.leave}</td><td className={clsx("px-3 py-2 text-right", s.unmarked && "text-danger-600")}>{s.unmarked}</td>
                    <td className="px-4 py-2 text-right font-medium">{pct(s.percentage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Monthly({ schoolId, pick }: { schoolId: string; pick: Pick }) {
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const { data, error, load } = useReport<{ days: AttendanceDay[]; students: (AttendanceTotals & { days: Record<string, AttendanceStatus> })[] }>(
    pick.section ? "/attendance/monthly" : null, { section_id: pick.section, month }, schoolId);
  return (
    <>
      <TextField className="mb-4 max-w-xs" label="Month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      {!pick.section ? <Choose /> : error ? <ErrorState message={error} onRetry={load} /> : !data ? <LoadingState /> : data.days.length === 0 ? (
        <div className="rounded-lg border border-line bg-white"><EmptyState icon={CalendarCheck} title="No attendance this month" message="Nothing has been marked for this section in this month." /></div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="text-sm" data-testid="monthly-grid">
            <thead className="bg-paper text-xs text-muted">
              <tr>
                <th className="sticky left-0 bg-paper px-3 py-2 text-left">Student</th>
                {data.days.map((d) => <th key={d.date} className="px-1.5 py-2 text-center" title={formatDate(d.date)}>{Number(d.date.slice(8))}</th>)}
                <th className="px-2 py-2">P</th><th className="px-2 py-2">A</th><th className="px-2 py-2">L</th><th className="px-3 py-2">%</th>
              </tr>
            </thead>
            <tbody className="tabular divide-y divide-line">
              {data.students.map((s) => (
                <tr key={s.enrollment_id} data-testid={`monthly-${s.admission_number}`}>
                  <td className="sticky left-0 whitespace-nowrap bg-white px-3 py-1.5"><Link className="hover:underline" href={`/students/${s.student_id}?tab=Attendance`}>{s.full_name}</Link></td>
                  {data.days.map((d) => {
                    const st = s.days[d.date];
                    return <td key={d.date} className="px-1 py-1.5 text-center">{st ? <span className={clsx("inline-block w-5 rounded text-xs font-semibold", STATUS_TONE[st])}>{st[0].toUpperCase()}</span> : <span className="text-line">·</span>}</td>;
                  })}
                  <td className="px-2 text-center">{s.present}</td><td className="px-2 text-center">{s.absent}</td><td className="px-2 text-center">{s.leave}</td>
                  <td className="px-3 text-right font-medium">{pct(s.percentage)}</td>
                </tr>
              ))}
              <tr className="bg-paper text-xs text-muted">
                <td className="sticky left-0 bg-paper px-3 py-1.5">Class %</td>
                {data.days.map((d) => <td key={d.date} className="px-1 py-1.5 text-center">{d.percentage ? Math.round(Number(d.percentage)) : "—"}</td>)}
                <td colSpan={4} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ClassReport({ schoolId, pick }: { schoolId: string; pick: Pick }) {
  const [from, setFrom] = useState(`${todayISO().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayISO());
  const { data, error, load } = useReport<{ students: AttendanceTotals[]; days: AttendanceDay[]; overall: string | null }>(
    pick.section ? "/attendance/class" : null, { section_id: pick.section, date_from: from, date_to: to }, schoolId);
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-3">
        <TextField label="From" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} min={from} max={todayISO()} onChange={(e) => e.target.value && setTo(e.target.value)} />
      </div>
      {!pick.section ? <Choose /> : error ? <ErrorState message={error} onRetry={load} /> : !data ? <LoadingState /> : (
        <div className="rounded-lg border border-line bg-white">
          <p className="tabular border-b border-line px-4 py-2.5 text-sm" data-testid="class-overall">
            {data.days.length} day{data.days.length === 1 ? "" : "s"} marked · class attendance <b>{pct(data.overall)}</b>
          </p>
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs text-muted"><tr><th className="px-4 py-2">Student</th><th className="px-3 py-2 text-right">P</th><th className="px-3 py-2 text-right">A</th><th className="px-3 py-2 text-right">L</th><th className="px-4 py-2 text-right">%</th></tr></thead>
              <tbody className="tabular divide-y divide-line">
                {data.students.map((s) => (
                  <tr key={s.enrollment_id} data-testid={`class-${s.admission_number}`}>
                    <td className="px-4 py-2"><Link className="hover:underline" href={`/students/${s.student_id}?tab=Attendance`}>{s.full_name}</Link></td>
                    <td className="px-3 py-2 text-right">{s.present}</td><td className="px-3 py-2 text-right">{s.absent}</td><td className="px-3 py-2 text-right">{s.leave}</td>
                    <td className={clsx("px-4 py-2 text-right font-medium", s.percentage !== null && Number(s.percentage) < 75 && "text-danger-600")}>{pct(s.percentage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Choose() {
  return <div className="rounded-lg border border-line bg-white"><EmptyState icon={CalendarCheck} title="Choose a class and section" message="The report appears here." /></div>;
}

function Reports() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [tab, setTab] = useState<Tab>("daily");
  const [pick, setPick] = useState<Pick>({ session: "", klass: "", section: "" });
  return (
    <>
      <PageHeader title="Attendance reports" description="Percentage = present ÷ days marked (leave counts as marked, not present)." />
      <div role="tablist" aria-label="Report" className="mb-4 flex gap-1 border-b border-line">
        {(["daily", "monthly", "class"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={clsx("-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {tab !== "daily" && (
        <div className="mb-4 grid gap-3 rounded-lg border border-line bg-white p-4 sm:grid-cols-3">
          <SectionPicker schoolId={schoolId} value={pick} onChange={setPick} />
        </div>
      )}
      {tab === "daily" ? <Daily schoolId={schoolId} /> : tab === "monthly" ? <Monthly schoolId={schoolId} pick={pick} /> : <ClassReport schoolId={schoolId} pick={pick} />}
    </>
  );
}

export default function ReportsPage() {
  return <RequirePermission permission="attendance:mark"><Reports /></RequirePermission>;
}
