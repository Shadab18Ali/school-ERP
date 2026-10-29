"use client";

import { clsx } from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { SectionPicker, type Pick } from "@/components/attendance/section-picker";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { SetupTab } from "@/components/timetable/setup-tab";
import { type SectionTeacher, type Slot, SlotEditor } from "@/components/timetable/slot-editor";
import { TimetableActions, TimetableGridView } from "@/components/timetable/timetable-grid";
import { SelectField } from "@/components/ui/field";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import type { Paginated, Subject, TeacherSummary, TimetableGrid } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

type Tab = "Class timetable" | "Teacher timetable" | "Setup";

function GridHeader({ g, pdfPath, schoolId, hint }: { g: TimetableGrid; pdfPath: string; schoolId: string; hint?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold" data-testid="timetable-title">{g.title}</h2>
        <p className="text-xs text-muted">{g.session_name ? `Session ${g.session_name}` : "No current session"}{hint && <span className="print:hidden"> · {hint}</span>}</p>
      </div>
      {g.periods.length > 0 && <TimetableActions pdfPath={pdfPath} schoolId={schoolId} name={g.title} />}
    </div>
  );
}

function ClassTab({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const manage = can("timetable:manage");
  const [pick, setPick] = useState<Pick>({ session: "", klass: "", section: "" });
  const [grid, setGrid] = useState<TimetableGrid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [teachers, setTeachers] = useState<SectionTeacher[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setGrid(null); setError(null);
    if (!pick.section) return;
    try {
      const [g, subs, ts] = await Promise.all([
        apiFetch<TimetableGrid>(`/timetable/sections/${pick.section}`, { schoolId }),
        manage ? apiFetch<Subject[]>("/timetable/subjects", { schoolId, query: { include_inactive: "true" } }) : Promise.resolve([]),
        manage ? apiFetch<SectionTeacher[]>(`/timetable/sections/${pick.section}/teachers`, { schoolId }) : Promise.resolve([]),
      ]);
      if (mine !== latest.current) return;
      setGrid(g); setSubjects(subs); setTeachers(ts);
    } catch (e) {
      if (mine === latest.current) setError(e instanceof ApiError && e.status === 404 ? "This class's timetable isn't available to you." : errorMessage(e));
    }
  }, [pick.section, schoolId, manage]);
  useEffect(() => { void load(); }, [load]);

  const editable = manage && grid && !grid.session_is_archived;
  return (
    <>
      <div className="mb-4 grid gap-3 rounded-lg border border-line bg-white p-4 sm:grid-cols-3 print:hidden">
        <SectionPicker schoolId={schoolId} value={pick} onChange={setPick} />
      </div>
      {!pick.section ? <p className="text-sm text-muted">Choose a class and section to see its timetable.</p>
        : error ? <ErrorState message={error} />
        : !grid ? <LoadingState />
        : (
          <>
            <GridHeader g={grid} pdfPath={`/timetable/sections/${pick.section}/pdf`} schoolId={schoolId}
              hint={editable ? "Click a slot to fill or change it" : grid.session_is_archived ? "Archived session (read-only)" : undefined} />
            <TimetableGridView grid={grid} onCell={editable ? (day, period, cell) => setSlot({ day, period, cell }) : undefined} />
            {editable && <SlotEditor schoolId={schoolId} sectionId={pick.section} slot={slot} subjects={subjects} teachers={teachers}
              onClose={() => setSlot(null)} onSaved={(g) => { setGrid(g); setSlot(null); }} />}
          </>
        )}
    </>
  );
}

function TeacherTab({ schoolId }: { schoolId: string }) {
  const [list, setList] = useState<TeacherSummary[] | null>(null);
  const [teacher, setTeacher] = useState("");
  const [grid, setGrid] = useState<TimetableGrid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    apiFetch<Paginated<TeacherSummary>>("/teachers", { schoolId, query: { status: "active", page_size: 100 } })
      .then((r) => setList(r.items)).catch((e) => setError(errorMessage(e)));
  }, [schoolId]);

  useEffect(() => {
    const mine = ++latest.current;
    setGrid(null);
    if (!teacher) return;
    apiFetch<TimetableGrid>(`/timetable/teachers/${teacher}`, { schoolId })
      .then((g) => { if (mine === latest.current) setGrid(g); })
      .catch((e) => { if (mine === latest.current) setError(errorMessage(e)); });
  }, [teacher, schoolId]);

  if (error) return <ErrorState message={error} />;
  if (!list) return <LoadingState />;
  const lessons = grid?.cells.length ?? 0;
  return (
    <>
      <div className="mb-4 rounded-lg border border-line bg-white p-4 sm:max-w-md print:hidden">
        <SelectField label="Teacher" value={teacher} onChange={(e) => setTeacher(e.target.value)}>
          <option value="">Choose teacher</option>
          {list.map((t) => <option key={t.id} value={t.id}>{t.full_name} ({t.employee_id})</option>)}
        </SelectField>
      </div>
      {!teacher ? <p className="text-sm text-muted">Choose a teacher to see their week.</p>
        : !grid ? <LoadingState />
        : (
          <>
            <GridHeader g={grid} pdfPath={`/timetable/teachers/${teacher}/pdf`} schoolId={schoolId} hint={`${lessons} lesson${lessons === 1 ? "" : "s"} a week`} />
            <TimetableGridView grid={grid} testId="teacher-timetable" />
          </>
        )}
    </>
  );
}

function Timetable() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const tabs: Tab[] = ["Class timetable", ...(can("teachers:view") ? ["Teacher timetable" as const] : []), ...(can("timetable:manage") ? ["Setup" as const] : [])];
  const [tab, setTab] = useState<Tab>("Class timetable");
  return (
    <>
      <div className="print:hidden">
        <PageHeader title="Timetable" description="Weekly class and teacher timetables. Clashes (a teacher, class or room booked twice) are refused." />
        <div role="tablist" aria-label="Timetable" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
          ))}
        </div>
      </div>
      {tab === "Class timetable" ? <ClassTab schoolId={schoolId} /> : tab === "Teacher timetable" ? <TeacherTab schoolId={schoolId} /> : <SetupTab schoolId={schoolId} />}
    </>
  );
}

export default function TimetablePage() {
  return <RequirePermission permission="timetable:view"><Timetable /></RequirePermission>;
}
