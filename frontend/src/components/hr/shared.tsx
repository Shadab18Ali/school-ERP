"use client";

import { clsx } from "clsx";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { days, LEAVE_STATUS_LABEL, plural, type Balance, type Leave, type LeaveStatus, type LeaveType, type StaffMember } from "@/lib/hr";

export function Pill({ tone, children, testId }: { tone: "ok" | "warn" | "bad" | "muted"; children: ReactNode; testId?: string }) {
  const cls = { ok: "bg-leaf-50 text-leaf-700", warn: "bg-pencil-100 text-ink", bad: "bg-danger-50 text-danger-600", muted: "bg-ink/5 text-muted" }[tone];
  return <span className={clsx("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", cls)} data-testid={testId}>{children}</span>;
}

export function LeaveStatusPill({ status }: { status: LeaveStatus }) {
  const tone = status === "approved" ? "ok" : status === "pending" ? "warn" : status === "rejected" ? "bad" : "muted";
  return <Pill tone={tone} testId="leave-status">{LEAVE_STATUS_LABEL[status]}</Pill>;
}

export function Section({ title, description, action, children, testId }: { title: string; description?: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function FormError({ error, testId }: { error: string | null; testId?: string }) {
  return error ? <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid={testId}>{error}</p> : null;
}

export function TextArea({ label, value, onChange, maxLength = 500, required, testId }: { label: string; value: string; onChange: (v: string) => void; maxLength?: number; required?: boolean; testId?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}{required && <span className="text-danger-600"> *</span>}</label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} rows={2} data-testid={testId}
        className="block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
    </div>
  );
}

/** "12 Oct 2026" / "12–14 Oct 2026" / "12 Oct 2026 (half day)". */
export function leaveDates(l: Pick<Leave, "start_date" | "end_date" | "half_day">): string {
  if (l.start_date === l.end_date) return `${formatDate(l.start_date)}${l.half_day ? " (half day)" : ""}`;
  return `${formatDate(l.start_date)} – ${formatDate(l.end_date)}`;
}

/** One application: who, what, when, why, and its decision. */
export function LeaveSummary({ l, showStaff = true }: { l: Leave; showStaff?: boolean }) {
  return (
    <div className="min-w-0 flex-1 basis-64 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        {showStaff && <span className="font-medium">{l.staff_name} <span className="text-xs font-normal text-muted">{l.employee_id}</span></span>}
        <span className={clsx(!showStaff && "font-medium")}>{l.leave_type}{!l.is_paid && <span className="text-muted"> (unpaid)</span>}</span>
        <LeaveStatusPill status={l.status} />
      </p>
      <p><span data-testid="leave-dates">{leaveDates(l)}</span> · <b className="font-medium" data-testid="leave-days">{plural(l.days, "day")}</b></p>
      <p className="text-muted">“{l.reason}”</p>
      <p className="text-xs text-muted">
        Applied {formatDate(l.applied_at)}{l.applied_by_name ? ` by ${l.applied_by_name}` : ""}
        {l.decided_at && ` · ${l.status === "cancelled" ? "decided" : l.status} ${formatDate(l.decided_at)}${l.decided_by_name ? ` by ${l.decided_by_name}` : ""}`}
        {l.cancelled_at && ` · cancelled ${formatDate(l.cancelled_at)}`}
        {l.decision_note && <span data-testid="decision-note"> · “{l.decision_note}”</span>}
      </p>
    </div>
  );
}

