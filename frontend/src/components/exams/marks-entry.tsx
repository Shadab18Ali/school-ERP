"use client";

import { clsx } from "clsx";
import { Lock, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { ExamDetail, ExamSection, MarksSheet } from "@/lib/types";

type Val = { marks: string; absent: boolean };

/** Why a typed value is invalid (null = fine). Same rules as the database. */
export function marksProblem(v: Val, max: number): string | null {
  if (v.absent || v.marks.trim() === "") return null;
  const t = v.marks.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return /^-/.test(t) ? "Can't be negative" : /\.\d{3,}$/.test(t) ? "At most 2 decimals" : "Not a number";
  if (Number(t) > max) return `More than ${max}`;
  return null;
}

/** Enter one paper's marks for one section; the whole section is saved in one request. */
export function MarksEntry({ schoolId, exam, sections, initial }: {
  schoolId: string; exam: ExamDetail; sections: ExamSection[]; initial?: { section?: string; paper?: string };
}) {
  const toast = useToast();
  const [section, setSection] = useState(initial?.section && sections.some((s) => s.section_id === initial.section) ? initial.section : sections[0]?.section_id ?? "");
  const sec = sections.find((s) => s.section_id === section);
  const papers = useMemo(() => exam.papers.filter((p) => p.class_id === sec?.class_id), [exam.papers, sec?.class_id]);
  const [paper, setPaper] = useState(initial?.paper ?? "");
  const [sheet, setSheet] = useState<MarksSheet | null>(null);
  const [vals, setVals] = useState<Record<string, Val>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => { // keep the paper valid for the chosen class
    if (!papers.some((p) => p.id === paper)) setPaper(papers[0]?.id ?? "");
  }, [papers, paper]);

  const load = useCallback(async () => {
    if (!section || !paper) { setSheet(null); return; }
    const mine = ++latest.current;
    setError(null); setSaveError(null);
    // a different paper or class: never leave the old grid on screen to be typed into
    setSheet((s) => (s && (s.paper.id !== paper || s.section.id !== section) ? null : s));
    try {
      const s = await apiFetch<MarksSheet>(`/exams/${exam.id}/papers/${paper}/marks`, { schoolId, query: { section_id: section } });
      if (mine !== latest.current) return;
      setSheet(s);
      setVals(Object.fromEntries(s.students.map((r) => [r.enrollment_id, { marks: r.marks ?? "", absent: r.absent }])));
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [exam.id, paper, section, schoolId]);
  // reload on publish/unpublish too: that locks or reopens entry
  useEffect(() => { void load(); }, [load, exam.status]);

  if (sections.length === 0) return <p className="p-5 text-sm text-muted" data-testid="no-sections">No classes to enter marks for. {exam.papers.length === 0 ? "The date sheet is empty." : "None of the classes in this exam are assigned to you."}</p>;

  const max = sheet ? Number(sheet.paper.max_marks) : 0;
  const problems = sheet ? sheet.students.map((r) => marksProblem(vals[r.enrollment_id] ?? { marks: "", absent: false }, max)) : [];
  const dirty = sheet ? sheet.students.some((r) => {
    const v = vals[r.enrollment_id];
    return v && ((r.marks ?? "") !== v.marks.trim() || r.absent !== v.absent);
  }) : false;
  const filled = sheet ? sheet.students.filter((r) => { const v = vals[r.enrollment_id]; return v && (v.absent || v.marks.trim() !== ""); }).length : 0;
  const editable = !!sheet?.can_enter;

  async function save() {
    if (!sheet) return;
    if (problems.some(Boolean)) { setSaveError("Fix the highlighted marks first."); return; }
    setBusy(true); setSaveError(null);
    try {
      const r = await apiFetch<MarksSheet & { saved: { added: number; changed: number; cleared: number } }>(`/exams/${exam.id}/papers/${sheet.paper.id}/marks`, {
        schoolId, method: "PUT", body: { section_id: section, entries: sheet.students.map((s) => {
          const v = vals[s.enrollment_id];
          return { enrollment_id: s.enrollment_id, marks: v.absent || v.marks.trim() === "" ? null : v.marks.trim(), absent: v.absent };
        }) } });
      setSheet(r);
      setVals(Object.fromEntries(r.students.map((x) => [x.enrollment_id, { marks: x.marks ?? "", absent: x.absent }])));
      toast.success(`Marks saved: ${r.saved.added} new, ${r.saved.changed} changed${r.saved.cleared ? `, ${r.saved.cleared} cleared` : ""}.`);
    } catch (e) { setSaveError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[1fr_1fr_auto]">
        <SelectField label="Class" value={section} onChange={(e) => setSection(e.target.value)}>
          {sections.map((s) => <option key={s.section_id} value={s.section_id}>{s.class_name} – {s.section_name} ({s.entered}/{s.expected})</option>)}
        </SelectField>
        <SelectField label="Paper" value={paper} onChange={(e) => setPaper(e.target.value)}>
          {papers.map((p) => <option key={p.id} value={p.id}>{p.subject_name} (out of {p.max_marks})</option>)}
        </SelectField>
        <div className="flex items-end">
          {editable && <Button onClick={save} loading={busy} disabled={!dirty} data-testid="save-marks"><Save className="size-4" /> Save marks</Button>}
        </div>
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : !sheet ? <LoadingState /> : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <span data-testid="marks-progress">{filled} of {sheet.students.length} entered · maximum {sheet.paper.max_marks}, pass {sheet.paper.pass_marks}</span>
            {!editable && (
              <span className="flex items-center gap-1.5 text-muted" data-testid="marks-locked"><Lock className="size-4" />
                {exam.status === "published" ? "Results are published, so marks are locked." : exam.session_is_archived ? "This session is archived." : "You can view these marks but not change them."}
              </span>
            )}
          </div>
          {saveError && <p className="mx-4 mb-3 rounded-md bg-danger-50 p-3 text-sm text-danger-600" role="alert" data-testid="marks-error">{saveError}</p>}
          {sheet.students.length === 0 ? <p className="p-4 text-sm text-muted">No students in this class.</p> : (
            <table className="w-full text-sm" data-testid="marks-sheet">
              <thead className="bg-paper text-left text-xs text-muted">
                <tr><th className="px-4 py-2">Student</th><th className="px-4 py-2">Marks</th><th className="px-4 py-2">Absent</th><th className="px-4 py-2">Result</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sheet.students.map((r, i) => {
                  const v = vals[r.enrollment_id] ?? { marks: "", absent: false };
                  const problem = problems[i];
                  const n = Number(v.marks);
                  const verdict = v.absent ? "Absent" : v.marks.trim() === "" || problem ? "" : n >= Number(sheet.paper.pass_marks) ? "Pass" : "Below pass";
                  return (
                    <tr key={r.enrollment_id} data-testid={`marks-row-${r.admission_number}`}>
                      <td className="px-4 py-2"><span className="font-medium">{r.full_name}</span><span className="block text-xs text-muted">{r.admission_number}</span></td>
                      <td className="px-4 py-2">
                        <input ref={(el) => { inputs.current[i] = el; }} aria-label={`Marks for ${r.full_name}`} inputMode="decimal" disabled={!editable || v.absent}
                          value={v.absent ? "" : v.marks} aria-invalid={problem ? true : undefined}
                          onChange={(e) => setVals({ ...vals, [r.enrollment_id]: { ...v, marks: e.target.value } })}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); inputs.current[i + 1]?.focus(); } }}
                          className={clsx("tabular h-9 w-24 rounded-md border px-2 disabled:bg-paper", problem ? "border-danger-600" : "border-line")} />
                        {problem && <span className="ml-2 text-xs text-danger-600" data-testid="marks-problem">{problem}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <input type="checkbox" className="size-4 accent-leaf-600" aria-label={`${r.full_name} was absent`} disabled={!editable} checked={v.absent}
                          onChange={(e) => setVals({ ...vals, [r.enrollment_id]: { marks: e.target.checked ? "" : v.marks, absent: e.target.checked } })} />
                      </td>
                      <td className={clsx("px-4 py-2 text-xs", verdict === "Below pass" ? "text-danger-600" : "text-muted")}>{verdict}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {editable && <p className="px-4 py-3 text-xs text-muted">Leave a box empty to clear a student&apos;s entry. Press Enter to move to the next student. Results can be published only when every student has marks or is marked absent.</p>}
        </>
      )}
    </div>
  );
}
