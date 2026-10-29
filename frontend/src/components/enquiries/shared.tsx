"use client";

import { clsx } from "clsx";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { apiFetch, errorMessage } from "@/lib/api";
import {
  type Duplicate, type EnquiryDetail, type EnquiryStatus, ENQUIRY_SOURCES, ENQUIRY_STATUS_LABEL, ENQUIRY_STATUSES, dayFromToday, isClosed,
} from "@/lib/enquiries";
import { formatDate, todayISO } from "@/lib/format";
import type { AcademicSession, ClassList, SchoolClass } from "@/lib/types";

export const textarea = "block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20";

const TONE: Record<EnquiryStatus, string> = {
  new: "bg-pencil-100 text-ink",
  contacted: "bg-paper text-ink ring-1 ring-inset ring-line",
  follow_up: "bg-pencil-100 text-ink ring-1 ring-inset ring-pencil-400",
  interested: "bg-leaf-50 text-leaf-700",
  application: "bg-white text-leaf-700 ring-1 ring-inset ring-leaf-600",
  approved: "bg-leaf-600 text-white",
  rejected: "bg-danger-50 text-danger-600",
  admitted: "bg-board-900 text-white",
};

export function EnquiryStatusBadge({ status }: { status: EnquiryStatus }) {
  return <span data-testid="enquiry-status" className={clsx("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", TONE[status])}>{ENQUIRY_STATUS_LABEL[status]}</span>;
}

/** "Overdue · 3 Oct", "Today", "12 Oct"; nothing for closed enquiries. */
export function FollowUpDate({ date, status }: { date: string | null; status: EnquiryStatus }) {
  if (isClosed(status)) return <span className="text-muted">—</span>;
  if (!date) return <span className="text-muted">Not set</span>;
  const today = dayFromToday(0);
  if (date < today) return <span className="font-medium text-danger-600" data-testid="follow-up-overdue">Overdue · {formatDate(date)}</span>;
  if (date === today) return <span className="font-medium text-leaf-700">Today</span>;
  return <span>{formatDate(date)}</span>;
}

export function useClassesAndSessions(schoolId: string) {
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  useEffect(() => {
    apiFetch<ClassList>("/classes", { schoolId, query: { status: "active" } }).then((r) => setClasses(r.items)).catch(() => setClasses([]));
    apiFetch<AcademicSession[]>("/sessions", { schoolId }).then(setSessions).catch(() => setSessions([]));
  }, [schoolId]);
  return { classes, sessions };
}
export const sessionLabel = (s: AcademicSession) => `${s.name}${s.is_current ? " (current)" : s.is_archived ? " (archived)" : ""}`;

