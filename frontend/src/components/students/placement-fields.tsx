"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SelectField, TextField } from "@/components/ui/field";
import { apiFetch } from "@/lib/api";
import type { AcademicSession, ClassList, SchoolClass } from "@/lib/types";

export interface Placement {
  academic_session_id: string;
  class_id: string;
  section_id: string;
  admission_number: string;
  admission_date: string;
}

interface Props {
  schoolId: string;
  sessions: AcademicSession[];
  value: Placement;
  onChange: (p: Placement) => void;
  errors?: Partial<Record<keyof Placement, string>>;
  /** Hide the session picker (e.g. when editing an existing enrollment). */
  lockSession?: boolean;
  /** Suggest the next admission number when the field is empty. */
  suggestNumber?: boolean;
}

/** Session → class → section → admission number/date, kept consistent. */
export function PlacementFields({ schoolId, sessions, value, onChange, errors = {}, lockSession, suggestNumber }: Props) {
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [loading, setLoading] = useState(false);
  const open = sessions.filter((s) => !s.is_archived);

  useEffect(() => {
    if (!value.academic_session_id) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<ClassList>("/classes", { schoolId, query: { session_id: value.academic_session_id, status: "active" } })
      .then((r) => { if (!cancelled) setClasses(r.items); })
      .catch(() => { if (!cancelled) setClasses([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId, value.academic_session_id]);

  // Latest value + whether the user has typed in the number field, so a slow
  // suggestion never overwrites anything the user did while it was loading.
  const latest = useRef(value);
  latest.current = value;
  const numberTouched = useRef(false);

  useEffect(() => {
    if (!suggestNumber || !value.academic_session_id) return;
    let cancelled = false;
    apiFetch<{ suggestion: string | null }>("/students/next-admission-number", { schoolId, query: { session_id: value.academic_session_id } })
      .then((r) => {
        const now = latest.current;
        if (!cancelled && r.suggestion && !numberTouched.current && !now.admission_number) {
          onChange({ ...now, admission_number: r.suggestion });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, value.academic_session_id, suggestNumber]);

  // Only classes that have at least one active section can take students.
  const usable = useMemo(() => classes.filter((c) => c.sections.some((s) => s.is_active)), [classes]);
  const sections = usable.find((c) => c.id === value.class_id)?.sections.filter((s) => s.is_active) ?? [];
  const noClasses = !loading && value.academic_session_id && usable.length === 0;

  return (
    <>
      {!lockSession && (
        <SelectField label="Academic session" value={value.academic_session_id}
          onChange={(e) => onChange({ ...value, academic_session_id: e.target.value, class_id: "", section_id: "" })}>
          {open.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
        </SelectField>
      )}
      <div>
        <SelectField label="Class" value={value.class_id} disabled={loading || usable.length === 0}
          onChange={(e) => {
            const cls = usable.find((c) => c.id === e.target.value);
            const only = cls?.sections.filter((s) => s.is_active);
            onChange({ ...value, class_id: e.target.value, section_id: only?.length === 1 ? only[0].id : "" });
          }}>
          <option value="">{loading ? "Loading…" : "Choose class"}</option>
          {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        {errors.class_id && <p className="mt-1 text-xs text-danger-600">{errors.class_id}</p>}
        {noClasses && <p className="mt-1 text-xs text-muted">No class has sections in this session yet. Add sections on the Classes page first.</p>}
      </div>
      <div>
        <SelectField label="Section" value={value.section_id} disabled={!value.class_id}
          onChange={(e) => onChange({ ...value, section_id: e.target.value })}>
          <option value="">Choose section</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.capacity ? ` (${s.student_count}/${s.capacity})` : ""}
            </option>
          ))}
        </SelectField>
        {errors.section_id && <p className="mt-1 text-xs text-danger-600">{errors.section_id}</p>}
      </div>
      <TextField label="Admission number" required maxLength={30} value={value.admission_number}
        onChange={(e) => { numberTouched.current = true; onChange({ ...value, admission_number: e.target.value }); }}
        error={errors.admission_number}
        hint="Unique within this session" />
      <TextField label="Admission date" type="date" required value={value.admission_date}
        onChange={(e) => onChange({ ...value, admission_date: e.target.value })} error={errors.admission_date} />
    </>
  );
}

export function validatePlacement(p: Placement): Partial<Record<keyof Placement, string>> {
  const e: Partial<Record<keyof Placement, string>> = {};
  if (!p.class_id) e.class_id = "Choose a class.";
  if (!p.section_id) e.section_id = "Choose a section.";
  if (!p.admission_number.trim()) e.admission_number = "Enter the admission number.";
  if (!p.admission_date) e.admission_date = "Choose the admission date.";
  return e;
}
