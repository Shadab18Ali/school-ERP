"use client";

import { Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession, Subject, TimetablePeriod } from "@/lib/types";
import { periodName } from "./timetable-grid";

const hm = (t: string) => t.slice(0, 5);
interface PeriodForm { id?: string; period_number: string; label: string; start_time: string; end_time: string; is_break: boolean }

/** The school day (periods, per session) and the subject list (per school). */
export function SetupTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [session, setSession] = useState("");
  const [periods, setPeriods] = useState<TimetablePeriod[] | null>(null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<PeriodForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TimetablePeriod | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [day, setDay] = useState({ first_start: "08:00", period_minutes: "40", periods: "8", break_after: "4", break_minutes: "30" });
  const [subName, setSubName] = useState("");
  const [subCode, setSubCode] = useState("");
  const [subError, setSubError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    apiFetch<AcademicSession[]>("/sessions", { schoolId }).then((ss) => {
      setSessions(ss);
      setSession((ss.find((s) => s.is_current) ?? ss[0])?.id ?? "");
    }).catch((e) => setError(errorMessage(e)));
  }, [schoolId]);

  const load = useCallback(async () => {
    if (!session) return;
    const mine = ++latest.current;
    setError(null);
    try {
      const r = await apiFetch<{ periods: TimetablePeriod[]; subjects: Subject[] }>("/timetable/setup", { schoolId, query: { session_id: session } });
      if (mine === latest.current) { setPeriods(r.periods); setSubjects(r.subjects); }
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [schoolId, session]);
  useEffect(() => { void load(); }, [load]);

  const archived = sessions.find((s) => s.id === session)?.is_archived ?? false;

  async function generate() {
    setBusy("generate");
    try {
      setPeriods(await apiFetch<TimetablePeriod[]>("/timetable/periods/generate", { schoolId, method: "POST", body: {
        academic_session_id: session, first_start: day.first_start, period_minutes: Number(day.period_minutes), periods: Number(day.periods),
        break_after: day.break_after ? Number(day.break_after) : null, break_minutes: Number(day.break_minutes) } }));
      toast.success("School day set up.");
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }

  async function savePeriod() {
    if (!form) return;
    setBusy("period"); setFormError(null);
    const body = { period_number: Number(form.period_number), label: form.label.trim() || null, start_time: form.start_time, end_time: form.end_time, is_break: form.is_break };
    try {
      setPeriods(form.id
        ? await apiFetch<TimetablePeriod[]>(`/timetable/periods/${form.id}`, { schoolId, method: "PATCH", body })
        : await apiFetch<TimetablePeriod[]>("/timetable/periods", { schoolId, method: "POST", body: { ...body, academic_session_id: session } }));
      setForm(null);
    } catch (e) { setFormError(errorMessage(e)); } finally { setBusy(null); }
  }

  async function removePeriod() {
    if (!removing) return;
    setBusy("remove");
    try { setPeriods(await apiFetch<TimetablePeriod[]>(`/timetable/periods/${removing.id}`, { schoolId, method: "DELETE" })); setRemoving(null); }
    catch (e) { toast.error(errorMessage(e)); setRemoving(null); } finally { setBusy(null); }
  }

  async function addSubject() {
    if (!subName.trim()) { setSubError("Enter the subject name."); return; }
    setBusy("subject"); setSubError(null);
    try {
      setSubjects(await apiFetch<Subject[]>("/timetable/subjects", { schoolId, method: "POST", body: { name: subName, code: subCode || null } }));
      setSubName(""); setSubCode("");
    } catch (e) { setSubError(errorMessage(e)); } finally { setBusy(null); }
  }

  async function addCommon() {
    setBusy("common");
    try { setSubjects(await apiFetch<Subject[]>("/timetable/subjects/common", { schoolId, method: "POST" })); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }

  async function toggleSubject(s: Subject) {
    try { setSubjects(await apiFetch<Subject[]>(`/timetable/subjects/${s.id}`, { schoolId, method: "PATCH", body: { is_active: !s.is_active } })); }
    catch (e) { toast.error(errorMessage(e)); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!periods || !subjects) return <LoadingState />;
  const nextNumber = String(Math.max(0, ...periods.map((p) => p.period_number)) + 1);
  const last = periods.at(-1);

  return (
    <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
      <section className="rounded-lg border border-line bg-white" data-testid="periods-card">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4">
          <div>
            <h2 className="font-semibold">School day</h2>
            <p className="text-sm text-muted">Periods and breaks for one academic session.</p>
          </div>
          <div className="flex items-end gap-2">
            <SelectField label="Session" value={session} onChange={(e) => setSession(e.target.value)}>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : s.is_archived ? " (archived)" : ""}</option>)}
            </SelectField>
            {!archived && periods.length > 0 && (
              <Button variant="secondary" onClick={() => { setFormError(null); setForm({ period_number: nextNumber, label: "", start_time: last ? hm(last.end_time) : "08:00", end_time: "", is_break: false }); }}>
                <Plus className="size-4" /> Add period
              </Button>
            )}
          </div>
        </div>
        {archived && <p className="border-b border-line bg-paper px-4 py-2 text-sm text-muted">This session is archived, so its timetable can&apos;t be changed.</p>}
        {periods.length === 0 ? (
          archived ? <p className="p-4 text-sm text-muted">No periods were set up for this session.</p> : (
            <div className="space-y-4 p-4" data-testid="generate-day">
              <p className="text-sm">No periods yet. Set up a standard day, then adjust any period you need to.</p>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <TextField label="First period starts" type="time" value={day.first_start} onChange={(e) => setDay({ ...day, first_start: e.target.value })} />
                <TextField label="Minutes per period" type="number" min={20} max={120} value={day.period_minutes} onChange={(e) => setDay({ ...day, period_minutes: e.target.value })} />
                <TextField label="Teaching periods" type="number" min={1} max={12} value={day.periods} onChange={(e) => setDay({ ...day, periods: e.target.value })} />
                <TextField label="Lunch after period" type="number" min={1} max={11} value={day.break_after} hint="Leave empty for no break" onChange={(e) => setDay({ ...day, break_after: e.target.value })} />
                <TextField label="Lunch minutes" type="number" min={5} max={90} value={day.break_minutes} onChange={(e) => setDay({ ...day, break_minutes: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <Button onClick={generate} loading={busy === "generate"} data-testid="generate-periods">Set up standard day</Button>
                <Button variant="secondary" onClick={() => { setFormError(null); setForm({ period_number: "1", label: "", start_time: "08:00", end_time: "08:40", is_break: false }); }}>Add periods one by one</Button>
              </div>
            </div>
          )
        ) : (
          <table className="w-full text-sm" data-testid="periods-table">
            <thead className="bg-paper text-left text-xs text-muted">
              <tr><th className="px-4 py-2">#</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Time</th><th className="px-4 py-2 text-right">Lessons</th><th className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {periods.map((p) => (
                <tr key={p.id} data-testid={`period-row-${p.period_number}`} className={p.is_break ? "bg-pencil-100/30" : undefined}>
                  <td className="tabular px-4 py-2 text-muted">{p.period_number}</td>
                  <td className="px-4 py-2 font-medium">{periodName(p)}{p.is_break && <span className="ml-2 text-xs font-normal text-muted">break</span>}</td>
                  <td className="tabular px-4 py-2">{hm(p.start_time)} – {hm(p.end_time)}</td>
                  <td className="tabular px-4 py-2 text-right">{p.is_break ? "—" : p.in_use}</td>
                  <td className="px-4 py-2 text-right">
                    {!archived && <span className="inline-flex gap-1">
                      <button className="rounded p-1.5 text-muted hover:bg-ink/5" aria-label={`Edit ${periodName(p)}`}
                        onClick={() => { setFormError(null); setForm({ id: p.id, period_number: String(p.period_number), label: p.label ?? "", start_time: hm(p.start_time), end_time: hm(p.end_time), is_break: p.is_break }); }}><Pencil className="size-4" /></button>
                      <button className="rounded p-1.5 text-muted hover:bg-danger-50 hover:text-danger-600" aria-label={`Delete ${periodName(p)}`} onClick={() => setRemoving(p)}><Trash2 className="size-4" /></button>
                    </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-lg border border-line bg-white" data-testid="subjects-card">
        <div className="flex items-center justify-between gap-3 border-b border-line p-4">
          <div>
            <h2 className="font-semibold">Subjects</h2>
            <p className="text-sm text-muted">Used by every class timetable.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={addCommon} loading={busy === "common"} data-testid="add-common-subjects"><Sparkles className="size-4" /> Add common subjects</Button>
        </div>
        <div className="grid grid-cols-[1fr_7rem_auto] items-end gap-2 border-b border-line p-4">
          <TextField label="Subject name" value={subName} maxLength={60} onChange={(e) => setSubName(e.target.value)} error={subError} />
          <TextField label="Code" value={subCode} maxLength={12} placeholder="optional" onChange={(e) => setSubCode(e.target.value)} />
          <Button onClick={addSubject} loading={busy === "subject"} data-testid="add-subject" className={subError ? "mb-5" : undefined}>Add</Button>
        </div>
        {subjects.length === 0 ? <p className="p-4 text-sm text-muted">No subjects yet.</p> : (
          <ul className="divide-y divide-line" data-testid="subjects-list">
            {subjects.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm" data-testid={`subject-${s.name}`}>
                <span className={s.is_active ? undefined : "text-muted line-through"}>
                  {s.name}{s.code && <span className="ml-1.5 text-xs text-muted">{s.code}</span>}
                  <span className="ml-2 text-xs text-muted">{s.periods_per_week} / week</span>
                </span>
                <button className="text-xs font-medium text-leaf-700 hover:underline" onClick={() => toggleSubject(s)}>{s.is_active ? "Deactivate" : "Activate"}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal open={!!form} title={form?.id ? "Edit period" : "Add period"} onClose={() => setForm(null)}
        footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button onClick={savePeriod} loading={busy === "period"} data-testid="save-period">Save</Button></>}>
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Order" type="number" min={1} max={20} value={form.period_number} hint="Position in the day" onChange={(e) => setForm({ ...form, period_number: e.target.value })} />
            <TextField label="Name" value={form.label} maxLength={40} placeholder={form.is_break ? "Lunch" : `Period ${form.period_number}`} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            <TextField label="Starts" type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
            <TextField label="Ends" type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={form.is_break} onChange={(e) => setForm({ ...form, is_break: e.target.checked })} className="size-4 accent-leaf-600" />
              This is a break (no lessons)
            </label>
            {formError && <p className="text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="period-error">{formError}</p>}
          </div>
        )}
      </Modal>
      <ConfirmDialog open={!!removing} title="Delete period?" message={removing ? `${periodName(removing)} will be removed from the school day.` : ""}
        confirmLabel="Delete" loading={busy === "remove"} onConfirm={removePeriod} onCancel={() => setRemoving(null)} />
    </div>
  );
}
