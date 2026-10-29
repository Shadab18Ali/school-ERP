"use client";

import { clsx } from "clsx";
import { Download, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { ExamPaper, ExamStatus, ResultStatus, StudentExamResult } from "@/lib/types";

const STATUS: Record<ExamStatus, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "bg-paper text-muted border border-line" },
  scheduled: { label: "Scheduled", tone: "bg-pencil-100 text-ink" },
  published: { label: "Results published", tone: "bg-leaf-600 text-white" },
};
export function ExamStatusBadge({ status }: { status: ExamStatus }) {
  const s = STATUS[status];
  return <span className={clsx("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", s.tone)} data-testid="exam-status">{s.label}</span>;
}

const RESULT: Record<ResultStatus, { label: string; tone: string }> = {
  pass: { label: "Pass", tone: "bg-leaf-50 text-leaf-700" },
  fail: { label: "Fail", tone: "bg-danger-50 text-danger-600" },
  incomplete: { label: "Incomplete", tone: "bg-paper text-muted border border-line" },
};
export function ResultBadge({ result }: { result: ResultStatus }) {
  const r = RESULT[result];
  return <span className={clsx("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", r.tone)} data-testid="result-badge">{r.label}</span>;
}

const dayFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" });
export const day = (iso: string) => dayFmt.format(new Date(`${iso}T00:00:00Z`));

/** Date sheet: one block per class, papers in date order. */
export function DateSheet({ papers, onEdit, onDelete, showClass = true, testId = "date-sheet" }: {
  papers: ExamPaper[]; onEdit?: (p: ExamPaper) => void; onDelete?: (p: ExamPaper) => void; showClass?: boolean; testId?: string;
}) {
  const classes = [...new Map(papers.map((p) => [p.class_id, p.class_name])).entries()];
  if (papers.length === 0) return <p className="p-5 text-sm text-muted" data-testid={`${testId}-empty`}>No papers in the date sheet yet.</p>;
  return (
    <div className="divide-y divide-line" data-testid={testId}>
      {classes.map(([cid, cname]) => (
        <div key={cid} data-testid={`date-sheet-${cname}`}>
          {showClass && <h3 className="bg-paper px-4 py-2 text-sm font-semibold">{cname}</h3>}
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Subject</th><th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2 text-right">Max</th><th className="px-4 py-2 text-right">Pass</th>
                  {papers[0].entered !== undefined && onEdit && <th className="px-4 py-2 text-right">Marks entered</th>}
                  {(onEdit || onDelete) && <th className="px-4 py-2"><span className="sr-only">Actions</span></th>}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {papers.filter((p) => p.class_id === cid).map((p) => (
                  <tr key={p.id} data-testid={`paper-${cname}-${p.subject_name}`}>
                    <td className="tabular whitespace-nowrap px-4 py-2">{day(p.exam_date)}, {formatDate(p.exam_date)}</td>
                    <td className="px-4 py-2 font-medium">{p.subject_name}</td>
                    <td className="tabular whitespace-nowrap px-4 py-2">{p.start_time} – {p.end_time}</td>
                    <td className="tabular px-4 py-2 text-right">{p.max_marks}</td>
                    <td className="tabular px-4 py-2 text-right">{p.pass_marks}</td>
                    {p.entered !== undefined && onEdit && <td className="tabular px-4 py-2 text-right text-muted">{p.entered}/{p.students}</td>}
                    {(onEdit || onDelete) && (
                      <td className="whitespace-nowrap px-4 py-2 text-right print:hidden">
                        {onEdit && <button className="rounded p-1.5 text-muted hover:bg-ink/5" aria-label={`Edit ${cname} ${p.subject_name}`} onClick={() => onEdit(p)}><Pencil className="size-4" /></button>}
                        {onDelete && <button className="rounded p-1.5 text-muted hover:bg-danger-50 hover:text-danger-600" aria-label={`Remove ${cname} ${p.subject_name}`} onClick={() => onDelete(p)}><Trash2 className="size-4" /></button>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PdfButton({ path, schoolId, query, name, children, testId, size = "sm" }: {
  path: string; schoolId: string; query?: Record<string, string>; name: string; children: ReactNode; testId?: string; size?: "sm" | "md";
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { const { blob, filename } = await apiFetchBlob(path, { schoolId, query }); saveBlob(blob, filename ?? name); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  return <Button variant="secondary" size={size} onClick={go} loading={busy} data-testid={testId}><Download className="size-4" /> {children}</Button>;
}

/** One student's result: subjects, total, percentage, grade, result, rank. */
export function ResultCard({ r, outOf, actions }: { r: StudentExamResult; outOf?: number; actions?: ReactNode }) {
  return (
    <div data-testid="result-card">
      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper text-left text-xs text-muted">
            <tr><th className="px-4 py-2">Subject</th><th className="px-4 py-2 text-right">Max</th><th className="px-4 py-2 text-right">Pass</th>
              <th className="px-4 py-2 text-right">Marks</th><th className="px-4 py-2 text-center">Grade</th><th className="px-4 py-2">Result</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {r.subjects.map((s) => (
              <tr key={s.subject} data-testid={`subject-${s.subject}`}>
                <td className="px-4 py-2">{s.subject}</td>
                <td className="tabular px-4 py-2 text-right text-muted">{s.max_marks}</td>
                <td className="tabular px-4 py-2 text-right text-muted">{s.pass_marks}</td>
                <td className={clsx("tabular px-4 py-2 text-right font-medium", s.passed === false && "text-danger-600")} data-testid="subject-marks">
                  {!s.entered ? "—" : s.absent ? "Absent" : s.marks}
                </td>
                <td className="px-4 py-2 text-center">{s.grade ?? "—"}</td>
                <td className="px-4 py-2 text-xs">{s.passed === null ? "—" : s.passed ? "Pass" : <span className="text-danger-600">Fail</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-5" data-testid="result-summary">
        {[
          ["Total", r.total ? `${r.total} / ${r.max_total}` : "—"],
          ["Percentage", r.percentage ? `${r.percentage}%` : "—"],
          ["Grade", r.grade ?? "—"],
          ["Rank", r.rank ? `${r.rank}${outOf ? ` of ${outOf}` : ""}` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="bg-white px-4 py-3"><dt className="text-xs text-muted">{k}</dt><dd className="tabular text-lg font-semibold" data-testid={`result-${k.toLowerCase()}`}>{v}</dd></div>
        ))}
        <div className="flex items-center gap-3 bg-white px-4 py-3"><ResultBadge result={r.result} />{actions}</div>
      </dl>
    </div>
  );
}