/** A card per leave type: allowance, used, pending, available. */
export function BalanceCards({ balances }: { balances: Balance[] }) {
  if (balances.length === 0) return <p className="text-sm text-muted">The school hasn&apos;t set up leave types yet.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="balances">
      {balances.map((b) => (
        <div key={b.leave_type_id} className="rounded-lg border border-line bg-white p-4" data-testid={`balance-${b.code}`}>
          <p className="text-sm text-muted">{b.name} <span className="text-xs">({b.code}){!b.is_paid && " · unpaid"}</span></p>
          <p className="tabular mt-1 text-2xl font-semibold" data-testid="balance-available">{b.available === null ? "No limit" : days(b.available)}</p>
          <p className="text-xs text-muted">
            {b.available === null ? "" : "available · "}{b.allowance === null ? "" : `${days(b.allowance)} allowed · `}{days(b.used)} taken{Number(b.pending) > 0 ? ` · ${days(b.pending)} pending` : ""}
          </p>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ apply
export function ApplyLeaveModal({ schoolId, open, forStaff, onClose, onDone, balances }: {
  schoolId: string; open: boolean; forStaff?: boolean; balances?: Balance[]; onClose: () => void; onDone: (l: Leave) => void;
}) {
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [teacher, setTeacher] = useState("");
  const [type, setType] = useState("");
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
  const [half, setHalf] = useState(false);
  const [reason, setReason] = useState("");
  const [count, setCount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTeacher(""); setType(""); setStart(todayISO()); setEnd(todayISO()); setHalf(false); setReason(""); setError(null);
    apiFetch<LeaveType[]>("/hr/leave-types", { schoolId }).then((t) => setTypes(t.filter((x) => x.is_active))).catch((e) => setError(errorMessage(e)));
    if (forStaff) apiFetch<StaffMember[]>("/hr/staff", { schoolId }).then(setStaff).catch(() => setStaff([]));
  }, [open, forStaff, schoolId]);
  const chosen = types.find((t) => t.id === type);
  const single = start === end;
  useEffect(() => { if (!single || (chosen && !chosen.allow_half_day)) setHalf(false); }, [single, chosen]);
  useEffect(() => {
    if (!open || !start || !end || end < start) { setCount(null); return; }
    const t = window.setTimeout(() => {
      apiFetch<{ days: string | null }>("/hr/leave-days", { schoolId, query: { start, end, half: half ? "true" : undefined } })
        .then((r) => setCount(r.days)).catch(() => setCount(null));
    }, 200);
    return () => window.clearTimeout(t);
  }, [open, start, end, half, schoolId]);
  const balance = balances?.find((b) => b.leave_type_id === type);

  async function save() {
    setError(null);
    if (forStaff && !teacher) return setError("Choose the staff member.");
    if (!type) return setError("Choose the type of leave.");
    if (!start || !end) return setError("Enter the dates.");
    if (end < start) return setError("The leave ends before it starts.");
    if (reason.trim().length < 3) return setError("Give the reason for the leave.");
    setBusy(true);
    try {
      onDone(await apiFetch<Leave>(forStaff ? "/hr/leave" : "/hr/my/leave", { schoolId, method: "POST",
        body: { leave_type_id: type, start_date: start, end_date: end, half_day: half, reason: reason.trim(), ...(forStaff ? { teacher_id: teacher } : {}) } }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} title={forStaff ? "Record leave for a staff member" : "Apply for leave"} onClose={busy ? () => {} : onClose}
      description={forStaff ? "It is added as pending; approve it from Requests." : "Your school office approves or rejects it. Weekly offs and holidays aren't counted."}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="submit-leave">{forStaff ? "Add" : "Apply"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormError error={error} testId="leave-error" /></div>
        {forStaff && (
          <SelectField className="sm:col-span-2" label="Staff member" value={teacher} onChange={(e) => setTeacher(e.target.value)} data-testid="leave-staff">
            <option value="">Choose…</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.employee_id})</option>)}
          </SelectField>
        )}
        <SelectField className="sm:col-span-2" label="Type of leave" value={type} onChange={(e) => setType(e.target.value)} data-testid="leave-type">
          <option value="">{types.length ? "Choose…" : "No leave types yet"}</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code}){!t.is_paid ? " · unpaid" : ""}</option>)}
        </SelectField>
        <TextField label="From" type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} data-testid="leave-from" />
        <TextField label="To" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} data-testid="leave-to" />
        {single && (!chosen || chosen.allow_half_day) && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="size-4 accent-leaf-600" checked={half} onChange={(e) => setHalf(e.target.checked)} data-testid="leave-half" /> Half day
          </label>
        )}
        <p className="rounded-md bg-paper px-3 py-2 text-sm sm:col-span-2" data-testid="leave-count">
          {count === null ? "Choose the dates." : Number(count) === 0 ? "Those dates are all weekly offs or holidays." : <>This takes <b>{plural(count, "working day")}</b>{balance && balance.available !== null ? ` of the ${days(balance.available)} available` : ""}.</>}
        </p>
        <div className="sm:col-span-2"><TextArea label="Reason" required value={reason} onChange={setReason} testId="leave-reason" /></div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ decide, cancel
export function DecideModal({ schoolId, leave, approve, onClose, onDone }: { schoolId: string; leave: Leave | null; approve: boolean; onClose: () => void; onDone: (l: Leave) => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNote(""); setError(null); }, [leave, approve]);
  if (!leave) return null;
  async function go() {
    if (!approve && note.trim().length < 2) return setError("Give the reason for rejecting. The staff member sees it.");
    setBusy(true); setError(null);
    try { onDone(await apiFetch<Leave>(`/hr/leave/${leave!.id}/decide`, { schoolId, method: "POST", body: { approve, note: note.trim() || null } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open size="sm" title={`${approve ? "Approve" : "Reject"} ${leave.staff_name}'s leave?`} description={`${leave.leave_type} · ${leaveDates(leave)} · ${plural(leave.days, "day")}`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant={approve ? "primary" : "danger"} onClick={go} loading={busy} data-testid="confirm-decision">{approve ? "Approve" : "Reject"}</Button></>}>
      <div className="space-y-3">
        <FormError error={error} testId="decide-error" />
        <p className="text-sm text-muted">“{leave.reason}”</p>
        <TextArea label={approve ? "Note (optional)" : "Reason for rejecting"} required={!approve} value={note} onChange={setNote} maxLength={300} testId="decision-note-input" />
      </div>
    </Modal>
  );
}

export function CancelLeaveModal({ schoolId, leave, onClose, onDone }: { schoolId: string; leave: Leave | null; onClose: () => void; onDone: (l: Leave) => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNote(""); setError(null); }, [leave]);
  if (!leave) return null;
  async function go() {
    setBusy(true); setError(null);
    try { onDone(await apiFetch<Leave>(`/hr/leave/${leave!.id}/cancel`, { schoolId, method: "POST", body: { note: note.trim() || null } })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open size="sm" title="Cancel this leave?" description={`${leave.leave_type} · ${leaveDates(leave)}`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Keep it</Button><Button variant="danger" onClick={go} loading={busy} data-testid="confirm-cancel-leave">Cancel leave</Button></>}>
      <div className="space-y-3">
        <FormError error={error} testId="cancel-error" />
        <p className="text-sm">{leave.status === "approved" ? "The days go back to the balance." : "The request is withdrawn."}</p>
        <TextArea label="Note (optional)" value={note} onChange={setNote} maxLength={300} />
      </div>
    </Modal>
  );
}

/** Pick an academic session (leave years follow the sessions). */
export function SessionSelect({ sessions, value, onChange }: { sessions: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  if (sessions.length < 2) return null;
  return (
    <SelectField label="Session" hideLabel className="w-40" value={value} onChange={(e) => onChange(e.target.value)} data-testid="session-select">
      {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </SelectField>
  );
}
