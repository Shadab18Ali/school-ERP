"use client";

import { ArrowLeft, Download, Eye, FileText, Pencil, Receipt, UserRound } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import { AdmissionStepper } from "@/components/admissions/stepper";
import { AdmissionStatusBadge, type AdmissionDetail, type AdmissionWindowRow, staffLabel } from "@/components/admissions/shared";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate, formatDateTime, formatPhone, todayISO } from "@/lib/format";
import { inr } from "@/lib/public-api";
import type { Paginated, Section } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const MODES: [string, string][] = [["cash", "Cash"], ["upi", "UPI"], ["bank_transfer", "Bank transfer"], ["cheque", "Cheque"], ["other", "Other"]];
const textarea = "block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20";

function Card({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section className="rounded-lg border border-line bg-white p-4" data-testid={testid}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}
function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd>{v || v === 0 ? v : "—"}</dd></div>)}
    </dl>
  );
}

type Action = "under_review" | "verified" | "approved" | "rejected" | "reopen";
const ACTION_TEXT: Record<Action, { title: string; button: string; help: string }> = {
  under_review: { title: "Start review", button: "Start review", help: "Check the details and documents. The parent will see “Under review”." },
  verified: { title: "Mark as verified", button: "Mark verified", help: "Confirm that the details and documents have been checked and are correct." },
  approved: { title: "Approve application", button: "Approve", help: "Approving takes a seat and asks the parent to pay the admission fee." },
  rejected: { title: "Reject application", button: "Reject", help: "The parent will see the reason when they check the status." },
  reopen: { title: "Reopen application", button: "Reopen", help: "Moves the application back to review. The rejection reason is cleared." },
};

function StatusModal({ schoolId, app, action, onClose, onDone }: { schoolId: string; app: AdmissionDetail; action: Action | null; onClose: () => void; onDone: (d: AdmissionDetail) => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNote(""); setError(null); }, [action]);
  if (!action) return null;
  const t = ACTION_TEXT[action];
  const reject = action === "rejected";
  async function save() {
    if (reject && note.trim().length < 3) { setError("Give the reason for rejecting (the parent will see it)."); return; }
    setBusy(true); setError(null);
    try {
      const status = action === "reopen" ? "under_review" : action;
      const d = await apiFetch<AdmissionDetail>(`/admissions/${app.id}/status`, {
        schoolId, method: "POST", body: { status, note: reject ? null : note.trim() || null, rejection_reason: reject ? note.trim() : null },
      });
      onDone(d);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={t.title} description={`${app.application_number} · ${app.student_name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={reject ? "danger" : "primary"} onClick={save} loading={busy} data-testid="confirm-status">{t.button}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm">{t.help}</p>
        {action === "approved" && (
          <p className="rounded-md bg-paper p-3 text-sm" data-testid="approve-summary">
            Admission fee: <span className="font-medium">{inr(app.fee_due)}</span>
            {app.seats !== null && <> · Seats taken: <span className="font-medium">{app.seats_taken} of {app.seats}</span></>}
          </p>
        )}
        <label className="block text-sm font-medium">
          {reject ? "Reason (shown to the parent)" : "Note for the school (optional)"}
          <textarea className={`${textarea} mt-1.5`} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="status-note" />
        </label>
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="status-error">{error}</p>}
      </div>
    </Modal>
  );
}

function FeeModal({ schoolId, app, open, onClose, onDone }: { schoolId: string; app: AdmissionDetail; open: boolean; onClose: () => void; onDone: (d: AdmissionDetail) => void }) {
  const [mode, setMode] = useState("cash");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(todayISO());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setMode("cash"); setReference(""); setPaidOn(todayISO()); setError(null); } }, [open]);
  const free = Number(app.fee_due ?? 0) === 0;
  async function save() {
    if (!paidOn) { setError("Enter the payment date."); return; }
    if (paidOn > todayISO()) { setError("The payment date can't be in the future."); return; }
    setBusy(true); setError(null);
    try {
      onDone(await apiFetch<AdmissionDetail>(`/admissions/${app.id}/fee`, {
        schoolId, method: "POST", body: { amount: app.fee_due, payment_mode: free ? null : mode, reference: reference.trim() || null, paid_on: paidOn },
      }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Record admission fee" description={`${app.application_number} · ${app.student_name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-fee">Record payment</Button></>}>
      <div className="space-y-4">
        <p className="rounded-md bg-paper p-3 text-sm">Admission fee for {app.class_name}: <span className="text-base font-semibold" data-testid="fee-due">{inr(app.fee_due)}</span>
          {free && <span className="block text-muted">No fee is charged; recording it confirms the admission.</span>}</p>
        {!free && (
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label="Paid by" value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </SelectField>
            <TextField label="Reference (optional)" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} placeholder="UPI / cheque number" />
          </div>
        )}
        <TextField label="Payment date" type="date" value={paidOn} max={todayISO()} onChange={(e) => setPaidOn(e.target.value)} />
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="fee-error">{error}</p>}
      </div>
    </Modal>
  );
}

