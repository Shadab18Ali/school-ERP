"use client";

import { clsx } from "clsx";
import { CalendarCheck2, Download, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import {
  days, LEAVE_STATUS_LABEL, WEEKDAYS,
  type BalanceMatrix, type Holiday, type HrSettings, type Leave, type LeaveList, type LeaveStatus, type LeaveType, type StaffLeave,
} from "@/lib/hr";
import { ApplyLeaveModal, BalanceCards, CancelLeaveModal, DecideModal, FormError, LeaveSummary, Pill, Section, SessionSelect } from "./shared";

interface SessionRow { id: string; name: string; is_current: boolean }
function useSessions(schoolId: string) {
  const [list, setList] = useState<SessionRow[]>([]);
  useEffect(() => { apiFetch<SessionRow[]>("/sessions", { schoolId }).then(setList).catch(() => setList([])); }, [schoolId]);
  return list;
}

// ------------------------------------------------------------------ requests (pending)
export function RequestsTab({ schoolId, onCount }: { schoolId: string; onCount?: (n: number) => void }) {
  const toast = useToast();
  const [data, setData] = useState<LeaveList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ leave: Leave; approve: boolean } | null>(null);
  const [recording, setRecording] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { const r = await apiFetch<LeaveList>("/hr/leave", { schoolId, query: { status: "pending", page_size: 200 } }); setData(r); onCount?.(r.pending); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, onCount]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Section title="Waiting for a decision" description="Oldest first. Approved leave is taken from the balance and counted in payroll."
      action={<Button size="sm" variant="secondary" onClick={() => setRecording(true)} data-testid="record-leave"><Plus className="size-4" /> Record leave for staff</Button>} testId="requests">
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={CalendarCheck2} title="Nothing to decide" message="New leave applications appear here." /></div>
        : (
          <ul className="divide-y divide-line">
            {data.items.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start gap-3 px-5 py-3" data-testid="request-row">
                <LeaveSummary l={l} />
                <span className="flex gap-2">
                  <Button size="sm" onClick={() => setDeciding({ leave: l, approve: true })} data-testid="approve">Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => setDeciding({ leave: l, approve: false })} data-testid="reject">Reject</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      <DecideModal schoolId={schoolId} leave={deciding?.leave ?? null} approve={deciding?.approve ?? true} onClose={() => setDeciding(null)}
        onDone={(l) => { setDeciding(null); toast.success(`${l.staff_name}'s leave ${l.status}.`); void load(); }} />
      <ApplyLeaveModal schoolId={schoolId} open={recording} forStaff onClose={() => setRecording(false)}
        onDone={(l) => { setRecording(false); toast.success(`Leave recorded for ${l.staff_name}. Approve it below.`); void load(); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ history
const PAGE_SIZE = 50;
export function HistoryTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const sessions = useSessions(schoolId);
  const [status, setStatus] = useState<LeaveStatus | "all">("all");
  const [session, setSession] = useState("");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaveList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Leave | null>(null);
  useEffect(() => { if (!session && sessions.length) setSession(sessions.find((s) => s.is_current)?.id ?? sessions[0].id); }, [sessions, session]);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  const query = { status, session_id: session || undefined, q: term || undefined };
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<LeaveList>("/hr/leave", { schoolId, query: { status, session_id: session || undefined, q: term || undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, status, session, term, page]);
  useEffect(() => { void load(); }, [load]);
  async function csv() {
    try { const { blob } = await apiFetchBlob("/hr/leave", { schoolId, query: { ...query, format: "csv" } }); saveBlob(blob, `leave-${status}.csv`); }
    catch (e) { toast.error(errorMessage(e)); }
  }
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Status">
          {(["all", "pending", "approved", "rejected", "cancelled"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} onClick={() => { setStatus(s); setPage(1); }} data-testid={`history-${s}`}
              className={clsx("rounded-full border px-3 py-1 text-sm", status === s ? "border-leaf-600 bg-leaf-50 font-medium text-leaf-700" : "border-line text-muted hover:text-ink")}>
              {s === "all" ? "All" : LEAVE_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <SessionSelect sessions={sessions} value={session} onChange={(v) => { setSession(v); setPage(1); }} />
        <div className="relative w-full sm:ml-auto sm:w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="leave-search" className="sr-only">Search staff</label>
          <input id="leave-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Staff name or employee ID" data-testid="history-search"
            className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <Button variant="secondary" size="sm" onClick={csv} aria-label="Download CSV"><Download className="size-4" /> CSV</Button>
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? <div className="p-4"><EmptyState icon={CalendarCheck2} title="No leave" message="Nothing matches." /></div>
        : (
          <>
            <ul className="divide-y divide-line" data-testid="history-list">
              {data.items.map((l) => (
                <li key={l.id} className="flex flex-wrap items-start gap-3 px-5 py-3" data-testid="history-row">
                  <LeaveSummary l={l} />
                  {(l.status === "approved" || l.status === "pending") && (
                    <ActionMenu label={`Actions for ${l.staff_name}'s leave`} actions={[{ label: "Cancel leave…", onSelect: () => setCancelling(l), tone: "danger" }]} />
                  )}
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </>
        )}
      <CancelLeaveModal schoolId={schoolId} leave={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); toast.success("Leave cancelled."); void load(); }} />
    </section>
  );
}

// ------------------------------------------------------------------ balances
function AllowanceModal({ schoolId, sessionId, target, onClose, onDone }: {
  schoolId: string; sessionId: string; target: { teacherId: string; staff: string; typeId: string; type: string; standard: string | null; current: string | null; overridden: boolean } | null;
  onClose: () => void; onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (target) { setValue(target.overridden && target.current !== null ? String(Number(target.current)) : ""); setNote(""); setError(null); } }, [target]);
  if (!target) return null;
  async function save(reset: boolean) {
    setError(null);
    if (!reset && !/^\d{1,3}(\.5|\.0)?$/.test(value.trim())) return setError("Enter whole or half days, e.g. 10 or 7.5.");
    setBusy(true);
    try {
      await apiFetch("/hr/allocations", { schoolId, method: "PUT", body: { teacher_id: target!.teacherId, leave_type_id: target!.typeId, session_id: sessionId, days: reset ? null : value.trim(), note: note.trim() || null } });
      onDone();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open size="sm" title={`${target.type} for ${target.staff}`} description={`The school's yearly allowance is ${target.standard === null ? "no limit" : `${days(target.standard)} days`}.`} onClose={busy ? () => {} : onClose}
      footer={<>
        {target.overridden && <Button variant="ghost" onClick={() => save(true)} disabled={busy} data-testid="reset-allowance">Use the standard</Button>}
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => save(false)} loading={busy} data-testid="save-allowance">Save</Button>
      </>}>
      <div className="space-y-3">
        <FormError error={error} testId="allowance-error" />
        <TextField label="Days allowed this session" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} data-testid="allowance-days"
          hint="For someone who joined mid-year, carried leave forward, or has a different entitlement." />
        <TextField label="Note (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function StaffLeaveModal({ schoolId, teacherId, sessionId, onClose }: { schoolId: string; teacherId: string | null; sessionId: string; onClose: () => void }) {
  const [d, setD] = useState<StaffLeave | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!teacherId) return;
    setD(null); setError(null);
    apiFetch<StaffLeave>(`/hr/staff/${teacherId}/leave`, { schoolId, query: { session_id: sessionId || undefined } }).then(setD).catch((e) => setError(errorMessage(e)));
  }, [teacherId, sessionId, schoolId]);
  if (!teacherId) return null;
  return (
    <Modal open size="lg" title={d ? `${d.staff.full_name} · leave` : "Leave"} description={d?.session?.name} onClose={onClose}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {error ? <ErrorState message={error} /> : !d ? <LoadingState /> : (
        <div className="space-y-5" data-testid="staff-leave">
          <BalanceCards balances={d.balances} />
          {d.items.length === 0 ? <p className="text-sm text-muted">No leave this session.</p> : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {d.items.map((l) => <li key={l.id} className="px-4 py-3"><LeaveSummary l={l} showStaff={false} /></li>)}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

export function BalancesTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const sessions = useSessions(schoolId);
  const [session, setSession] = useState("");
  const [d, setD] = useState<BalanceMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Parameters<typeof AllowanceModal>[0]["target"]>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { const r = await apiFetch<BalanceMatrix>("/hr/balances", { schoolId, query: { session_id: session || undefined } }); setD(r); if (!session && r.session) setSession(r.session.id); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, session]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  if (!d.session) return <p className="text-sm text-muted">Set up an academic session first: leave years follow the sessions.</p>;
  return (
    <Section title={`Leave balances · ${d.session.name}`} description="Available / allowed. Click a number to change one person's allowance; click a name for their leave."
      action={<SessionSelect sessions={sessions} value={session} onChange={setSession} />} testId="balances-table">
      {d.types.length === 0 ? <p className="px-5 py-6 text-sm text-muted">Add leave types first.</p> : d.staff.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No active staff.</p> : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Staff</th>
                {d.types.map((t) => <th key={t.id} scope="col" className="px-3 py-2 text-right font-medium" title={t.name}>{t.code}{!t.is_paid && " (unpaid)"}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.staff.map((s) => (
                <tr key={s.id} data-testid={`balance-row-${s.employee_id}`}>
                  <td className="px-4 py-2">
                    <button type="button" onClick={() => setViewing(s.id)} className="text-left font-medium hover:underline">{s.full_name}</button>
                    <span className="block text-xs text-muted">{s.employee_id}</span>
                  </td>
                  {d.types.map((t) => {
                    const c = s.balances[t.id];
                    const allowance = c?.allowance ?? t.annual_days;
                    const used = Number(c?.used ?? 0) + Number(c?.pending ?? 0);
                    const avail = allowance === null ? null : Number(allowance) - used;
                    return (
                      <td key={t.id} className="px-3 py-2 text-right">
                        {allowance === null ? <span className="text-muted" title={`${days(c?.used ?? 0)} taken`}>{days(c?.used ?? 0)} taken</span> : (
                          <button type="button" data-testid={`cell-${t.code}`}
                            onClick={() => setEditing({ teacherId: s.id, staff: s.full_name, typeId: t.id, type: t.name, standard: t.annual_days, current: c?.allowance ?? null, overridden: Boolean(c?.overridden) })}
                            className={clsx("tabular rounded px-1.5 py-0.5 hover:bg-paper", avail !== null && avail <= 0 && "text-danger-600")}>
                            {days(avail)} / {days(allowance)}{c?.overridden && <span className="text-leaf-700" title="Set for this person">*</span>}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line px-4 py-2 text-xs text-muted">* a different allowance set for this person. Pending leave counts against the balance until it is decided.</p>
        </div>
      )}
      <AllowanceModal schoolId={schoolId} sessionId={d.session.id} target={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast.success("Allowance saved."); void load(); }} />
      <StaffLeaveModal schoolId={schoolId} teacherId={viewing} sessionId={d.session.id} onClose={() => setViewing(null)} />
    </Section>
  );
}

// ------------------------------------------------------------------ leave types
function TypeFormModal({ schoolId, open, type, onClose, onSaved }: { schoolId: string; open: boolean; type: LeaveType | null; onClose: () => void; onSaved: (t: LeaveType[]) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [annual, setAnnual] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [paid, setPaid] = useState(true);
  const [half, setHalf] = useState(true);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(type?.name ?? ""); setCode(type?.code ?? ""); setAnnual(type?.annual_days ? String(Number(type.annual_days)) : "");
    setUnlimited(type ? type.annual_days === null : false); setPaid(type?.is_paid ?? true); setHalf(type?.allow_half_day ?? true); setActive(type?.is_active ?? true);
  }, [open, type]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Name the leave type, e.g. Casual leave.");
    if (!/^[A-Za-z]{1,6}$/.test(code.trim())) return setError("The code is 1–6 letters, e.g. CL.");
    if (!unlimited && !/^\d{1,3}(\.5|\.0)?$/.test(annual.trim())) return setError("Enter the days allowed per session in whole or half days, or tick “No limit”.");
    setBusy(true);
    const body = { name, code: code.trim(), annual_days: unlimited ? null : annual.trim(), is_paid: paid, allow_half_day: half, is_active: active };
    try { onSaved(await apiFetch<LeaveType[]>(type ? `/hr/leave-types/${type.id}` : "/hr/leave-types", { schoolId, method: type ? "PUT" : "POST", body })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} title={type ? `Edit ${type.name}` : "Add a leave type"} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="lt-form" loading={busy} data-testid="save-leave-type">{type ? "Save" : "Add"}</Button></>}>
      <form id="lt-form" onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="leave-type-error" /></div>
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Casual leave" data-testid="lt-name" />
        <TextField label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={6} placeholder="e.g. CL" data-testid="lt-code" />
        <TextField label="Days per session" inputMode="decimal" value={unlimited ? "" : annual} disabled={unlimited} onChange={(e) => setAnnual(e.target.value)} data-testid="lt-days"
          hint="The leave year is the academic session." />
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="size-4 accent-leaf-600" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} data-testid="lt-unlimited" /> No limit
        </label>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={paid} onChange={(e) => setPaid(e.target.checked)} data-testid="lt-paid" />
          <span>Paid leave<span className="block text-xs text-muted">Untick for leave without pay: those days are deducted in payroll.</span></span>
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-leaf-600" checked={half} onChange={(e) => setHalf(e.target.checked)} /> Half days allowed</label>
        {type && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-leaf-600" checked={active} onChange={(e) => setActive(e.target.checked)} /> In use</label>}
      </form>
    </Modal>
  );
}

export function TypesTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<LeaveType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LeaveType | "new" | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<LeaveType[]>("/hr/leave-types", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Section title="Leave types" description="What staff can apply for, and how many days each session."
      action={<Button size="sm" onClick={() => setEditing("new")} data-testid="add-leave-type"><Plus className="size-4" /> Add type</Button>} testId="leave-types">
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !items ? <LoadingState />
        : items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No leave types yet. Add the school&apos;s, e.g. Casual leave (CL) 12 days, Sick leave (SL), Leave without pay (LWP, unpaid, no limit).</p>
        : (
          <ul className="divide-y divide-line">
            {items.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm" data-testid={`leave-type-${t.code}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t.name} <span className="text-xs font-normal text-muted">{t.code}</span></p>
                  <p className="text-xs text-muted">{t.annual_days === null ? "No limit" : `${days(t.annual_days)} days per session`}{t.allow_half_day ? " · half days allowed" : ""} · {t.applications} application{t.applications === 1 ? "" : "s"}</p>
                </div>
                <span className="flex gap-1.5">{t.is_paid ? <Pill tone="ok">Paid</Pill> : <Pill tone="warn">Unpaid</Pill>}{!t.is_active && <Pill tone="muted">Not in use</Pill>}</span>
                <ActionMenu label={`Actions for ${t.name}`} actions={[{ label: "Edit…", onSelect: () => setEditing(t) }]} />
              </li>
            ))}
          </ul>
        )}
      <TypeFormModal schoolId={schoolId} open={editing !== null} type={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={(list) => { setEditing(null); setItems(list); toast.success("Leave type saved."); }} />
    </Section>
  );
}

// ------------------------------------------------------------------ working week and holidays
export function CalendarTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [settings, setSettings] = useState<HrSettings | null>(null);
  const [offs, setOffs] = useState<number[]>([]);
  const [year, setYear] = useState(Number(todayISO().slice(0, 4)));
  const [holidays, setHolidays] = useState<Holiday[] | null>(null);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Holiday | null>(null);
  const loadHolidays = useCallback(async () => {
    try { setHolidays(await apiFetch<Holiday[]>("/hr/holidays", { schoolId, query: { year } })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId, year]);
  useEffect(() => { apiFetch<HrSettings>("/hr/settings", { schoolId }).then((s) => { setSettings(s); setOffs(s.weekly_offs); }).catch((e) => setError(errorMessage(e))); }, [schoolId]);
  useEffect(() => { void loadHolidays(); }, [loadHolidays]);

  async function saveWeek() {
    if (!settings) return;
    setBusy(true);
    try { const s = await apiFetch<HrSettings>("/hr/settings", { schoolId, method: "PUT", body: { ...settings, weekly_offs: offs } }); setSettings(s); setOffs(s.weekly_offs); toast.success("Working week saved."); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function addHoliday(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!date) return setError("Choose the date.");
    if (name.trim().length < 2) return setError("Name the holiday.");
    setBusy(true);
    try { await apiFetch("/hr/holidays", { schoolId, method: "POST", body: { holiday_on: date, name: name.trim() } }); setDate(""); setName(""); toast.success("Holiday added."); if (Number(date.slice(0, 4)) !== year) setYear(Number(date.slice(0, 4))); else await loadHolidays(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!removing) return;
    try { await apiFetch(`/hr/holidays/${removing.id}`, { schoolId, method: "DELETE" }); setRemoving(null); toast.success("Holiday removed."); await loadHolidays(); }
    catch (e) { toast.error(errorMessage(e)); setRemoving(null); }
  }
  const changed = settings && [...offs].sort().join() !== [...settings.weekly_offs].sort().join();
  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      <Section title="Working week" description="Weekly offs aren't counted as leave days or working days." testId="working-week">
        <div className="space-y-2 p-5">
          {WEEKDAYS.map(([n, label]) => (
            <label key={n} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-leaf-600" checked={offs.includes(n)} data-testid={`off-${n}`}
                onChange={() => setOffs((xs) => (xs.includes(n) ? xs.filter((x) => x !== n) : [...xs, n]))} /> {label} is a weekly off
            </label>
          ))}
          <Button className="mt-2" size="sm" onClick={saveWeek} loading={busy} disabled={!changed || offs.length > 3} data-testid="save-week">Save</Button>
          {offs.length > 3 && <p className="text-xs text-danger-600">At most three weekly offs.</p>}
        </div>
      </Section>
      <Section title={`Holidays ${year}`} description="Not counted as leave days; not marked for attendance."
        action={<span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setYear(year - 1)}>{year - 1}</Button><Button size="sm" variant="ghost" onClick={() => setYear(year + 1)}>{year + 1}</Button></span>} testId="holidays">
        <form onSubmit={addHoliday} className="grid gap-3 border-b border-line p-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end" noValidate>
          <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="holiday-date" />
          <TextField label="Holiday" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali" data-testid="holiday-name" />
          <Button type="submit" loading={busy} data-testid="add-holiday"><Plus className="size-4" /> Add</Button>
          <div className="sm:col-span-3"><FormError error={error} testId="holiday-error" /></div>
        </form>
        {!holidays ? <LoadingState /> : holidays.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No holidays in {year}.</p> : (
          <ul className="divide-y divide-line text-sm" data-testid="holiday-list">
            {holidays.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <span><b className="font-medium">{formatDate(h.holiday_on)}</b> · {h.name}</span>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(h)} aria-label={`Remove ${h.name}`}><Trash2 className="size-4" /></Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <ConfirmDialog open={removing !== null} title={`Remove ${removing?.name ?? ""}?`} message="Leave already applied for over this date keeps its day count." confirmLabel="Remove" onConfirm={remove} onCancel={() => setRemoving(null)} />
    </div>
  );
}
