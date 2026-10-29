"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import type { ClassList, ExamDetail, ExamPaper, SchoolClass, Subject } from "@/lib/types";

/** Add a paper to the date sheet (for one or several classes at once), or edit one. */
export function PaperModal({ schoolId, exam, open, editing, onClose, onSaved }: {
  schoolId: string; exam: ExamDetail; open: boolean; editing: ExamPaper | null; onClose: () => void; onSaved: (x: ExamDetail) => void;
}) {
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [f, setF] = useState({ subject: "", date: "", start: "09:00", end: "12:00", max: "100", pass: "33" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editing) {
      setF({ subject: editing.subject_id, date: editing.exam_date, start: editing.start_time, end: editing.end_time, max: editing.max_marks, pass: editing.pass_marks });
      setPicked([editing.class_id]);
    } else {
      setF((x) => ({ ...x, subject: "", date: x.date || "" }));
      setPicked([]);
      apiFetch<ClassList>("/classes", { schoolId, query: { session_id: exam.academic_session_id, status: "active" } })
        .then((r) => setClasses(r.items)).catch(() => setClasses([]));
    }
    apiFetch<Subject[]>("/timetable/subjects", { schoolId }).then(setSubjects).catch(() => setSubjects([]));
  }, [open, editing, schoolId, exam.academic_session_id]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    if (!editing && picked.length === 0) { setError("Choose at least one class."); return; }
    if (!f.subject) { setError("Choose the subject."); return; }
    if (!f.date) { setError("Choose the date."); return; }
    if (!f.start || !f.end || f.end <= f.start) { setError("The paper must end after it starts."); return; }
    const mx = Number(f.max), ps = Number(f.pass);
    if (!(mx > 0 && mx <= 1000)) { setError("Maximum marks must be between 0 and 1000."); return; }
    if (!(ps >= 0) || ps > mx) { setError("Passing marks must be between 0 and the maximum."); return; }
    setBusy(true); setError(null);
    const body = { subject_id: f.subject, exam_date: f.date, start_time: f.start, end_time: f.end, max_marks: f.max, pass_marks: f.pass };
    try {
      onSaved(editing
        ? await apiFetch<ExamDetail>(`/exams/${exam.id}/papers/${editing.id}`, { schoolId, method: "PATCH", body })
        : await apiFetch<ExamDetail>(`/exams/${exam.id}/papers`, { schoolId, method: "POST", body: { ...body, class_ids: picked } }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" onClose={busy ? () => {} : onClose} title={editing ? `Edit paper · ${editing.class_name}` : "Add paper"}
      description={editing ? undefined : "Add the same paper for several classes at once."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-paper">Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {!editing && (
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-sm font-medium">Classes</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2" data-testid="paper-classes">
              {classes.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="size-4 accent-leaf-600" checked={picked.includes(c.id)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />{c.name}
                </label>
              ))}
              {classes.length === 0 && <span className="text-sm text-muted">No active classes in this session.</span>}
            </div>
          </fieldset>
        )}
        <SelectField label="Subject" value={f.subject} onChange={set("subject")}>
          <option value="">Choose subject</option>
          {subjects.filter((s) => s.is_active || s.id === f.subject).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </SelectField>
        <TextField label="Date" type="date" value={f.date} min={exam.session_start} max={exam.session_end} onChange={set("date")} />
        <TextField label="Starts" type="time" value={f.start} onChange={set("start")} />
        <TextField label="Ends" type="time" value={f.end} onChange={set("end")} />
        <TextField label="Maximum marks" inputMode="decimal" value={f.max} onChange={set("max")} />
        <TextField label="Passing marks" inputMode="decimal" value={f.pass} onChange={set("pass")} />
        {subjects.length === 0 && <p className="text-sm text-muted sm:col-span-2">No subjects yet. Add them under Timetable → Setup.</p>}
        {error && <p className="text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="paper-error">{error}</p>}
      </div>
    </Modal>
  );
}
