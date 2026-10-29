"use client";

import { clsx } from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { SelectField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import type { ExamDetail, ExamSection, SectionResults } from "@/lib/types";
import { PdfButton, ResultBadge } from "./shared";

/** A section's results: calculated by the database (totals, %, grade, pass/fail, rank). */
export function ResultsView({ schoolId, exam, sections, initial }: { schoolId: string; exam: ExamDetail; sections: ExamSection[]; initial?: string }) {
  const [section, setSection] = useState(initial && sections.some((s) => s.section_id === initial) ? initial : sections[0]?.section_id ?? "");
  const [d, setD] = useState<SectionResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!section) return;
    const mine = ++latest.current;
    setError(null);
    try { const r = await apiFetch<SectionResults>(`/exams/${exam.id}/results`, { schoolId, query: { section_id: section } }); if (mine === latest.current) setD(r); }
    catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [exam.id, section, schoolId]);
  useEffect(() => { void load(); }, [load]);

  if (sections.length === 0) return <p className="p-5 text-sm text-muted">No classes to show.</p>;
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4 print:hidden">
        <SelectField label="Class" value={section} onChange={(e) => setSection(e.target.value)}>
          {sections.map((s) => <option key={s.section_id} value={s.section_id}>{s.class_name} – {s.section_name}</option>)}
        </SelectField>
        {d && d.rows.length > 0 && (
          <div className="flex gap-2">
            <PdfButton path={`/exams/${exam.id}/results/pdf`} query={{ section_id: section }} schoolId={schoolId} name="result-sheet.pdf" testId="result-sheet-pdf">Result sheet</PdfButton>
            <PdfButton path={`/exams/${exam.id}/results/report-cards.pdf`} query={{ section_id: section }} schoolId={schoolId} name="report-cards.pdf" testId="report-cards-pdf">All report cards</PdfButton>
          </div>
        )}
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : !d ? <LoadingState /> : (
        <>
          <dl className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-5" data-testid="results-summary">
            {[["Students", d.summary.students], ["Passed", d.summary.pass], ["Failed", d.summary.fail], ["Incomplete", d.summary.incomplete],
              ["Class average", d.summary.average ? `${d.summary.average}%` : "—"]].map(([k, v]) => (
              <div key={k} className="bg-white px-4 py-3"><dt className="text-xs text-muted">{k}</dt><dd className="tabular text-lg font-semibold" data-testid={`summary-${String(k).toLowerCase()}`}>{v}</dd></div>
            ))}
          </dl>
          {exam.status !== "published" && <p className="border-b border-line bg-pencil-100/40 px-4 py-2 text-sm">Provisional: results aren&apos;t published, so parents and students can&apos;t see them yet.</p>}
          {d.rows.length === 0 ? <p className="p-4 text-sm text-muted">No students in this class.</p> : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm" data-testid="results-table">
                <thead className="bg-paper text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Rank</th><th className="px-3 py-2 text-left">Student</th>
                    {d.papers.map((p) => <th key={p.id} className="px-3 py-2 text-right">{p.subject_name}<span className="block font-normal">/ {p.max_marks}</span></th>)}
                    <th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">%</th><th className="px-3 py-2">Grade</th><th className="px-3 py-2">Result</th>
                    <th className="px-3 py-2 print:hidden"><span className="sr-only">Report card</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.rows.map((r) => (
                    <tr key={r.student_id} data-testid={`result-row-${r.admission_number}`}>
                      <td className="tabular px-3 py-2" data-testid="result-rank">{r.rank ?? "—"}</td>
                      <td className="px-3 py-2"><span className="font-medium">{r.full_name}</span><span className="block text-xs text-muted">{r.admission_number}</span></td>
                      {d.papers.map((p) => {
                        const s = r.subjects.find((x) => x.subject === p.subject_name);
                        return <td key={p.id} className={clsx("tabular px-3 py-2 text-right", s?.passed === false && "font-medium text-danger-600")}>
                          {!s || !s.entered ? <span className="text-muted">—</span> : s.absent ? "AB" : s.marks}</td>;
                      })}
                      <td className="tabular px-3 py-2 text-right font-medium" data-testid="result-total">{r.total ?? "—"}</td>
                      <td className="tabular px-3 py-2 text-right" data-testid="result-percentage">{r.percentage ?? "—"}</td>
                      <td className="px-3 py-2" data-testid="result-grade">{r.grade ?? "—"}</td>
                      <td className="px-3 py-2"><ResultBadge result={r.result} /></td>
                      <td className="px-3 py-2 text-right print:hidden">
                        <PdfButton path={`/exams/${exam.id}/results/report-cards.pdf`} query={{ section_id: section, student_id: r.student_id }} schoolId={schoolId}
                          name={`report-card-${r.full_name}.pdf`} testId={`report-card-${r.admission_number}`}>Report card</PdfButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={clsx("px-4 py-3 text-xs text-muted")}>A subject is passed at or above its passing marks; absent counts as 0 and as not passed. A student passes when every subject is passed. Rank is by percentage within the section (equal percentages share a rank).</p>
        </>
      )}
    </div>
  );
}
