"use client";

import { clsx } from "clsx";
import { CalendarCheck, Users } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { SectionPicker, type Pick } from "@/components/attendance/section-picker";
import { PageHeader } from "@/components/layout/app-shell";
import { ModulePlaceholder } from "@/components/layout/module-placeholder";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { ATTENDANCE_LABELS, type AttendanceStatus, type Roster } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

type Mark = { status: AttendanceStatus | null; remarks: string };
const STATUSES: AttendanceStatus[] = ["present", "absent", "leave"];
const BUTTON_TONE: Record<AttendanceStatus, string> = {
  present: "peer-checked:border-leaf-600 peer-checked:bg-leaf-600 peer-checked:text-white",
  absent: "peer-checked:border-danger-600 peer-checked:bg-danger-600 peer-checked:text-white",
  leave: "peer-checked:border-pencil-400 peer-checked:bg-pencil-400 peer-checked:text-board-950",
};

function MarkAttendance() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const pathname = usePathname();
  const params = useSearchParams();
  // The selection lives in state (always current) and is mirrored to the URL for
  // deep links. Building each change from the URL could lose a quick second change.
  const [sel, setSel] = useState(() => ({
    session: params.get("session") ?? "", klass: params.get("class") ?? "", section: params.get("section") ?? "",
    date: params.get("date") ?? todayISO(),
  }));
  const pick: Pick = { session: sel.session, klass: sel.klass, section: sel.section };
  const day = sel.date;
  useEffect(() => {
    const p = new URLSearchParams();
    if (sel.session) p.set("session", sel.session);
    if (sel.klass) p.set("class", sel.klass);
    if (sel.section) p.set("section", sel.section);
    p.set("date", sel.date);
    // History API, not the router: no navigation, so nothing re-mounts with a stale URL.
    if (p.toString() !== window.location.search.slice(1)) window.history.replaceState(null, "", `${pathname}?${p}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const [roster, setRoster] = useState<Roster | null>(null);
  const [marks, setMarks] = useState<Record<string, Mark>>({}); // local edits, keyed by enrollment
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const saved = useMemo(() => Object.fromEntries((roster?.students ?? []).map((s) => [s.enrollment_id, { status: s.status, remarks: s.remarks ?? "" }])), [roster]);
  const dirtyIds = Object.keys(marks).filter((id) => marks[id].status !== saved[id]?.status || marks[id].remarks.trim() !== (saved[id]?.remarks ?? ""));
  const dirty = dirtyIds.length > 0;

  // Leaving with unsaved marks loses them: warn first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const navigate = (next: Partial<Pick> & { date?: string }) => {
    if (dirty && !window.confirm("You have unsaved attendance. Discard it?")) return;
    setSel((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) }));
  };

  const latest = useRef(0); // a late answer for an earlier date/section must never replace the roster
  const load = useCallback(async () => {
    const mine = ++latest.current;
    if (!pick.section) { setRoster(null); return; }
    setLoading(true);
    setError(null);
    try {
      // ONE request: every student of the section with any saved mark for the day.
      const r = await apiFetch<Roster>("/attendance/roster", { schoolId, query: { section_id: pick.section, date: day } });
      if (mine !== latest.current) return;
      setRoster(r);
      setMarks(Object.fromEntries(r.students.map((s) => [s.enrollment_id, { status: s.status, remarks: s.remarks ?? "" }])));
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
    finally { if (mine === latest.current) setLoading(false); }
  }, [schoolId, pick.section, day]);
  useEffect(() => { void load(); }, [load]);

  const setAll = (status: AttendanceStatus) =>
    setMarks((m) => Object.fromEntries(Object.entries(m).map(([id, v]) => [id, { ...v, status }])));
  const setOne = (id: string, patch: Partial<Mark>) => setMarks((m) => ({ ...m, [id]: { ...m[id], ...patch } }));

  async function save() {
    if (!roster) return;
    const unmarked = roster.students.filter((s) => !marks[s.enrollment_id]?.status).length;
    if (unmarked && !window.confirm(`${unmarked} student${unmarked === 1 ? " has" : "s have"} no status and won't be saved. Continue?`)) return;
    setSaving(true);
    try {
      // ONE request for the whole class; only rows that changed are sent.
      const entries = dirtyIds.filter((id) => marks[id].status).map((id) => ({
        enrollment_id: id, status: marks[id].status, remarks: marks[id].remarks.trim() || null,
      }));
      const r = await apiFetch<{ inserted: number; updated: number; unchanged: number; roster: Roster }>("/attendance/roster", {
        method: "PUT", schoolId, body: { section_id: roster.section_id, date: roster.date, entries },
      });
      setRoster(r.roster);
      setMarks(Object.fromEntries(r.roster.students.map((s) => [s.enrollment_id, { status: s.status, remarks: s.remarks ?? "" }])));
      toast.success(`Attendance saved: ${r.inserted} new, ${r.updated} changed.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const live = useMemo(() => {
    const vals = Object.values(marks);
    const c = { present: 0, absent: 0, leave: 0, unmarked: 0 };
    for (const v of vals) { if (v.status) c[v.status] += 1; else c.unmarked += 1; }
    return c;
  }, [marks]);

  return (
    <>
      <PageHeader title="Mark attendance" description="Choose a class and date, mark everyone, then save once." />
      <div className="mb-5 grid gap-3 rounded-lg border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <SectionPicker schoolId={schoolId} value={pick} onChange={(p) => navigate({ session: p.session, klass: p.klass, section: p.section })} />
        <TextField label="Date" type="date" max={todayISO()} value={day} onChange={(e) => e.target.value && navigate({ date: e.target.value })} />
      </div>

      {!pick.section ? (
        <div className="rounded-lg border border-line bg-white"><EmptyState icon={CalendarCheck} title="Choose a class and section" message="The students of that section will appear here." /></div>
      ) : error ? <ErrorState message={error} onRetry={load} /> : !roster || loading ? <LoadingState label="Loading students…" /> : (
        <section className="rounded-lg border border-line bg-white">
          <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="font-semibold">{roster.class_name} – {roster.section_name} · {formatDate(roster.date)}</h2>
              <p className="tabular text-sm text-muted" data-testid="live-counts">
                {live.present} present · {live.absent} absent · {live.leave} leave{live.unmarked ? ` · ${live.unmarked} not marked` : ""}
              </p>
            </div>
            {roster.editable && roster.students.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setAll("present")}>Mark all present</Button>
                <Button variant="secondary" size="sm" onClick={() => setAll("absent")}>Mark all absent</Button>
                {dirty && <span className="text-sm text-muted" data-testid="unsaved">{dirtyIds.length} unsaved</span>}
                <Button onClick={save} loading={saving} disabled={!dirty} data-testid="save-attendance">Save attendance</Button>
              </div>
            )}
          </div>
          {!roster.editable && <p className="border-b border-line bg-pencil-100 px-4 py-2.5 text-sm" role="status" data-testid="readonly-reason">{roster.reason}</p>}
          {roster.students.length === 0 ? (
            <EmptyState icon={Users} title="No students in this section" message="Students appear here once they're admitted to this section." />
          ) : (
            <ul className="divide-y divide-line" data-testid="roster">
              {roster.students.map((s) => {
                const m = marks[s.enrollment_id] ?? { status: null, remarks: "" };
                const changed = dirtyIds.includes(s.enrollment_id);
                return (
                  <li key={s.enrollment_id} className={clsx("flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center", changed && "bg-pencil-100/40")} data-testid={`roster-${s.admission_number}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{s.full_name}</p>
                      <p className="text-xs text-muted">{s.student_code} · Adm. {s.admission_number}</p>
                    </div>
                    <fieldset className="flex gap-1" disabled={!roster.editable}>
                      <legend className="sr-only">Attendance for {s.full_name}</legend>
                      {STATUSES.map((st) => (
                        <label key={st} className="cursor-pointer">
                          <input type="radio" className="peer sr-only" name={`att-${s.enrollment_id}`} checked={m.status === st}
                            onChange={() => setOne(s.enrollment_id, { status: st })} aria-label={`${ATTENDANCE_LABELS[st]}: ${s.full_name}`} />
                          <span className={clsx("inline-block w-9 rounded-md border border-line py-1 text-center text-xs font-semibold text-muted peer-focus-visible:ring-2 peer-focus-visible:ring-pencil-400", BUTTON_TONE[st])}
                            title={ATTENDANCE_LABELS[st]}>{ATTENDANCE_LABELS[st][0]}</span>
                        </label>
                      ))}
                    </fieldset>
                    <input value={m.remarks} maxLength={200} disabled={!roster.editable} placeholder="Remark (optional)" aria-label={`Remark for ${s.full_name}`}
                      onChange={(e) => setOne(s.enrollment_id, { remarks: e.target.value })}
                      className="h-8 w-full rounded-md border border-line px-2 text-sm sm:w-44" />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function AttendanceHome() {
  const { can } = useAuth();
  if (can("attendance:mark")) return <Suspense fallback={<LoadingState />}><MarkAttendance /></Suspense>;
  return (
    <ModulePlaceholder title="Attendance" description="Daily attendance." icon={CalendarCheck}
      plannedFor={["See your child's attendance", "Get notified about absences", "Monthly attendance summary"]} />
  );
}

export default function AttendancePage() {
  return <RequirePermission permission="attendance:view"><AttendanceHome /></RequirePermission>;
}
