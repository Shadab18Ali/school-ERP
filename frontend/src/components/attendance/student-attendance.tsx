"use client";

import { clsx } from "clsx";
import { useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { monthLabel } from "@/lib/money";
import { ATTENDANCE_LABELS, type AttendanceCounts, type AttendanceStatus } from "@/lib/types";

interface Data {
  session_name: string | null;
  class_section: string | null;
  months: { month: string; present: number; absent: number; leave: number; marked: number; percentage: string | null }[];
  overall: AttendanceCounts;
  records: { date: string; status: AttendanceStatus; remarks: string | null; class_section: string }[];
}

export const STATUS_TONE: Record<AttendanceStatus, string> = {
  present: "bg-leaf-50 text-leaf-700", absent: "bg-danger-50 text-danger-600", leave: "bg-pencil-100 text-ink",
};

/** A student's attendance for the current session: overall %, by month, and the day-by-day history. */
export function StudentAttendancePanel({ studentId, schoolId }: { studentId: string; schoolId: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiFetch<Data>(`/attendance/students/${studentId}`, { schoolId }).then(setD).catch((e) => setError(errorMessage(e)));
  }, [studentId, schoolId]);
  if (error) return <ErrorState message={error} />;
  if (!d) return <LoadingState />;
  if (!d.class_section) return <p className="rounded-lg border border-line bg-white px-6 py-10 text-center text-sm text-muted">Not enrolled in {d.session_name ?? "the current session"}.</p>;
  const exceptions = d.records.filter((r) => r.status !== "present");
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]" role="tabpanel" data-testid="student-attendance">
      <section className="rounded-lg border border-line bg-white p-5">
        <p className="text-xs text-muted">Attendance in {d.session_name} · {d.class_section}</p>
        <p className="tabular mt-1 text-3xl font-semibold" data-testid="student-attendance-pct">{d.overall.percentage ? `${d.overall.percentage}%` : "—"}</p>
        <p className="tabular mt-1 text-sm text-muted">{d.overall.present} present · {d.overall.absent} absent · {d.overall.leave} leave</p>
        <p className="mt-1 text-xs text-muted">Percentage = present ÷ days marked.</p>
        {d.months.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="py-1">Month</th><th className="py-1 text-right">P</th><th className="py-1 text-right">A</th><th className="py-1 text-right">L</th><th className="py-1 text-right">%</th></tr></thead>
            <tbody className="tabular divide-y divide-line">
              {d.months.map((m) => (
                <tr key={m.month}><td className="py-1.5">{monthLabel(m.month)}</td><td className="text-right">{m.present}</td><td className="text-right">{m.absent}</td><td className="text-right">{m.leave}</td><td className="text-right font-medium">{m.percentage ?? "—"}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="rounded-lg border border-line bg-white p-5">
        <h3 className="mb-3 font-semibold">Absences and leave</h3>
        {exceptions.length === 0 ? <p className="text-sm text-muted">{d.records.length ? "Present every day marked so far." : "No attendance marked yet."}</p> : (
          <ul className="divide-y divide-line text-sm">
            {exceptions.map((r) => (
              <li key={r.date} className="flex items-center justify-between gap-3 py-1.5">
                <span>{formatDate(r.date)}{r.remarks ? <span className="text-muted"> · {r.remarks}</span> : null}</span>
                <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[r.status])}>{ATTENDANCE_LABELS[r.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
