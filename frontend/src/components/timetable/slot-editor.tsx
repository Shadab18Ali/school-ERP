"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import { DAY_NAMES, type Subject, type TimetableCell, type TimetableGrid, type TimetablePeriod } from "@/lib/types";
import { periodName } from "./timetable-grid";

export interface SectionTeacher { id: string; full_name: string; employee_id: string; subjects: string[] }
export interface Slot { day: number; period: TimetablePeriod; cell: TimetableCell | null }

/**
 * Fill, change or clear one slot of a class timetable. Clashes (teacher busy, room taken)
 * are checked as you choose, and the database refuses them again on save.
 */
export function SlotEditor({ schoolId, sectionId, slot, subjects, teachers, onClose, onSaved }: {
  schoolId: string; sectionId: string; slot: Slot | null; subjects: Subject[]; teachers: SectionTeacher[];
  onClose: () => void; onSaved: (g: TimetableGrid) => void;
}) {
  const [subject, setSubject] = useState("");
  const [teacher, setTeacher] = useState("");
  const [room, setRoom] = useState("");
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (!slot) return;
    setSubject(slot.cell?.subject_id ?? "");
    setTeacher(slot.cell?.teacher_id ?? "");
    setRoom(slot.cell?.room ?? "");
    setError(null);
    setConflicts(null);
  }, [slot]);

  // Live clash check, newest answer wins.
  useEffect(() => {
    if (!slot) return;
    const mine = ++latest.current;
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch<{ conflicts: string[] }>("/timetable/check", {
          schoolId, method: "POST",
          body: { section_id: sectionId, day_of_week: slot.day, period_id: slot.period.id, teacher_id: teacher || null,
            room: room.trim() || null, entry_id: slot.cell?.id ?? null },
        });
        if (mine === latest.current) setConflicts(r.conflicts);
      } catch { if (mine === latest.current) setConflicts(null); }
    }, 250);
    return () => clearTimeout(t);
  }, [slot, teacher, room, schoolId, sectionId]);

  if (!slot) return null;
  const active = subjects.filter((s) => s.is_active || s.id === slot.cell?.subject_id);
  const subjectName = subjects.find((s) => s.id === subject)?.name.toLowerCase();
  // Teachers who teach the chosen subject in this class are listed first.
  const sorted = [...teachers].sort((a, b) => {
    const am = subjectName && a.subjects.some((x) => x.toLowerCase() === subjectName) ? 0 : 1;
    const bm = subjectName && b.subjects.some((x) => x.toLowerCase() === subjectName) ? 0 : 1;
    return am - bm || a.full_name.localeCompare(b.full_name);
  });
  const hasClash = (conflicts?.length ?? 0) > 0;

  async function save() {
    if (!subject) { setError("Choose a subject."); return; }
    setBusy("save"); setError(null);
    try {
      const body = { subject_id: subject, teacher_id: teacher || null, room: room.trim() || null };
      const g = slot!.cell
        ? await apiFetch<TimetableGrid>(`/timetable/entries/${slot!.cell.id}`, { schoolId, method: "PATCH", body })
        : await apiFetch<TimetableGrid>("/timetable/entries", { schoolId, method: "POST",
            body: { ...body, section_id: sectionId, day_of_week: slot!.day, period_id: slot!.period.id } });
      onSaved(g);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }

  async function clear() {
    setBusy("clear"); setError(null);
    try {
      onSaved(await apiFetch<TimetableGrid>(`/timetable/entries/${slot!.cell!.id}`, { schoolId, method: "DELETE" }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }

  return (
    <Modal open title={`${DAY_NAMES[slot.day]} · ${periodName(slot.period)}`}
      description={`${slot.period.start_time.slice(0, 5)} – ${slot.period.end_time.slice(0, 5)}`} onClose={onClose}
      footer={<>
        {slot.cell && <Button variant="secondary" className="mr-auto" onClick={clear} loading={busy === "clear"} data-testid="clear-slot">Clear slot</Button>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} loading={busy === "save"} disabled={hasClash} data-testid="save-slot">Save</Button>
      </>}>
      <div className="space-y-4">
        <SelectField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="">Choose subject</option>
          {active.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ""}</option>)}
        </SelectField>
        {active.length === 0 && <p className="text-sm text-muted">No subjects yet. Add them under the Setup tab.</p>}
        <div>
          <SelectField label="Teacher" value={teacher} onChange={(e) => setTeacher(e.target.value)}>
            <option value="">No teacher</option>
            {sorted.map((t) => <option key={t.id} value={t.id}>{t.full_name}{t.subjects.length ? ` — ${t.subjects.join(", ")}` : ""}</option>)}
          </SelectField>
          <p className="mt-1 text-xs text-muted">
            {teachers.length === 0 ? "No teacher is assigned to this class yet. Assign one under Teachers first." : "Only teachers assigned to this class are listed."}
          </p>
        </div>
        <TextField label="Room" value={room} maxLength={30} placeholder="e.g. R-101 or Lab 2" onChange={(e) => setRoom(e.target.value)} />
        {hasClash ? (
          <div className="rounded-md border border-danger-600/30 bg-danger-50 p-3 text-sm text-danger-600" role="alert" data-testid="slot-conflicts">
            <p className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-4" /> This slot clashes</p>
            <ul className="list-disc space-y-0.5 pl-5">{conflicts!.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        ) : conflicts && (teacher || room.trim()) ? (
          <p className="flex items-center gap-1.5 text-sm text-leaf-700" data-testid="slot-free"><CheckCircle2 className="size-4" /> No clashes.</p>
        ) : null}
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="slot-error">{error}</p>}
      </div>
    </Modal>
  );
}
