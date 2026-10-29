"use client";

import { clsx } from "clsx";
import { ArrowLeft, BookOpen, Star } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { STATUS_TONE } from "@/components/attendance/student-attendance";
import { RequirePermission } from "@/components/auth/require-permission";
import { ClassExams } from "@/components/exams/class-exams";
import { StaffHomeworkList } from "@/components/homework/staff-homework-list";
import { TimetablePanel } from "@/components/timetable/timetable-grid";
import { NoticeList } from "@/components/portal/notice-list";
import { StudentAvatar } from "@/components/students/student-avatar";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { todayISO } from "@/lib/format";
import { ATTENDANCE_LABELS, type AttendanceStatus } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const TABS = ["Students", "Attendance", "Homework", "Assignments", "Timetable", "Exams", "Marks", "Notices"] as const;
type Tab = (typeof TABS)[number];

interface Student { student_id: string; enrollment_id: string; full_name: string; student_code: string; admission_number: string; gender: string;
  photo_url: string | null; present: number; marked: number; attendance_percentage: string | null; today: AttendanceStatus | null }
interface Section { section_id: string; class_name: string; section_name: string; session_name: string; session_is_archived: boolean;
  subjects: string[]; is_class_teacher: boolean; students: Student[] }

function ClassView({ sectionId }: { sectionId: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [d, setD] = useState<Section | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>("Students");
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch<Section>(`/teaching/sections/${sectionId}`, { schoolId })); }
    catch (e) { setError({ message: errorMessage(e), notFound: e instanceof ApiError && (e.status === 404 || e.status === 422) }); }
  }, [sectionId, schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error.notFound ? "This class isn't assigned to you." : error.message} onRetry={error.notFound ? undefined : load} />;
  if (!d) return <LoadingState />;
  const markedToday = d.students.filter((s) => s.today).length;
  return (
    <>
      <Link href="/teaching" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> My classes</Link>
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{d.class_name} – {d.section_name}</h1>
          {d.is_class_teacher && <span className="inline-flex items-center gap-1 rounded-full bg-pencil-100 px-2 py-0.5 text-xs"><Star className="size-3" aria-hidden /> Class teacher</span>}
        </div>
        <p className="text-sm text-muted">Session {d.session_name}{d.subjects.length ? ` · ${d.subjects.join(", ")}` : ""} · {d.students.length} students</p>
      </div>
      <div role="tablist" aria-label="Class" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>
      {tab === "Students" || tab === "Attendance" ? (
        <section className="rounded-lg border border-line bg-white">
          {tab === "Attendance" && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
              <p className="text-sm" data-testid="section-today">Today: {markedToday} of {d.students.length} marked</p>
              {!d.session_is_archived && <Link href={`/attendance?section=${d.section_id}&date=${todayISO()}`} className="text-sm font-medium text-leaf-700 hover:underline">Mark attendance</Link>}
            </div>
          )}
          {d.students.length === 0 ? <EmptyState icon={BookOpen} title="No students yet" message="Students appear here once they are admitted to this section." /> : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm" data-testid="section-students">
                <thead className="bg-paper text-left text-xs font-medium text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Student</th>
                    <th scope="col" className="px-4 py-2.5">Adm. no.</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Attendance</th>
                    <th scope="col" className="px-4 py-2.5">Today</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.students.map((s) => (
                    <tr key={s.enrollment_id} data-testid={`section-student-${s.admission_number}`}>
                      <td className="px-4 py-2"><Link href={`/students/${s.student_id}`} className="flex items-center gap-3">
                        <StudentAvatar name={s.full_name} url={s.photo_url} />
                        <span><span className="block font-medium hover:underline">{s.full_name}</span><span className="text-xs text-muted">{s.student_code}</span></span></Link></td>
                      <td className="px-4 py-2">{s.admission_number}</td>
                      <td className={clsx("tabular px-4 py-2 text-right", s.attendance_percentage !== null && Number(s.attendance_percentage) < 75 && "text-danger-600")}>
                        {s.attendance_percentage ? `${s.attendance_percentage}%` : "—"}<span className="block text-xs text-muted">{s.present}/{s.marked} days</span></td>
                      <td className="px-4 py-2">{s.today ? <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[s.today])}>{ATTENDANCE_LABELS[s.today]}</span> : <span className="text-xs text-muted">Not marked</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : tab === "Notices" ? <NoticeList schoolId={schoolId} />
        : tab === "Exams" ? <ClassExams schoolId={schoolId} sectionId={sectionId} mode="schedule" />
        : tab === "Marks" ? <ClassExams schoolId={schoolId} sectionId={sectionId} mode="marks" />
        : tab === "Homework" ? <StaffHomeworkList schoolId={schoolId} sectionId={sectionId} kind="homework" />
        : tab === "Assignments" ? <StaffHomeworkList schoolId={schoolId} sectionId={sectionId} kind="assignment" />
        : tab === "Timetable" ? <TimetablePanel path={`/timetable/sections/${sectionId}`} schoolId={schoolId} />
        : null}
    </>
  );
}

export default function TeachingClassPage({ params }: { params: Promise<{ sectionId: string }> }) {
  const { sectionId } = use(params);
  return <RequirePermission permission="teaching:view"><ClassView sectionId={sectionId} /></RequirePermission>;
}