function EnrollModal({ schoolId, app, open, onClose, onDone }: { schoolId: string; app: AdmissionDetail; open: boolean; onClose: () => void; onDone: (d: AdmissionDetail) => void }) {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [section, setSection] = useState("");
  const [number, setNumber] = useState(app.application_number);
  const [date, setDate] = useState(todayISO());
  const [invite, setInvite] = useState(Boolean(app.contact_email));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null); setNumber(app.application_number); setDate(todayISO()); setInvite(Boolean(app.contact_email)); setSections(null);
    apiFetch<Paginated<Section>>("/sections", { schoolId, query: { session_id: app.academic_session_id, class_id: app.class_id, status: "active", page_size: 100 } })
      .then((r) => { setSections(r.items); setSection(r.items.length === 1 ? r.items[0].id : ""); })
      .catch((e) => { setSections([]); setError(errorMessage(e)); });
  }, [open, schoolId, app.academic_session_id, app.class_id, app.application_number, app.contact_email]);
  async function save() {
    if (!section) { setError("Choose the section."); return; }
    if (!number.trim()) { setError("Enter the admission number."); return; }
    setBusy(true); setError(null);
    try {
      onDone(await apiFetch<AdmissionDetail>(`/admissions/${app.id}/enroll`, {
        schoolId, method: "POST", body: { section_id: section, admission_number: number.trim(), admission_date: date || null, invite_parent: invite },
      }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Create student" description={`${app.student_name} · ${app.class_name} · ${app.session_name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={sections?.length === 0} data-testid="confirm-enroll">Create student</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-muted">The student record is created from the application, with the photo and documents, and enrolled in the section you choose.</p>
        {sections === null ? <p className="text-sm text-muted">Loading sections…</p> : sections.length === 0 ? (
          <p className="text-sm text-danger-600">{app.class_name} has no active section in {app.session_name}. Add one under Classes &amp; sections first.</p>
        ) : (
          <SelectField label="Section" value={section} onChange={(e) => setSection(e.target.value)} data-testid="enroll-section">
            <option value="">Choose section</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.class_name} {s.name}{s.capacity ? ` (${s.student_count}/${s.capacity})` : ""}</option>)}
          </SelectField>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Admission number" value={number} maxLength={30} onChange={(e) => setNumber(e.target.value)} />
          <TextField label="Admission date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={invite} disabled={!app.contact_email} onChange={(e) => setInvite(e.target.checked)} data-testid="invite-parent" />
          <span>Invite the parent to the parent portal{app.contact_email ? ` (${app.contact_email})` : " — no email was given"}</span>
        </label>
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="enroll-error">{error}</p>}
      </div>
    </Modal>
  );
}

