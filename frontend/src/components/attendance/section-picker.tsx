"use client";

import { useEffect, useState } from "react";
import { SelectField } from "@/components/ui/field";
import { apiFetch } from "@/lib/api";
import type { AcademicSession, ClassList, SchoolClass } from "@/lib/types";

export interface Pick { session: string; klass: string; section: string }

/** Session → class → section, each list loaded once per change (not per student). */
export function SectionPicker({ schoolId, value, onChange }: { schoolId: string; value: Pick; onChange: (p: Pick) => void }) {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);

  useEffect(() => {
    apiFetch<AcademicSession[]>("/sessions", { schoolId }).then((ss) => {
      setSessions(ss);
      if (!value.session) {
        const cur = ss.find((s) => s.is_current) ?? ss[0];
        if (cur) onChange({ ...value, session: cur.id }); // keep a section given by a link
      }
    }).catch(() => setSessions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => {
    if (!value.session) return;
    apiFetch<ClassList>("/classes", { schoolId, query: { session_id: value.session, status: "active" } })
      .then((r) => {
        const usable = r.items.filter((c) => c.sections.some((s) => s.is_active));
        setClasses(usable);
        // A link may name only the section: fill in its class.
        if (value.section && !value.klass) {
          const owner = usable.find((c) => c.sections.some((s) => s.id === value.section));
          if (owner) onChange({ ...value, klass: owner.id });
        }
      })
      .catch(() => setClasses([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, value.session]);

  const sections = classes.find((c) => c.id === value.klass)?.sections.filter((s) => s.is_active) ?? [];
  return (
    <>
      <SelectField label="Academic session" value={value.session} onChange={(e) => onChange({ session: e.target.value, klass: "", section: "" })}>
        {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : s.is_archived ? " (archived)" : ""}</option>)}
      </SelectField>
      <SelectField label="Class" value={value.klass} onChange={(e) => {
        const only = classes.find((c) => c.id === e.target.value)?.sections.filter((s) => s.is_active);
        onChange({ ...value, klass: e.target.value, section: only?.length === 1 ? only[0].id : "" });
      }}>
        <option value="">Choose class</option>
        {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </SelectField>
      <SelectField label="Section" value={value.section} disabled={!value.klass} onChange={(e) => onChange({ ...value, section: e.target.value })}>
        <option value="">Choose section</option>
        {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </SelectField>
    </>
  );
}