function DuplicateWarning({ items }: { items: Duplicate[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-md border border-pencil-400 bg-pencil-100/60 p-3 text-sm" data-testid="duplicate-warning" role="status">
      <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4" /> This mobile number already has {items.length === 1 ? "an enquiry" : `${items.length} enquiries`}</p>
      <ul className="mt-1 space-y-0.5">
        {items.map((d) => (
          <li key={d.id}>
            <Link href={`/enquiries/${d.id}`} className="font-medium text-leaf-700 hover:underline" target="_blank">{d.enquiry_number}</Link>
            {" "}{d.student_name} · {ENQUIRY_STATUS_LABEL[d.status]} · {d.session_name}, {formatDate(d.enquiry_date)}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-muted">A sibling can have their own enquiry; otherwise update the existing one.</p>
    </div>
  );
}

const EMPTY = {
  academic_session_id: "", parent_name: "", student_name: "", phone: "", email: "", class_id: "", source: "walk_in", source_detail: "",
  enquiry_date: "", status: "new", follow_up_date: "", notes: "",
};
type Form = typeof EMPTY;

/** New enquiry, or editing an existing one's details. */
export function EnquiryFormModal({ schoolId, open, enquiry, onClose, onSaved }: {
  schoolId: string; open: boolean; enquiry?: EnquiryDetail; onClose: () => void; onSaved: (e: EnquiryDetail) => void;
}) {
  const { classes, sessions } = useClassesAndSessions(schoolId);
  const [f, setF] = useState<Form>(EMPTY);
  const [dups, setDups] = useState<Duplicate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = Boolean(enquiry);

  useEffect(() => {
    if (!open) return;
    setError(null); setDups([]);
    setF(enquiry ? {
      academic_session_id: enquiry.academic_session_id, parent_name: enquiry.parent_name, student_name: enquiry.student_name, phone: enquiry.phone,
      email: enquiry.email ?? "", class_id: enquiry.class_id ?? "", source: enquiry.source, source_detail: enquiry.source_detail ?? "",
      enquiry_date: enquiry.enquiry_date, status: enquiry.status, follow_up_date: enquiry.follow_up_date ?? "", notes: enquiry.notes ?? "",
    } : { ...EMPTY, enquiry_date: todayISO() });
  }, [open, enquiry]);
  useEffect(() => {
    if (!open || editing || f.academic_session_id || sessions.length === 0) return;
    const usable = sessions.filter((s) => !s.is_archived);
    const pick = usable.find((s) => s.is_current) ?? usable[0];
    if (pick) setF((x) => ({ ...x, academic_session_id: pick.id }));
  }, [open, editing, sessions, f.academic_session_id]);
  // earlier enquiries with the same mobile number
  useEffect(() => {
    if (!open) return;
    const digits = f.phone.replace(/\D/g, "");
    if (digits.length < 10 || (enquiry && f.phone === enquiry.phone)) { setDups([]); return; }
    const t = setTimeout(() => {
      apiFetch<Duplicate[]>("/enquiries/duplicates", { schoolId, query: { phone: f.phone, exclude: enquiry?.id } }).then(setDups).catch(() => setDups([]));
    }, 400);
    return () => clearTimeout(t);
  }, [open, f.phone, schoolId, enquiry]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setError(null);
    if (f.parent_name.trim().length < 2) return setError("Enter the parent's name.");
    if (f.student_name.trim().length < 2) return setError("Enter the student's name.");
    const digits = f.phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return setError("Enter a valid mobile number (10 to 15 digits).");
    if (!editing && f.status === "follow_up" && !f.follow_up_date) return setError("Choose the follow-up date.");
    if (!editing && f.follow_up_date && f.follow_up_date < dayFromToday(0)) return setError("The follow-up date can't be in the past.");
    const body: Record<string, string | null> = {};
    const keys: (keyof Form)[] = ["parent_name", "student_name", "phone", "email", "class_id", "source", "source_detail", "enquiry_date", "notes"];
    if (!editing) keys.push("academic_session_id", "status", "follow_up_date");
    for (const k of keys) {
      const v = f[k].trim() === "" ? null : f[k];
      if (!editing) { if (v !== null) body[k] = v; continue; }
      const was = ({ ...enquiry } as unknown as Record<string, string | null>)[k] ?? null;
      if (v !== was) body[k] = v;
    }
    if (editing && Object.keys(body).length === 0) { onClose(); return; }
    setBusy(true);
    try {
      const saved = await apiFetch<EnquiryDetail>(editing ? `/enquiries/${enquiry!.id}` : "/enquiries", { schoolId, method: editing ? "PATCH" : "POST", body });
      onSaved(saved);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" onClose={busy ? () => {} : onClose} title={editing ? `Edit ${enquiry!.enquiry_number}` : "New enquiry"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-enquiry">{editing ? "Save" : "Add enquiry"}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Parent's name" required value={f.parent_name} maxLength={150} onChange={set("parent_name")} />
        <TextField label="Student's name" required value={f.student_name} maxLength={150} onChange={set("student_name")} />
        <TextField label="Mobile number" required inputMode="tel" value={f.phone} maxLength={20} onChange={set("phone")} />
        <TextField label="Email (optional)" type="email" value={f.email} onChange={set("email")} />
        <div className="sm:col-span-2"><DuplicateWarning items={dups} /></div>
        <SelectField label="Interested class" value={f.class_id} onChange={set("class_id")}>
          <option value="">Not decided</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        {!editing && (
          <SelectField label="For session" value={f.academic_session_id} onChange={set("academic_session_id")}>
            {sessions.filter((s) => !s.is_archived).map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
          </SelectField>
        )}
        <SelectField label="Source" value={f.source} onChange={set("source")}>
          {ENQUIRY_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </SelectField>
        <TextField label="Source detail (optional)" value={f.source_detail} maxLength={100} onChange={set("source_detail")}
          placeholder={f.source === "referral" ? "Who referred them" : "e.g. Times of India, Diwali mela"} />
        <TextField label="Enquiry date" type="date" value={f.enquiry_date} max={todayISO()} onChange={set("enquiry_date")} />
        {!editing && <>
          <SelectField label="Status" value={f.status} onChange={set("status")}>
            {ENQUIRY_STATUSES.filter((s) => !["application", "approved", "admitted"].includes(s)).map((s) => <option key={s} value={s}>{ENQUIRY_STATUS_LABEL[s]}</option>)}
          </SelectField>
          <TextField label={f.status === "follow_up" ? "Follow-up date *" : "Follow-up date (optional)"} type="date" min={dayFromToday(0)} value={f.follow_up_date} onChange={set("follow_up_date")} />
        </>}
        <label className="block text-sm font-medium sm:col-span-2">Notes
          <textarea className={`${textarea} mt-1.5`} rows={3} maxLength={2000} value={f.notes} onChange={set("notes")}
            placeholder="What they asked about: fees, transport, timings…" />
        </label>
        {error && <p className="text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="enquiry-form-error">{error}</p>}
      </div>
    </Modal>
  );
}
