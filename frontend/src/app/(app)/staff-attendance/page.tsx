"use client";

import { clsx } from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { Pill, Section } from "@/components/hr/shared";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { ATTENDANCE_LABEL, monthName, type AttendanceDay, type AttendanceMonth, type AttendanceStatus } from "@/lib/hr";
import { useAuth } from "@/providers/auth-provider";

const shift = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const STATUSES: AttendanceStatus[] = ["present", "absent", "half_day"];

function Register({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [date, setDate] = useState(todayISO());
  const [d, setD] = useState<AttendanceDay | null>(null);
  const [marks, setMarks] = useState<Record<string, AttendanceStatus | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const load = useCallback(async () => {
    // a new date clears the register until its own data arrives (no marking the previous day's rows),
    // and a slower answer for an earlier date is ignored
    const call = ++latest.current;
    setError(null); setD(null);
    try {
      const r = await apiFetch<AttendanceDay>("/hr/attendance", { schoolId, query: { date } });
      if (call !== latest.current) return;
      setD(r); setMarks(Object.fromEntries(r.items.map((i) => [i.teacher_id, i.status])));
    } catch (e) { if (call === latest.current) setError(errorMessage(e)); }
  }, [schoolId, date]);
  useEffect(() => { void load(); }, [load]);
  const changed = useMemo(() => (d ? d.items.filter((i) => (marks[i.teacher_id] ?? null) !== i.status) : []), [d, marks]);

  async function save() {
    if (!d || changed.length === 0) return;
    setBusy(true);
    try {
      const r = await apiFetch<AttendanceDay>("/hr/attendance", { schoolId, method: "PUT", body: { date, entries: changed.map((i) => ({ teacher_id: i.teacher_id, status: marks[i.teacher_id] ?? null })) } });
      setD(r); setMarks(Object.fromEntries(r.items.map((i) => [i.teacher_id, i.status]))); toast.success(`Attendance saved for ${formatDate(date)}.`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  const readOnly = !d || d.locked || d.future;
  return (
    <Section title={d ? formatDate(d.date) : "Attendance"} testId="register"
      action={
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDate(shift(date, -1))} aria-label="Previous day"><ChevronLeft className="size-4" /></Button>
          <TextField label="Date" className="w-40 [&_label]:sr-only" type="date" value={date} max={todayISO()} onChange={(e) => e.target.value && setDate(e.target.value)} data-testid="att-date" />
          <Button variant="ghost" size="sm" onClick={() => setDate(shift(date, 1))} disabled={date >= todayISO()} aria-label="Next day"><ChevronRight className="size-4" /></Button>
        </div>
      }>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div> : !d ? <LoadingState /> : (
        <>
          {(d.locked || d.future || !d.working) && (
            <p className="border-b border-line bg-pencil-100/60 px-5 py-2.5 text-sm" data-testid="att-notice">
              {d.future ? "This date is in the future." : d.locked ? "Payroll for this month is finalized, so its attendance is locked." : d.holiday ? `Holiday: ${d.holiday}. Not a working day.` : "A weekly off. Not a working day."}
            </p>
          )}
          {d.items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No active staff on this date.</p> : (
            <>
              {!readOnly && d.working && (
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2.5 text-sm">
                  <Button size="sm" variant="secondary" data-testid="mark-all-present"
                    onClick={() => setMarks((m) => Object.fromEntries(d.items.map((i) => [i.teacher_id, i.leave_id && !i.leave_half_day ? (m[i.teacher_id] ?? null) : (m[i.teacher_id] ?? "present")])))}>
                    Mark the rest present
                  </Button>
                  <span className="text-muted">Unmarked days count as the payroll setting says (present, unless changed).</span>
                </div>
              )}
              <ul className="divide-y divide-line" data-testid="att-list">
                {d.items.map((i) => (
                  <li key={i.teacher_id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm" data-testid={`att-${i.employee_id}`}>
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="font-medium">{i.full_name} <span className="text-xs font-normal text-muted">{i.employee_id}</span></p>
                      {i.leave_id && <p className="text-xs"><Pill tone={i.leave_paid ? "ok" : "warn"} testId="on-leave">On {i.leave_type}{i.leave_half_day ? " (half day)" : ""}</Pill></p>}
                    </div>
                    <div className="flex gap-1" role="radiogroup" aria-label={`Attendance for ${i.full_name}`}>
                      {STATUSES.map((s) => (
                        <button key={s} type="button" role="radio" aria-checked={marks[i.teacher_id] === s} disabled={readOnly || !d.working} data-testid={`att-${s}`}
                          onClick={() => setMarks((m) => ({ ...m, [i.teacher_id]: m[i.teacher_id] === s ? null : s }))}
                          className={clsx("rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50",
                            marks[i.teacher_id] === s ? (s === "present" ? "border-leaf-600 bg-leaf-50 text-leaf-700" : s === "absent" ? "border-danger-600 bg-danger-50 text-danger-600" : "border-pencil-400 bg-pencil-100") : "border-line text-muted hover:text-ink")}>
                          {ATTENDANCE_LABEL[s]}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              {!readOnly && d.working && (
                <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3">
                  <span className="text-sm text-muted">{changed.length ? `${changed.length} change${changed.length === 1 ? "" : "s"}` : "No changes"}</span>
                  <Button onClick={save} loading={busy} disabled={changed.length === 0} data-testid="save-attendance">Save</Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Section>
  );
}

function MonthSummary({ schoolId }: { schoolId: string }) {
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [d, setD] = useState<AttendanceMonth | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setD(null); apiFetch<AttendanceMonth>("/hr/attendance/month", { schoolId, query: { month: `${month}-01` } }).then(setD).catch((e) => setError(errorMessage(e))); }, [schoolId, month]);
  return (
    <Section title={`Month: ${monthName(`${month}-01`)}`} description="Marked days. Approved leave and loss of pay are worked out in Payroll."
      action={<TextField label="Month" className="w-40 [&_label]:sr-only" type="month" value={month} max={todayISO().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />} testId="month-summary">
      {error ? <div className="p-4"><ErrorState message={error} /></div> : !d ? <LoadingState /> : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs text-muted"><tr><th className="px-4 py-2 font-medium">Staff</th><th className="px-3 py-2 text-right font-medium">Present</th><th className="px-3 py-2 text-right font-medium">Absent</th><th className="px-3 py-2 text-right font-medium">Half days</th></tr></thead>
            <tbody className="divide-y divide-line">
              {d.items.map((r) => (
                <tr key={r.teacher_id}><td className="px-4 py-2">{r.full_name} <span className="text-xs text-muted">{r.employee_id}</span></td>
                  <td className="tabular px-3 py-2 text-right">{r.present_days}</td><td className={clsx("tabular px-3 py-2 text-right", r.absent_days > 0 && "text-danger-600")}>{r.absent_days}</td><td className="tabular px-3 py-2 text-right">{r.half_days}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function StaffAttendance() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  return (
    <>
      <PageHeader title="Staff attendance" description="Mark staff present, absent or on a half day. Payroll uses it for loss of pay, together with approved leave." />
      <div className="space-y-6">
        <Register schoolId={schoolId} />
        <MonthSummary schoolId={schoolId} />
        <p className="text-xs text-muted">Weekly offs and holidays are set in <Link href="/staff-leave?tab=Holidays%20%26%20week" className="underline">Staff leave</Link>{can("payroll:manage") ? <>; how unmarked days count is set in <Link href="/payroll?tab=Settings" className="underline">Payroll</Link></> : null}.</p>
      </div>
    </>
  );
}

export default function Page() {
  return <RequirePermission permission="hr:manage"><StaffAttendance /></RequirePermission>;
}
