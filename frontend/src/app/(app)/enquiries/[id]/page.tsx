"use client";

import { ArrowLeft, Link2, MessageCircle, Pencil, Phone, Trash2, Unlink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { EnquiryFormModal, EnquiryStatusBadge, FollowUpDate, textarea } from "@/components/enquiries/shared";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import {
  type EnquiryActivity, type EnquiryDetail, type EnquiryStatus, ENQUIRY_STATUS_LABEL, ENQUIRY_STATUSES, SOURCE_LABEL, dayFromToday, isClosed, whatsappLink,
} from "@/lib/enquiries";
import { formatDate, formatDateTime, formatPhone } from "@/lib/format";
import { useAuth } from "@/providers/auth-provider";

function Card({ title, action, children, testid }: { title: string; action?: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <section className="rounded-lg border border-line bg-white p-4" data-testid={testid}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>{action}
      </div>
      {children}
    </section>
  );
}

function activityText(a: EnquiryActivity): string {
  switch (a.kind) {
    case "created": return `Enquiry added (${a.to ? ENQUIRY_STATUS_LABEL[a.to] : "New"})${a.follow_up_date ? `, follow-up ${formatDate(a.follow_up_date)}` : ""}`;
    case "status": return `${a.from ? ENQUIRY_STATUS_LABEL[a.from] : "—"} → ${a.to ? ENQUIRY_STATUS_LABEL[a.to] : "—"}${a.follow_up_date ? `, follow-up ${formatDate(a.follow_up_date)}` : ""}`;
    case "follow_up": return a.follow_up_date ? `Follow-up set for ${formatDate(a.follow_up_date)}` : "Follow-up date cleared";
    case "note": return "Note";
    case "linked": return `Linked to online application${a.to ? ` (${ENQUIRY_STATUS_LABEL[a.to]})` : ""}`;
    case "unlinked": return "Unlinked from the online application";
  }
}

const QUICK: [string, number][] = [["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]];

/** The everyday action: what happened, the new status, when to call next. */
function UpdatePanel({ schoolId, e, onSaved }: { schoolId: string; e: EnquiryDetail; onSaved: (d: EnquiryDetail) => void }) {
  const [status, setStatus] = useState<EnquiryStatus>(e.status);
  const [followUp, setFollowUp] = useState(e.follow_up_date ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setStatus(e.status); setFollowUp(e.follow_up_date ?? ""); }, [e.status, e.follow_up_date]);
  const linked = Boolean(e.application_id);
  const closing = isClosed(status);

  async function save() {
    setError(null);
    const body: Record<string, string | null> = {};
    if (status !== e.status) body.status = status;
    const fu = closing ? null : followUp || null;
    if (!closing && fu !== e.follow_up_date) body.follow_up_date = fu;
    if (note.trim()) body.activity_note = note.trim();
    if (Object.keys(body).length === 0) return setError("Change the status or follow-up date, or write a note.");
    if (status === "follow_up" && !fu) return setError("Choose the follow-up date.");
    if (fu && fu !== e.follow_up_date && fu < dayFromToday(0)) return setError("The follow-up date can't be in the past.");
    setBusy(true);
    try { onSaved(await apiFetch<EnquiryDetail>(`/enquiries/${e.id}`, { schoolId, method: "PATCH", body })); setNote(""); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Card title="Update" testid="update-panel">
      <div className="space-y-3">
        <label className="block text-sm font-medium">What happened?
          <textarea className={`${textarea} mt-1.5`} rows={2} maxLength={1000} value={note} onChange={(ev) => setNote(ev.target.value)}
            placeholder="e.g. Called; parents will visit on Saturday with the birth certificate." data-testid="update-note" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Status" value={status} disabled={linked} onChange={(ev) => setStatus(ev.target.value as EnquiryStatus)} data-testid="update-status">
            {ENQUIRY_STATUSES.map((s) => <option key={s} value={s}>{ENQUIRY_STATUS_LABEL[s]}</option>)}
          </SelectField>
          <TextField label="Next follow-up" type="date" min={dayFromToday(0)} value={closing ? "" : followUp} disabled={closing}
            onChange={(ev) => setFollowUp(ev.target.value)} data-testid="update-follow-up" />
        </div>
        {linked && <p className="text-xs text-muted">The status follows online application {e.application_number}.</p>}
        {!closing && (
          <div className="flex flex-wrap gap-1.5">
            {QUICK.map(([l, n]) => (
              <button key={l} type="button" onClick={() => setFollowUp(dayFromToday(n))} className="rounded-full border border-line px-2.5 py-0.5 text-xs hover:border-leaf-600">{l}</button>
            ))}
            {followUp && status !== "follow_up" && <button type="button" onClick={() => setFollowUp("")} className="rounded-full px-2.5 py-0.5 text-xs text-muted hover:text-ink">No follow-up</button>}
          </div>
        )}
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="update-error">{error}</p>}
        <Button onClick={save} loading={busy} data-testid="save-update">Save update</Button>
      </div>
    </Card>
  );
}

interface Candidate { id: string; application_number: string; student_name: string; status: string; class_name: string; contact_phone: string; same_phone: boolean }

function LinkModal({ schoolId, e, open, onClose, onDone }: { schoolId: string; e: EnquiryDetail; open: boolean; onClose: () => void; onDone: (d: EnquiryDetail) => void }) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    const t = setTimeout(() => {
      apiFetch<Candidate[]>(`/enquiries/${e.id}/application-candidates`, { schoolId, query: { search: search.trim() || undefined } })
        .then(setItems).catch((err) => { setItems([]); setError(errorMessage(err)); });
    }, 250);
    return () => clearTimeout(t);
  }, [open, search, schoolId, e.id]);
  async function link(c: Candidate) {
    setBusy(c.id); setError(null);
    try { onDone(await apiFetch<EnquiryDetail>(`/enquiries/${e.id}`, { schoolId, method: "PATCH", body: { application_id: c.id } })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Link an online application" description={`Applications in ${e.session_name}; the same mobile number is listed first.`}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <TextField label="Search" value={search} onChange={(ev) => setSearch(ev.target.value)} placeholder="Student name or application number" />
        {items === null ? <p className="text-sm text-muted">Loading…</p> : items.length === 0 ? <p className="text-sm text-muted">No unlinked applications found.</p> : (
          <ul className="divide-y divide-line rounded-md border border-line" data-testid="link-candidates">
            {items.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.application_number}</span> · {c.student_name} · {c.class_name}
                  <span className="block text-xs text-muted">{formatPhone(c.contact_phone)}{c.same_phone ? " · same mobile" : ""} · {c.status.replace(/_/g, " ")}</span>
                </span>
                <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => link(c)}>Link</Button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-danger-600" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function Detail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const isAdmin = currentSchool!.roles.includes("school_admin");
  const [e, setE] = useState<EnquiryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "unlink" | null>(null);
  const [applyLink, setApplyLink] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setE(await apiFetch<EnquiryDetail>(`/enquiries/${id}`, { schoolId })); } catch (err) { setError(errorMessage(err)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setApplyLink(`${window.location.origin}/apply/${currentSchool!.school_code.toLowerCase()}`); }, [currentSchool]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!e) return <LoadingState />;
  const manage = can("enquiries:manage") && !e.session_is_archived;
  const school = currentSchool!.school_name;

  async function confirmed() {
    setConfirmBusy(true);
    try {
      if (confirm === "delete") {
        await apiFetch(`/enquiries/${id}`, { schoolId, method: "DELETE" });
        toast.success(`${e!.enquiry_number} deleted.`);
        router.push("/enquiries?tab=list");
      } else {
        setE(await apiFetch<EnquiryDetail>(`/enquiries/${id}`, { schoolId, method: "PATCH", body: { application_id: null } }));
        toast.success("Application unlinked.");
      }
    } catch (err) { toast.error(errorMessage(err)); } finally { setConfirm(null); setConfirmBusy(false); }
  }

  return (
    <>
      <Link href="/enquiries?tab=list" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Enquiries</Link>
      <PageHeader title={e.student_name} description={`${e.enquiry_number} · ${e.parent_name} · ${e.class_name ?? "class not decided"} · ${e.session_name}`}
        actions={<div className="flex items-center gap-2"><EnquiryStatusBadge status={e.status} /></div>} />
      {e.session_is_archived && <p className="mb-4 rounded-md bg-pencil-100/60 p-3 text-sm">This enquiry belongs to an archived session and can&apos;t be changed.</p>}

      <div className="mb-4 flex flex-wrap gap-2" data-testid="contact-actions">
        <a href={`tel:${e.phone}`} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-white px-3 text-sm font-medium hover:border-leaf-600" data-testid="call-link">
          <Phone className="size-4" /> Call {formatPhone(e.phone)}
        </a>
        <a href={whatsappLink(e.phone, `Hello ${e.parent_name}, this is ${school}.`)} target="_blank" rel="noreferrer"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-white px-3 text-sm font-medium hover:border-leaf-600" data-testid="whatsapp-link">
          <MessageCircle className="size-4" /> WhatsApp
        </a>
        {!e.application_id && !isClosed(e.status) && applyLink && (
          <a href={whatsappLink(e.phone, `Hello ${e.parent_name}, you can apply for ${e.student_name}'s admission to ${school} online here: ${applyLink}`)} target="_blank" rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-white px-3 text-sm font-medium hover:border-leaf-600" data-testid="send-apply-link">
            <Link2 className="size-4" /> Send application link
          </a>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {manage && <UpdatePanel schoolId={schoolId} e={e} onSaved={(d) => { setE(d); toast.success("Enquiry updated."); }} />}
          <Card title="History" testid="enquiry-history">
            <ol className="space-y-3 border-l-2 border-line pl-4 text-sm">
              {e.activities.map((a, i) => (
                <li key={i} data-testid="history-item">
                  <span className="font-medium">{activityText(a)}</span>
                  {a.note && <span className="block whitespace-pre-line">{a.note}</span>}
                  <span className="block text-xs text-muted">{formatDateTime(a.at)}{a.by ? ` · ${a.by}` : ""}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Details" testid="enquiry-details"
            action={manage ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid="edit-enquiry"><Pencil className="size-4" /> Edit</Button> : undefined}>
            <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-3 gap-y-1.5 text-sm">
              {([
                ["Student", e.student_name], ["Parent", e.parent_name], ["Mobile", formatPhone(e.phone)], ["Email", e.email],
                ["Class", e.class_name ?? "Not decided"], ["Source", `${SOURCE_LABEL[e.source]}${e.source_detail ? ` · ${e.source_detail}` : ""}`],
                ["Enquiry date", formatDate(e.enquiry_date)], ["Follow-up", <FollowUpDate key="f" date={e.follow_up_date} status={e.status} />],
              ] as [string, ReactNode][]).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd>{v ?? "—"}</dd></div>)}
            </dl>
            {e.notes && <p className="mt-3 whitespace-pre-line rounded-md bg-paper p-3 text-sm" data-testid="enquiry-notes">{e.notes}</p>}
          </Card>
          <Card title="Online application" testid="enquiry-application">
            {e.application_id ? (
              <div className="space-y-2 text-sm">
                <p>
                  {can("admissions:view")
                    ? <Link href={`/admissions/${e.application_id}`} className="font-medium text-leaf-700 hover:underline">{e.application_number}</Link>
                    : <span className="font-medium">{e.application_number}</span>}
                  <span className="text-muted"> · {e.application_status?.replace(/_/g, " ")}</span>
                </p>
                <p className="text-xs text-muted">This enquiry&apos;s status follows the application.</p>
                {manage && <Button size="sm" variant="ghost" onClick={() => setConfirm("unlink")}><Unlink className="size-4" /> Unlink</Button>}
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="text-muted">Not linked. Applications made online with the same mobile number link themselves.</p>
                {manage && can("admissions:view") && <Button size="sm" variant="secondary" onClick={() => setLinking(true)} data-testid="link-application"><Link2 className="size-4" /> Link application</Button>}
              </div>
            )}
          </Card>
          {e.duplicates.length > 0 && (
            <Card title="Same mobile number" testid="enquiry-duplicates">
              <ul className="space-y-1 text-sm">
                {e.duplicates.map((d) => (
                  <li key={d.id}><Link href={`/enquiries/${d.id}`} className="font-medium text-leaf-700 hover:underline">{d.enquiry_number}</Link> {d.student_name} · {ENQUIRY_STATUS_LABEL[d.status]} · {d.session_name}</li>
                ))}
              </ul>
            </Card>
          )}
          {isAdmin && can("enquiries:manage") && (
            <Button variant="ghost" className="text-danger-600" onClick={() => setConfirm("delete")} data-testid="delete-enquiry"><Trash2 className="size-4" /> Delete enquiry</Button>
          )}
        </div>
      </div>

      <EnquiryFormModal schoolId={schoolId} open={editing} enquiry={e} onClose={() => setEditing(false)} onSaved={(d) => { setE(d); setEditing(false); toast.success("Details saved."); }} />
      <LinkModal schoolId={schoolId} e={e} open={linking} onClose={() => setLinking(false)} onDone={(d) => { setE(d); setLinking(false); toast.success(`Linked to ${d.application_number}.`); }} />
      <ConfirmDialog open={confirm !== null} onCancel={() => setConfirm(null)} onConfirm={confirmed}
        title={confirm === "delete" ? `Delete ${e.enquiry_number}?` : "Unlink the application?"}
        message={confirm === "delete" ? "The enquiry and its history are removed permanently. Use “Rejected” instead if the parent simply isn't joining." : "The enquiry keeps its current status and can be changed by hand again."}
        confirmLabel={confirm === "delete" ? "Delete" : "Unlink"} tone={confirm === "delete" ? "danger" : "primary"} loading={confirmBusy} />
    </>
  );
}

export default function EnquiryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="enquiries:view"><Detail id={id} /></RequirePermission>;
}
