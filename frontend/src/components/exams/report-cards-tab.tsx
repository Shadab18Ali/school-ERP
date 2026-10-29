"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { ExamDetail, ExamSection, RemarksSheet, ReportCardTemplate } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";
import { PdfButton, ResultBadge } from "./shared";

const area = "w-full rounded-md border border-line px-2.5 py-1.5 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20 disabled:bg-paper";
type Vals = Record<string, { teacher: string; principal: string }>;

/** An exam's report cards: which template, remarks per student, and the PDFs. */
export function ReportCardsTab({ schoolId, exam, sections, initial, onExamChange }: {
  schoolId: string; exam: ExamDetail; sections: ExamSection[]; initial?: string; onExamChange: (x: ExamDetail) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can("exams:manage") && can("report_cards:manage");
  const [templates, setTemplates] = useState<ReportCardTemplate[]>([]);
  const [section, setSection] = useState(initial && sections.some((s) => s.section_id === initial) ? initial : sections[0]?.section_id ?? "");
  const [sheet, setSheet] = useState<RemarksSheet | null>(null);
  const [vals, setVals] = useState<Vals>({});
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (manage) apiFetch<ReportCardTemplate[]>("/report-cards/templates", { schoolId }).then(setTemplates).catch(() => setTemplates([]));
  }, [manage, schoolId]);

  const load = useCallback(async () => {
    if (!section) return;
    const mine = ++latest.current;
    setError(null); setSaveError(null);
    setSheet((s) => (s && s.section.id !== section ? null : s));
    try {
      const r = await apiFetch<RemarksSheet>(`/exams/${exam.id}/remarks`, { schoolId, query: { section_id: section } });
      if (mine !== latest.current) return;
      setSheet(r);
      setVals(Object.fromEntries(r.students.map((s) => [s.enrollment_id, { teacher: s.teacher_remarks ?? "", principal: s.principal_remarks ?? "" }])));
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [exam.id, schoolId, section]);
  useEffect(() => { void load(); }, [load, exam.status]);

  async function chooseTemplate(id: string) {
    try {
      onExamChange(await apiFetch<ExamDetail>(`/exams/${exam.id}`, { schoolId, method: "PATCH", body: { report_card_template_id: id || null } }));
      toast.success("Template chosen for this exam.");
    } catch (e) { toast.error(errorMessage(e)); }
  }
  const dirty = sheet ? sheet.students.some((s) => {
    const v = vals[s.enrollment_id];
    return v && (v.teacher.trim() !== (s.teacher_remarks ?? "") || v.principal.trim() !== (s.principal_remarks ?? ""));
  }) : false;

  async function save() {
    if (!sheet) return;
    setBusy(true); setSaveError(null);
    try {
      const r = await apiFetch<RemarksSheet & { saved: number }>(`/exams/${exam.id}/remarks`, { schoolId, method: "PUT", body: {
        section_id: section,
        entries: sheet.students.map((s) => ({
          enrollment_id: s.enrollment_id,
          ...(sheet.can_edit_teacher ? { teacher_remarks: vals[s.enrollment_id].teacher } : {}),
          ...(sheet.can_edit_principal ? { principal_remarks: vals[s.enrollment_id].principal } : {}),
        })),
      } });
      setSheet(r);
      setVals(Object.fromEntries(r.students.map((s) => [s.enrollment_id, { teacher: s.teacher_remarks ?? "", principal: s.principal_remarks ?? "" }])));
      toast.success(`Remarks saved for ${r.saved} student${r.saved === 1 ? "" : "s"}.`);
    } catch (e) { setSaveError(errorMessage(e)); } finally { setBusy(false); }
  }

  if (sections.length === 0) return <p className="p-5 text-sm text-muted">No classes to show.</p>;
  const editable = !!sheet && (sheet.can_edit_teacher || sheet.can_edit_principal);
  const current = templates.find((t) => t.id === exam.report_card_template_id);
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <SelectField label="Class" value={section} onChange={(e) => setSection(e.target.value)}>
          {sections.map((s) => <option key={s.section_id} value={s.section_id}>{s.class_name} – {s.section_name}</option>)}
        </SelectField>
        {manage && (
          <div>
            <SelectField label="Report card template" value={exam.report_card_template_id ?? ""} onChange={(e) => chooseTemplate(e.target.value)}>
              <option value="">Default ({templates.find((t) => t.is_default)?.name ?? "Standard"})</option>
              {templates.filter((t) => !t.is_default).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </SelectField>
          </div>
        )}
        {manage && <Link href="/report-cards" className="mb-2.5 text-sm font-medium text-leaf-700 hover:underline">Edit templates</Link>}
        <span className="flex-1" />
        {sheet && sheet.students.length > 0 && (
          <PdfButton path={`/exams/${exam.id}/results/report-cards.pdf`} query={{ section_id: section }} schoolId={schoolId} name="report-cards.pdf"
            testId="all-report-cards" size="md">All report cards</PdfButton>
        )}
      </div>
      {manage && current === undefined && exam.report_card_template_id && <p className="px-4 pt-3 text-xs text-muted">Template not found; the default is used.</p>}
      {exam.status !== "published" && (
        <p className="border-b border-line bg-pencil-100/40 px-4 py-2 text-sm">
          Report cards can be printed any time; students and parents get theirs once results are published. Remarks lock on publication.
        </p>
      )}
      {error ? <ErrorState message={error} onRetry={load} /> : !sheet ? <LoadingState /> : sheet.students.length === 0 ? <p className="p-4 text-sm text-muted">No students in this class.</p> : (
        <>
          {saveError && <p className="mx-4 mt-3 rounded-md bg-danger-50 p-3 text-sm text-danger-600" role="alert" data-testid="remarks-error">{saveError}</p>}
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm" data-testid="remarks-sheet">
              <thead className="bg-paper text-left text-xs text-muted">
                <tr><th className="px-4 py-2">Student</th><th className="px-4 py-2">Result</th><th className="w-[32%] px-4 py-2">Class teacher&apos;s remarks</th>
                  <th className="w-[32%] px-4 py-2">Principal&apos;s remarks</th><th className="px-4 py-2"><span className="sr-only">Report card</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sheet.students.map((s) => {
                  const v = vals[s.enrollment_id] ?? { teacher: "", principal: "" };
                  return (
                    <tr key={s.enrollment_id} className="align-top" data-testid={`remarks-row-${s.admission_number}`}>
                      <td className="px-4 py-2"><span className="font-medium">{s.full_name}</span><span className="block text-xs text-muted">{s.admission_number}</span></td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs">
                        {s.result ? <><ResultBadge result={s.result} /><span className="mt-1 block text-muted">{s.percentage ? `${s.percentage}%` : ""}{s.grade ? ` · ${s.grade}` : ""}</span></> : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <textarea aria-label={`Class teacher's remarks for ${s.full_name}`} rows={2} maxLength={500} disabled={!sheet.can_edit_teacher}
                          value={v.teacher} onChange={(e) => setVals({ ...vals, [s.enrollment_id]: { ...v, teacher: e.target.value } })} className={area} />
                      </td>
                      <td className="px-4 py-2">
                        <textarea aria-label={`Principal's remarks for ${s.full_name}`} rows={2} maxLength={500} disabled={!sheet.can_edit_principal}
                          value={v.principal} onChange={(e) => setVals({ ...vals, [s.enrollment_id]: { ...v, principal: e.target.value } })} className={area}
                          placeholder={sheet.can_edit_principal ? "" : "Written by the principal's office"} />
                      </td>
                      <td className="px-4 py-2 text-right">
                        <PdfButton path={`/exams/${exam.id}/results/report-cards.pdf`} query={{ section_id: section, student_id: s.student_id }} schoolId={schoolId}
                          name={`report-card-${s.full_name}.pdf`} testId={`card-${s.admission_number}`}>PDF</PdfButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 px-4 py-3">
            {editable ? <Button onClick={save} loading={busy} disabled={!dirty} data-testid="save-remarks">Save remarks</Button>
              : <span className="text-sm text-muted" data-testid="remarks-locked">{exam.status === "published" ? "Results are published, so remarks are locked." : "You can't change these remarks."}</span>}
            <span className="text-xs text-muted">Up to 500 characters each. Teachers write the class teacher&apos;s remarks; only school admins write the principal&apos;s.</span>
          </div>
        </>
      )}
    </div>
  );
}