function EditModal({ schoolId, app, open, onClose, onDone }: { schoolId: string; app: AdmissionDetail; open: boolean; onClose: () => void; onDone: (d: AdmissionDetail) => void }) {
  const init = () => ({
    student_name: app.student_name, date_of_birth: app.date_of_birth, gender: app.gender, father_name: app.father_name ?? "", mother_name: app.mother_name ?? "",
    contact_phone: app.contact_phone, contact_email: app.contact_email ?? "", address_line: app.address_line, city: app.city, state: app.state,
    postal_code: app.postal_code, class_id: app.class_id, review_note: app.review_note ?? "",
  });
  const [v, setV] = useState(init);
  const [classes, setClasses] = useState<AdmissionWindowRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const classFixed = ["approved", "fee_paid", "enrolled"].includes(app.status);
  useEffect(() => {
    if (!open) return;
    setV(init()); setError(null);
    if (!classFixed) apiFetch<AdmissionWindowRow[]>("/admissions/windows", { schoolId, query: { session_id: app.academic_session_id } }).then(setClasses).catch(() => setClasses([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof ReturnType<typeof init>) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  async function save() {
    const o = init();
    const body: Record<string, string | null> = {};
    for (const k of Object.keys(v) as (keyof typeof v)[]) if (v[k] !== o[k]) body[k] = v[k].trim() === "" ? null : v[k].trim();
    if (Object.keys(body).length === 0) { onClose(); return; }
    setBusy(true); setError(null);
    try { onDone(await apiFetch<AdmissionDetail>(`/admissions/${app.id}`, { schoolId, method: "PATCH", body })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} size="lg" onClose={busy ? () => {} : onClose} title="Correct details" description="Changes are recorded in the audit log."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-details">Save</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Child's name" value={v.student_name} maxLength={150} onChange={set("student_name")} />
        <TextField label="Date of birth" type="date" value={v.date_of_birth} onChange={set("date_of_birth")} />
        <SelectField label="Gender" value={v.gender} onChange={set("gender")}><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></SelectField>
        {classFixed ? <TextField label="Class" value={app.class_name} disabled hint="Fixed once approved" /> : (
          <SelectField label="Class" value={v.class_id} onChange={set("class_id")}>
            {classes.length === 0 && <option value={app.class_id}>{app.class_name}</option>}
            {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
          </SelectField>
        )}
        <TextField label="Father's name" value={v.father_name} maxLength={150} onChange={set("father_name")} />
        <TextField label="Mother's name" value={v.mother_name} maxLength={150} onChange={set("mother_name")} />
        <TextField label="Contact mobile" value={v.contact_phone} onChange={set("contact_phone")} />
        <TextField label="Email" type="email" value={v.contact_email} onChange={set("contact_email")} />
        <TextField label="Address" className="sm:col-span-2" value={v.address_line} maxLength={300} onChange={set("address_line")} />
        <TextField label="City" value={v.city} maxLength={80} onChange={set("city")} />
        <TextField label="State" value={v.state} maxLength={80} onChange={set("state")} />
        <TextField label="PIN code" value={v.postal_code} maxLength={6} onChange={set("postal_code")} />
        <label className="block text-sm font-medium sm:col-span-2">Review note (staff only)
          <textarea className={`${textarea} mt-1.5`} rows={2} maxLength={1000} value={v.review_note} onChange={set("review_note")} />
        </label>
        {error && <p className="text-sm text-danger-600 sm:col-span-2" role="alert" data-testid="details-error">{error}</p>}
      </div>
    </Modal>
  );
}

function Detail({ id }: { id: string }) {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const [app, setApp] = useState<AdmissionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [modal, setModal] = useState<"fee" | "enroll" | "edit" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setApp(await apiFetch<AdmissionDetail>(`/admissions/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!app?.has_photo) return;
    let url: string | null = null;
    apiFetchBlob(`/admissions/${id}/photo`, { schoolId }).then(({ blob }) => { url = URL.createObjectURL(blob); setPhoto(url); }).catch(() => setPhoto(null));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [id, schoolId, app?.has_photo]);

  function done(d: AdmissionDetail, message: string) {
    setApp(d); setAction(null); setModal(null); toast.success(message);
    if (d.parent_invite_error) toast.error(`Student created, but the parent invitation failed: ${d.parent_invite_error}`);
  }
  async function openDoc(docId: string, name: string, download: boolean) {
    try {
      const { blob } = await apiFetchBlob(`/admissions/${id}/documents/${docId}`, { schoolId, query: { download: download ? "true" : undefined } });
      if (download) { saveBlob(blob, name); return; }
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { toast.error(errorMessage(e)); }
  }
  async function receipt() {
    try { const { blob, filename } = await apiFetchBlob(`/admissions/${id}/fee-receipt.pdf`, { schoolId }); saveBlob(blob, filename ?? `admission-receipt-${app!.fee_receipt_number}.pdf`); }
    catch (e) { toast.error(errorMessage(e)); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!app) return <LoadingState />;
  const manage = can("admissions:manage");
  const s = app.status;
  const actions: ReactNode[] = [];
  if (manage && s === "submitted") actions.push(<Button key="r" onClick={() => setAction("under_review")} data-testid="action-review">Start review</Button>);
  if (manage && s === "under_review") actions.push(<Button key="v" onClick={() => setAction("verified")} data-testid="action-verify">Mark verified</Button>);
  if (manage && s === "verified") actions.push(<Button key="a" onClick={() => setAction("approved")} data-testid="action-approve">Approve</Button>);
  if (can("admissions:fee") && s === "approved") actions.push(<Button key="f" onClick={() => setModal("fee")} data-testid="action-fee">Record admission fee</Button>);
  if (manage && s === "fee_paid") actions.push(<Button key="e" onClick={() => setModal("enroll")} data-testid="action-enroll">Create student</Button>);
  if (manage && ["submitted", "under_review", "verified", "approved"].includes(s)) actions.push(<Button key="x" variant="danger" onClick={() => setAction("rejected")} data-testid="action-reject">Reject</Button>);
  if (manage && s === "rejected") actions.push(<Button key="o" variant="secondary" onClick={() => setAction("reopen")} data-testid="action-reopen">Reopen</Button>);
  const nextHint: Record<typeof s, string> = {
    submitted: "New application. Start the review when you begin checking it.",
    under_review: "Check the details and documents, then mark it verified or reject it.",
    verified: "Verified. Approve to take a seat and ask for the admission fee, or reject.",
    approved: "Approved. Waiting for the admission fee to be paid at the school office.",
    fee_paid: "Fee received. Create the student to complete the admission.",
    enrolled: "Admission complete.",
    rejected: "Rejected. You can reopen it if this was a mistake.",
  };

  return (
    <>
      <Link href="/admissions" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Admissions</Link>
      <PageHeader title={app.student_name} description={`${app.application_number} · ${app.class_name} · ${app.session_name}`} />
      <section className="mb-4 space-y-4 rounded-lg border border-line bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2"><AdmissionStatusBadge status={s} /><span className="text-sm text-muted">{nextHint[s]}</span></div>
          <div className="flex flex-wrap gap-2" data-testid="admission-actions">
            {actions}
            {manage && s !== "enrolled" && <Button variant="secondary" onClick={() => setModal("edit")} data-testid="action-edit"><Pencil className="size-4" /> Correct details</Button>}
          </div>
        </div>
        <AdmissionStepper status={s} history={app.timeline.map((t) => t.to)} />
        {s === "rejected" && app.rejection_reason && <p className="rounded-md bg-danger-50 p-3 text-sm text-danger-600" data-testid="rejection-reason">Reason: {app.rejection_reason}</p>}
        {app.student_id && (
          <p className="rounded-md bg-leaf-50 p-3 text-sm" data-testid="created-student">
            Student created{app.student_code ? ` (${app.student_code})` : ""}. <Link href={`/students/${app.student_id}`} className="font-medium text-leaf-700 hover:underline">Open student record</Link>
          </p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Child">
            <div className="flex gap-4">
              {photo
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={photo} alt={`Photo of ${app.student_name}`} className="size-28 rounded-md border border-line object-cover" data-testid="applicant-photo" />
                : <div className="grid size-28 place-items-center rounded-md bg-paper"><UserRound className="size-10 text-muted" /></div>}
              <Rows rows={[["Name", app.student_name], ["Date of birth", formatDate(app.date_of_birth)], ["Gender", app.gender[0].toUpperCase() + app.gender.slice(1)], ["Blood group", app.blood_group], ["Class applied", `${app.class_name} (${app.session_name})`]]} />
            </div>
          </Card>
          <Card title="Parents">
            <Rows rows={[
              ["Father", app.father_name ? [app.father_name, app.father_phone ? formatPhone(app.father_phone) : null, app.father_occupation].filter(Boolean).join(" · ") : null],
              ["Mother", app.mother_name ? [app.mother_name, app.mother_phone ? formatPhone(app.mother_phone) : null, app.mother_occupation].filter(Boolean).join(" · ") : null],
              ["Contact mobile", formatPhone(app.contact_phone)], ["Email", app.contact_email],
            ]} />
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Address"><p className="text-sm">{app.address_line}<br />{app.city}, {app.state} {app.postal_code}</p></Card>
            <Card title="Previous school"><Rows rows={[["School", app.previous_school], ["Class", app.previous_class], ["Board", app.previous_board]]} /></Card>
          </div>
          <Card title="Documents" testid="application-documents">
            {app.documents.length === 0 ? <p className="text-sm text-muted">No documents were attached.</p> : (
              <ul className="divide-y divide-line">
                {app.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <FileText className="size-4 text-muted" />
                    <span className="min-w-0 flex-1"><span className="font-medium">{d.label}</span><span className="block truncate text-xs text-muted">{d.file_name} · {Math.max(1, Math.round(d.size_bytes / 1024))} KB</span></span>
                    <Button size="sm" variant="ghost" onClick={() => openDoc(d.id, d.file_name, false)} aria-label={`View ${d.label}`}><Eye className="size-4" /> View</Button>
                    <Button size="sm" variant="ghost" onClick={() => openDoc(d.id, d.file_name, true)} aria-label={`Download ${d.label}`}><Download className="size-4" /></Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Admission fee" testid="fee-card">
            <Rows rows={[
              ["Fee", inr(app.fee_due)],
              ["Paid", app.fee_paid_amount !== null ? `${inr(app.fee_paid_amount)} on ${formatDate(app.fee_paid_on)}` : "Not yet"],
              ["Mode", app.fee_payment_mode ? MODES.find(([v]) => v === app.fee_payment_mode)?.[1] ?? app.fee_payment_mode : null],
              ["Reference", app.fee_reference], ["Receipt", app.fee_receipt_number],
            ]} />
            {app.fee_receipt_number && <Button className="mt-3" size="sm" variant="secondary" onClick={receipt} data-testid="download-admission-receipt"><Receipt className="size-4" /> Download receipt</Button>}
            {app.seats !== null && <p className="mt-3 text-xs text-muted">Seats for {app.class_name}: {app.seats_taken} of {app.seats} taken</p>}
          </Card>
          {app.review_note && <Card title="Review note"><p className="whitespace-pre-line text-sm">{app.review_note}</p></Card>}
          <Card title="History" testid="admission-timeline">
            <ol className="space-y-3 border-l-2 border-line pl-4 text-sm">
              {app.timeline.map((t, i) => (
                <li key={i}>
                  <span className="font-medium">{t.from === null ? "Application submitted" : staffLabel(t.to)}</span>
                  <span className="block text-xs text-muted">{formatDateTime(t.at)}{t.by ? ` · ${t.by}` : ""}</span>
                  {t.note && <span className="block text-xs">{t.note}</span>}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-muted">Submitted {formatDateTime(app.submitted_at)}</p>
          </Card>
        </div>
      </div>

      <StatusModal schoolId={schoolId} app={app} action={action} onClose={() => setAction(null)}
        onDone={(d) => done(d, action === "rejected" ? "Application rejected." : `Application: ${staffLabel(d.status)}.`)} />
      <FeeModal schoolId={schoolId} app={app} open={modal === "fee"} onClose={() => setModal(null)} onDone={(d) => done(d, `Admission fee recorded. Receipt ${d.fee_receipt_number}.`)} />
      <EnrollModal schoolId={schoolId} app={app} open={modal === "enroll"} onClose={() => setModal(null)} onDone={(d) => done(d, "Student created.")} />
      <EditModal schoolId={schoolId} app={app} open={modal === "edit"} onClose={() => setModal(null)} onDone={(d) => done(d, "Details saved.")} />
    </>
  );
}

export default function AdmissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="admissions:view"><Detail id={id} /></RequirePermission>;
}
