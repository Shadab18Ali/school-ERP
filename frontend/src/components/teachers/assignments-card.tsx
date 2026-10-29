"use client";

import { Plus, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession, ClassList, SchoolClass, TeacherAssignment, TeacherDetail } from "@/lib/types";

/** The classes a teacher may access. Only these sections' students and attendance are visible to them. */
export function AssignmentsCard({ teacher, schoolId, canManage, onChange }: {
  teacher: TeacherDetail; schoolId: string; canManage: boolean; onChange: (t: TeacherDetail) => void;
}) {
  const toast = useToast();
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [adding, setAdding] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [subject, setSubject] = useState("");
  const [classTeacher, setClassTeacher] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeacherAssignment | null>(null);

  useEffect(() => {
    apiFetch<AcademicSession[]>("/sessions", { schoolId }).then((ss) => {
      setSessions(ss);
      setSessionId((ss.find((s) => s.is_current && !s.is_archived) ?? ss.find((s) => !s.is_archived))?.id ?? "");
    }).catch(() => setSessions([]));
  }, [schoolId]);
  useEffect(() => {
    if (!sessionId) return;
    apiFetch<ClassList>("/classes", { schoolId, query: { session_id: sessionId, status: "active" } })
      .then((r) => setClasses(r.items.filter((c) => c.sections.some((s) => s.is_active)))).catch(() => setClasses([]));
  }, [schoolId, sessionId]);

  const sections = classes.find((c) => c.id === classId)?.sections.filter((s) => s.is_active) ?? [];
  const bySession = useMemo(() => {
    const m = new Map<string, TeacherAssignment[]>();
    for (const a of teacher.assignments) m.set(a.session_name, [...(m.get(a.session_name) ?? []), a]);
    return [...m.entries()];
  }, [teacher.assignments]);

  async function add() {
    if (!sectionId) return setError("Choose a class and section.");
    setBusy(true); setError(null);
    try {
      onChange(await apiFetch<TeacherDetail>(`/teachers/${teacher.id}/assignments`, { method: "POST", schoolId,
        body: { section_id: sectionId, subject: subject.trim() || null, is_class_teacher: classTeacher } }));
      toast.success("Class assigned.");
      setSubject(""); setClassTeacher(false); setSectionId("");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  async function toggleClassTeacher(a: TeacherAssignment) {
    try {
      onChange(await apiFetch<TeacherDetail>(`/teachers/${teacher.id}/assignments/${a.id}`, { method: "PATCH", schoolId,
        body: { is_class_teacher: !a.is_class_teacher } }));
    } catch (e) { toast.error(errorMessage(e)); }
  }

  return (
    <section className="rounded-lg border border-line bg-white" data-testid="assignments-card">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div><h2 className="font-semibold">Assigned classes</h2><p className="text-xs text-muted">The teacher can see and mark attendance only for these sections.</p></div>
        {canManage && teacher.status === "active" && !adding && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}><Plus className="size-4" /> Assign class</Button>}
      </div>
      {teacher.status !== "active" && <p className="border-b border-line bg-pencil-100 px-5 py-2.5 text-sm">This teacher is inactive, so they can&apos;t reach any class until reactivated.</p>}
      {adding && (
        <div className="space-y-3 border-b border-line bg-paper/50 p-5">
          {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="assign-error">{error}</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField label="Session" value={sessionId} onChange={(e) => { setSessionId(e.target.value); setClassId(""); setSectionId(""); }}>
              {sessions.filter((s) => !s.is_archived).map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
            </SelectField>
            <SelectField label="Class" value={classId} onChange={(e) => {
              setClassId(e.target.value);
              const only = classes.find((c) => c.id === e.target.value)?.sections.filter((s) => s.is_active);
              setSectionId(only?.length === 1 ? only[0].id : "");
            }}>
              <option value="">Choose class</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
            <SelectField label="Section" value={sectionId} disabled={!classId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">Choose section</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </SelectField>
            <TextField label="Subject (optional)" maxLength={100} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={teacher.subject ?? "e.g. Mathematics"} />
            <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-2">
              <input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" checked={classTeacher} onChange={(e) => setClassTeacher(e.target.checked)} />
              Class teacher of this section <span className="text-muted">(one per section)</span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setAdding(false); setError(null); }} disabled={busy}>Done</Button>
            <Button size="sm" onClick={add} loading={busy} data-testid="confirm-assign">Assign</Button>
          </div>
        </div>
      )}
      {teacher.assignments.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No classes assigned yet.</p> : (
        <div className="divide-y divide-line">
          {bySession.map(([session, items]) => (
            <div key={session} className="px-5 py-3">
              <p className="mb-1.5 text-xs font-semibold text-muted">Session {session}{items[0].session_is_archived ? " (archived)" : ""}</p>
              <ul className="space-y-1.5">
                {items.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 text-sm" data-testid={`assignment-${a.class_name}-${a.section_name}-${a.subject ?? "any"}`}>
                    <span>
                      <span className="font-medium">{a.class_name} – {a.section_name}</span>
                      {a.subject && <span className="text-muted"> · {a.subject}</span>}
                      {a.is_class_teacher && <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-pencil-100 px-2 py-0.5 text-xs"><Star className="size-3" aria-hidden /> Class teacher</span>}
                    </span>
                    {canManage && !a.session_is_archived && (
                      <ActionMenu label={`Actions for ${a.class_name} – ${a.section_name}${a.subject ? ` ${a.subject}` : ""}`} actions={[
                        { label: a.is_class_teacher ? "Not class teacher" : "Make class teacher", onSelect: () => toggleClassTeacher(a) },
                        { label: "Remove", onSelect: () => setRemoving(a), tone: "danger" },
                      ]} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog open={removing !== null} title={`Remove ${removing?.class_name} – ${removing?.section_name}?`}
        message="The teacher immediately loses access to this section's students and attendance." confirmLabel="Remove"
        onCancel={() => setRemoving(null)} onConfirm={async () => {
          try { onChange(await apiFetch<TeacherDetail>(`/teachers/${teacher.id}/assignments/${removing!.id}`, { method: "DELETE", schoolId })); toast.success("Class removed."); setRemoving(null); }
          catch (e) { toast.error(errorMessage(e)); }
        }} />
    </section>
  );
}
