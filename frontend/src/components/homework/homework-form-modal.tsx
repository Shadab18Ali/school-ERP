"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { toLocalInput } from "@/lib/format";
import type { HomeworkDetail, HomeworkKind, SettableSection, Subject } from "@/lib/types";
import { ACCEPT, FILE_HINT } from "./shared";

const area = "mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20";

function tomorrowAt5() {
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(17, 0, 0, 0);
  return toLocalInput(d.toISOString());
}

/** Create (with optional files) or edit a homework / assignment. */
export function HomeworkFormModal({ schoolId, open, onClose, onSaved, editing, defaults }: {
  schoolId: string; open: boolean; onClose: () => void; onSaved: (h: HomeworkDetail) => void;
  editing?: HomeworkDetail | null; defaults?: { sectionId?: string; kind?: HomeworkKind };
}) {
  const [sections, setSections] = useState<SettableSection[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [f, setF] = useState({ section: "", kind: "homework" as HomeworkKind, subject: "", title: "", description: "", due: "", max: "", late: false });
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setErrors({}); setError(null); setFiles([]);
    if (editing) {
      setF({ section: editing.section_id, kind: editing.kind, subject: editing.subject_id ?? "", title: editing.title, description: editing.description,
        due: toLocalInput(editing.due_at), max: editing.max_marks ?? "", late: editing.allow_late });
    } else {
      setF({ section: defaults?.sectionId ?? "", kind: defaults?.kind ?? "homework", subject: "", title: "", description: "", due: tomorrowAt5(), max: "", late: false });
      apiFetch<SettableSection[]>("/homework/sections", { schoolId }).then(setSections).catch(() => setSections([]));
    }
    apiFetch<Subject[]>("/timetable/subjects", { schoolId }).then(setSubjects).catch(() => setSubjects([]));
  }, [open, editing, defaults?.sectionId, defaults?.kind, schoolId]);

  // Choosing a class picks the subject the teacher teaches there, when it is unambiguous.
  useEffect(() => {
    if (editing || f.subject) return;
    const sec = sections.find((s) => s.section_id === f.section);
    if (sec?.subjects.length === 1) {
      const match = subjects.find((s) => s.name.toLowerCase() === sec.subjects[0].toLowerCase());
      if (match) setF((x) => ({ ...x, subject: match.id }));
    }
  }, [f.section, sections, subjects, editing, f.subject]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    const errs: Record<string, string> = {};
    if (!editing && !f.section) errs.section = "Choose a class.";
    if (f.title.trim().length < 2) errs.title = "Enter a title.";
    if (!f.due) errs.due = "Choose the deadline.";
    else if (new Date(f.due).getTime() <= Date.now() && (!editing || toLocalInput(editing.due_at) !== f.due)) errs.due = "The deadline must be in the future.";
    if (f.max && !(Number(f.max) > 0 && Number(f.max) <= 1000)) errs.max = "Between 0 and 1000.";
    if (files.length > 5) errs.files = "Attach at most 5 files at a time.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true); setError(null);
    const body = { kind: f.kind, subject_id: f.subject || null, title: f.title, description: f.description, due_at: new Date(f.due).toISOString(),
      max_marks: f.max || null, allow_late: f.late };
    try {
      let saved: HomeworkDetail;
      if (editing) {
        const patch: Record<string, unknown> = { ...body };
        if (toLocalInput(editing.due_at) === f.due) delete patch.due_at; // unchanged: don't re-check a deadline that has passed
        saved = await apiFetch<HomeworkDetail>(`/homework/${editing.id}`, { schoolId, method: "PATCH", body: patch });
      } else {
        saved = await apiFetch<HomeworkDetail>("/homework", { schoolId, method: "POST", body: { ...body, section_id: f.section } });
        if (files.length) {
          const form = new FormData();
          files.forEach((x) => form.append("files", x));
          try { saved = await apiFetch<HomeworkDetail>(`/homework/${saved.id}/attachments`, { schoolId, method: "POST", body: form }); }
          catch (e) { toast.error(`Published, but the files weren't attached: ${errorMessage(e)}`); }
        }
      }
      onSaved(saved);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" onClose={busy ? () => {} : onClose} title={editing ? "Edit" : "Set homework or an assignment"}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-homework">{editing ? "Save" : "Publish"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {editing ? (
          <p className="text-sm sm:col-span-2"><span className="text-muted">Class:</span> {editing.class_name} – {editing.section_name}</p>
        ) : (
          <div>
            <SelectField label="Class" value={f.section} onChange={set("section")} aria-invalid={errors.section ? true : undefined}>
              <option value="">Choose class</option>
              {sections.map((s) => <option key={s.section_id} value={s.section_id}>{s.class_name} – {s.section_name}</option>)}
            </SelectField>
            {errors.section && <p className="mt-1 text-xs text-danger-600">{errors.section}</p>}
            {sections.length === 0 && <p className="mt-1 text-xs text-muted">No classes are assigned to you in the current session.</p>}
          </div>
        )}
        <SelectField label="Type" value={f.kind} onChange={set("kind")}>
          <option value="homework">Homework</option>
          <option value="assignment">Assignment</option>
        </SelectField>
        <TextField label="Title" required maxLength={150} value={f.title} onChange={set("title")} error={errors.title} className="sm:col-span-2" />
        <SelectField label="Subject" value={f.subject} onChange={set("subject")}>
          <option value="">No subject</option>
          {subjects.filter((s) => s.is_active || s.id === f.subject).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </SelectField>
        <TextField label="Deadline" required type="datetime-local" value={f.due} onChange={set("due")} error={errors.due} />
        <label className="block text-sm font-medium sm:col-span-2">Description
          <textarea value={f.description} maxLength={5000} rows={5} onChange={set("description")} className={area}
            placeholder="What students should do, pages, questions, how to submit…" />
        </label>
        <TextField label="Maximum marks" inputMode="decimal" value={f.max} onChange={set("max")} error={errors.max} hint="Leave empty if it isn't marked" />
        <label className="flex items-start gap-2 self-center text-sm">
          <input type="checkbox" checked={f.late} onChange={(e) => setF({ ...f, late: e.target.checked })} className="mt-0.5 size-4 accent-leaf-600" />
          <span>Accept late submissions<span className="block text-xs text-muted">Late work is marked as late.</span></span>
        </label>
        {!editing && (
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium" htmlFor="homework-files">Files for students</label>
            <input id="homework-files" type="file" multiple accept={ACCEPT} onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              className="mt-1.5 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-leaf-50 file:px-3 file:py-2 file:text-sm file:font-medium" />
            <p className="mt-1 text-xs text-muted">{errors.files ?? FILE_HINT}</p>
          </div>
        )}
        {error && <p className="text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="homework-form-error">{error}</p>}
      </div>
    </Modal>
  );
}
