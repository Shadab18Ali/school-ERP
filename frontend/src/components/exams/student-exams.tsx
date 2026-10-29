"use client";

import { FileCheck2, GraduationCap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { StudentExam } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";
import { DateSheet, ExamStatusBadge, PdfButton, ResultCard } from "./shared";

/**
 * A student's exams, for the student (`base` = /my) or a parent (`base` = /portal/children/{id}).
 * "schedule": date sheets; "results": published results; "both": results first, then upcoming date sheets.
 */
export function StudentExams({ base, mode }: { base: string; mode: "schedule" | "results" | "both" }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [items, setItems] = useState<StudentExam[] | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<StudentExam[]>(`${base}/exams`, { schoolId })); }
    catch (e) { setError({ message: errorMessage(e), missing: e instanceof ApiError && e.status === 404 }); }
  }, [base, schoolId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return error.missing
    ? <p className="rounded-lg border border-line bg-white p-6 text-sm text-muted" data-testid="exams-missing">Not enrolled in a class this session, so there are no exams.</p>
    : <ErrorState message={error.message} onRetry={load} />;
  if (!items) return <LoadingState />;

  const published = items.filter((x) => x.status === "published");
  const upcoming = items.filter((x) => x.status === "scheduled");
  const showResults = mode !== "schedule";
  const showSchedule = mode !== "results";
  const nothing = (showResults ? published.length : 0) + (showSchedule ? (mode === "both" ? upcoming.length : items.length) : 0) === 0;
  if (nothing) return (
    <div className="rounded-lg border border-line bg-white" data-testid="exams-empty">
      <EmptyState icon={mode === "schedule" ? FileCheck2 : GraduationCap} title={mode === "schedule" ? "No exams scheduled" : "No results yet"}
        message={mode === "schedule" ? "When the school publishes a date sheet, it appears here." : "Results appear here once the school publishes them."} />
    </div>
  );

  return (
    <div className="space-y-6">
      {showResults && published.map((x) => (
        <section key={x.id} className="rounded-lg border border-line bg-white" data-testid={`exam-result-${x.name}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div><h2 className="font-semibold">{x.name}</h2><p className="text-xs text-muted">{x.type_name} · Session {x.session_name}</p></div>
            {x.result && <PdfButton path={`${base}/exams/${x.id}/report-card.pdf`} schoolId={schoolId} name="report-card.pdf" testId="download-report-card">Report card</PdfButton>}
          </div>
          {x.result ? <ResultCard r={x.result} outOf={x.out_of} /> : <p className="p-5 text-sm text-muted">No result recorded.</p>}
          {(x.teacher_remarks || x.principal_remarks) && (
            <div className="grid gap-px border-t border-line bg-line sm:grid-cols-2" data-testid="exam-remarks">
              <div className="bg-white px-5 py-3"><p className="text-xs font-medium text-muted">Class teacher&apos;s remarks</p><p className="text-sm" data-testid="teacher-remarks">{x.teacher_remarks ?? "—"}</p></div>
              <div className="bg-white px-5 py-3"><p className="text-xs font-medium text-muted">Principal&apos;s remarks</p><p className="text-sm" data-testid="principal-remarks">{x.principal_remarks ?? "—"}</p></div>
            </div>
          )}
        </section>
      ))}
      {showSchedule && (mode === "both" ? upcoming : items).map((x) => {
        const dates = x.papers.map((p) => p.exam_date).sort();
        return (
          <section key={`s-${x.id}`} className="rounded-lg border border-line bg-white" data-testid={`exam-schedule-${x.name}`}>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
              <h2 className="font-semibold">{x.name}</h2><ExamStatusBadge status={x.status} />
              <span className="text-xs text-muted">{dates.length ? `${formatDate(dates[0])} – ${formatDate(dates[dates.length - 1])}` : ""}</span>
            </div>
            <DateSheet papers={x.papers} showClass={false} testId="my-date-sheet" />
          </section>
        );
      })}
    </div>
  );
}
