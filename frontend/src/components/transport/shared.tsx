"use client";

import { clsx } from "clsx";
import { Download, Eye, FileText, Image as ImageIcon, Loader2, Search, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate, todayISO } from "@/lib/format";
import { formatINR } from "@/lib/money";
import {
  clock, FREQUENCY_LABEL, STAFF_DOCS, TRIP_LABEL, VEHICLE_DOCS,
  type Assignment, type Route, type RouteDetail, type TransportDoc, type Trip,
} from "@/lib/transport";
import type { StudentList, StudentListItem } from "@/lib/types";

export function Tile({ label, value, sub, tone, href, testId }: { label: string; value: string; sub?: string; tone?: "dark" | "danger"; href?: string; testId: string }) {
  const body = (
    <div className={tone === "dark" ? "h-full rounded-lg bg-board-900 p-5 text-white" : "h-full rounded-lg border border-line bg-white p-5 hover:border-leaf-600/40"} data-testid={testId}>
      <p className={tone === "dark" ? "text-sm text-white/60" : "text-sm text-muted"}>{label}</p>
      <p className={clsx("tabular mt-2 text-3xl font-semibold tracking-tight", tone === "danger" && "text-danger-600")} data-testid={`${testId}-value`}>{value}</p>
      {sub && <p className={tone === "dark" ? "mt-1 text-xs text-white/60" : "mt-1 text-xs text-muted"}>{sub}</p>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export function Pill({ tone, children, testId }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode; testId?: string }) {
  const cls = { ok: "bg-leaf-50 text-leaf-700", warn: "bg-pencil-100 text-ink", bad: "bg-danger-50 text-danger-600", muted: "bg-ink/5 text-muted" }[tone];
  return <span className={clsx("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", cls)} data-testid={testId}>{children}</span>;
}

export function DocState({ d }: { d: Pick<TransportDoc, "state" | "valid_until"> }) {
  if (!d.valid_until) return <Pill tone="muted">No expiry</Pill>;
  if (d.state === "expired") return <Pill tone="bad" testId="doc-expired">Expired {formatDate(d.valid_until)}</Pill>;
  if (d.state === "expiring") return <Pill tone="warn" testId="doc-expiring">Expires {formatDate(d.valid_until)}</Pill>;
  return <Pill tone="ok">Valid till {formatDate(d.valid_until)}</Pill>;
}

/** Days from today to an ISO date (negative = past). */
export function daysTo(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(`${todayISO()}T00:00:00`).getTime();
  return Math.round((new Date(`${iso}T00:00:00`).getTime() - t) / 86_400_000);
}

export function LicenceState({ until }: { until: string | null | undefined }) {
  const d = daysTo(until ?? null);
  if (d === null) return null;
  if (d < 0) return <Pill tone="bad" testId="licence-expired">Licence expired {formatDate(until)}</Pill>;
  if (d <= 30) return <Pill tone="warn" testId="licence-expiring">Licence expires {formatDate(until)}</Pill>;
  return <Pill tone="ok">Licence valid till {formatDate(until)}</Pill>;
}

export function Section({ title, action, children, testId }: { title: string; action?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border border-line bg-white" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function FormError({ error, testId }: { error: string | null; testId?: string }) {
  return error ? <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid={testId}>{error}</p> : null;
}

export function TextArea({ label, value, onChange, maxLength = 500, rows = 2 }: { label: string; value: string; onChange: (v: string) => void; maxLength?: number; rows?: number }) {
  const id = useRef(`ta-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} rows={rows}
        className="block w-full rounded-md border border-line px-3 py-2 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
    </div>
  );
}

// ------------------------------------------------------------------ documents (vehicles and staff)
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const MAX_BYTES = 10 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const docName = (d: TransportDoc) => (d.doc_type === "other" && d.title ? d.title : d.label);

function UploadModal({ schoolId, kind, ownerId, open, preset, onClose, onDone }: {
  schoolId: string; kind: "vehicles" | "staff"; ownerId: string; open: boolean; preset?: string; onClose: () => void; onDone: (docs: TransportDoc[]) => void;
}) {
  const types = kind === "vehicles" ? VEHICLE_DOCS : STAFF_DOCS;
  const [type, setType] = useState<string>(types[0][0]);
  const [title, setTitle] = useState("");
  const [number, setNumber] = useState("");
  const [issued, setIssued] = useState("");
  const [valid, setValid] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setType(preset ?? types[0][0]); setTitle(""); setNumber(""); setIssued(""); setValid(""); setFile(null); setError(null);
  }, [open, preset, types]);

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!ACCEPT.split(",").includes(f.type)) return setError("Upload a PDF, JPEG, PNG or WebP file.");
    if (f.size > MAX_BYTES) return setError("Documents must be 10 MB or smaller.");
    setFile(f);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose the scanned document or a photo of it.");
    if (type === "other" && !title.trim()) return setError("Describe the document.");
    if (issued && valid && valid < issued) return setError("“Valid until” is before the issue date.");
    const body = new FormData();
    body.append("file", file);
    body.append("doc_type", type);
    if (title.trim()) body.append("title", title.trim());
    if (number.trim()) body.append("number", number.trim());
    if (issued) body.append("issued_on", issued);
    if (valid) body.append("valid_until", valid);
    setBusy(true); setError(null);
    try { onDone(await apiFetch<TransportDoc[]>(`/transport/${kind}/${ownerId}/documents`, { schoolId, method: "POST", body })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} title="Upload a document" onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="tdoc-form" loading={busy} data-testid="save-document">Upload</Button></>}>
      <form id="tdoc-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="sm:col-span-2"><FormError error={error} testId="document-error" /></div>
        <SelectField label="Document" value={type} onChange={(e) => setType(e.target.value)} data-testid="document-type">
          {types.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectField>
        <TextField label={type === "other" ? "Description" : "Description (optional)"} required={type === "other"} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        <TextField label="Number" value={number} maxLength={60} onChange={(e) => setNumber(e.target.value)} placeholder="Policy / certificate no." data-testid="document-number" />
        <TextField label="Issued on" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
        <TextField label="Valid until" type="date" value={valid} onChange={(e) => setValid(e.target.value)} data-testid="document-valid-until"
          hint="We flag it 30 days before it runs out." />
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line px-3 py-4 text-center text-sm">
          <Upload className="size-5 text-muted" aria-hidden />
          {file ? <p className="break-all"><span className="font-medium">{file.name}</span> <span className="text-muted">({formatBytes(file.size)})</span></p> : <p className="text-xs text-muted">PDF, JPEG, PNG or WebP · up to 10 MB</p>}
          <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>{file ? "Choose another" : "Choose file"}</Button>
          <input ref={input} type="file" accept={ACCEPT} className="sr-only" data-testid="document-input" aria-label="Document file" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </form>
    </Modal>
  );
}

function EditDocModal({ schoolId, doc, onClose, onDone }: { schoolId: string; doc: TransportDoc | null; onClose: () => void; onDone: (docs: TransportDoc[]) => void }) {
  const [title, setTitle] = useState("");
  const [number, setNumber] = useState("");
  const [issued, setIssued] = useState("");
  const [valid, setValid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!doc) return;
    setTitle(doc.title ?? ""); setNumber(doc.number ?? ""); setIssued(doc.issued_on ?? ""); setValid(doc.valid_until ?? ""); setError(null);
  }, [doc]);
  if (!doc) return null;
  async function save() {
    if (doc!.doc_type === "other" && !title.trim()) return setError("Describe the document.");
    if (issued && valid && valid < issued) return setError("“Valid until” is before the issue date.");
    setBusy(true); setError(null);
    try {
      onDone(await apiFetch<TransportDoc[]>(`/transport/documents/${doc!.id}`, { schoolId, method: "PATCH",
        body: { title: title.trim() || null, number: number.trim() || null, issued_on: issued || null, valid_until: valid || null } }));
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Modal open size="sm" title={`Edit ${docName(doc)}`} description={doc.file_name} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-document-details">Save</Button></>}>
      <div className="space-y-4">
        <FormError error={error} />
        <TextField label="Description" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        <TextField label="Number" value={number} maxLength={60} onChange={(e) => setNumber(e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Issued on" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
          <TextField label="Valid until" type="date" value={valid} onChange={(e) => setValid(e.target.value)} data-testid="edit-valid-until" />
        </div>
      </div>
    </Modal>
  );
}

function PreviewModal({ schoolId, doc, onClose }: { schoolId: string; doc: TransportDoc; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    apiFetchBlob(`/transport/documents/${doc.id}/file`, { schoolId })
      .then(({ blob: b }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([b], { type: doc.mime_type }));
        setBlob(b); setUrl(objectUrl);
      })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [doc.id, doc.mime_type, schoolId]);
  return (
    <Modal open size="lg" onClose={onClose} title={docName(doc)} description={`${doc.file_name} · ${formatBytes(doc.size_bytes)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => blob && saveBlob(blob, doc.file_name)} disabled={!blob}><Download className="size-4" /> Download</Button></>}>
      <div className="grid min-h-64 place-items-center rounded-md bg-paper" data-testid="document-preview">
        {error ? <p className="p-6 text-sm text-danger-600" role="alert">{error}</p>
          : !url ? <Loader2 className="size-6 animate-spin text-muted" aria-label="Loading preview" />
          : doc.mime_type.startsWith("image/")
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={url} alt={docName(doc)} className="max-h-[70vh] w-auto object-contain" />
            : <object data={url} type="application/pdf" className="h-[70vh] w-full" aria-label={docName(doc)} data-testid="preview-pdf">
                <p className="p-6 text-center text-sm text-muted">This browser can&apos;t show PDFs here. Use Download to open it.</p>
              </object>}
      </div>
    </Modal>
  );
}

/** A vehicle's or a driver's papers: list, upload, view, change dates, delete. Admins only (the API refuses others). */
export function DocumentsCard({ schoolId, kind, ownerId, docs, missing = [], onChange }: {
  schoolId: string; kind: "vehicles" | "staff"; ownerId: string; docs: TransportDoc[]; missing?: string[]; onChange: (docs: TransportDoc[]) => void;
}) {
  const toast = useToast();
  const [upload, setUpload] = useState<{ preset?: string } | null>(null);
  const [preview, setPreview] = useState<TransportDoc | null>(null);
  const [editing, setEditing] = useState<TransportDoc | null>(null);
  const [deleting, setDeleting] = useState<TransportDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = Object.fromEntries((kind === "vehicles" ? VEHICLE_DOCS : STAFF_DOCS) as readonly (readonly [string, string])[]);

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try { onChange(await apiFetch<TransportDoc[]>(`/transport/documents/${deleting.id}`, { schoolId, method: "DELETE" })); toast.success(`${docName(deleting)} deleted.`); setDeleting(null); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function download(d: TransportDoc) {
    try { const { blob, filename } = await apiFetchBlob(`/transport/documents/${d.id}/file`, { schoolId, query: { download: "true" } }); saveBlob(blob, filename ?? d.file_name); }
    catch (e) { toast.error(errorMessage(e)); }
  }

  return (
    <Section title={`Documents (${docs.length})`} testId="documents-card"
      action={<Button size="sm" onClick={() => setUpload({})} data-testid="upload-document"><Upload className="size-4" /> Upload</Button>}>
      {missing.length > 0 && (
        <div className="border-b border-line bg-pencil-100/50 px-5 py-3 text-sm" data-testid="missing-documents">
          <p className="font-medium">Not uploaded yet</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {missing.map((m) => (
              <button key={m} type="button" onClick={() => setUpload({ preset: m })} className="rounded-full border border-line bg-white px-2.5 py-0.5 text-xs hover:border-leaf-600">
                + {labels[m] ?? m}
              </button>
            ))}
          </div>
        </div>
      )}
      {docs.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No documents yet. Upload scans of the papers so their expiry dates are tracked.</p> : (
        <ul className="divide-y divide-line" data-testid="documents-list">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3" data-testid={`doc-${d.doc_type}`}>
              <span className="grid size-10 shrink-0 place-items-center rounded-md bg-paper text-muted">
                {d.mime_type.startsWith("image/") ? <ImageIcon className="size-5" aria-hidden /> : <FileText className="size-5" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{docName(d)} <DocState d={d} /></p>
                <p className="truncate text-xs text-muted">
                  {d.number ? `No. ${d.number} · ` : ""}{d.issued_on ? `Issued ${formatDate(d.issued_on)} · ` : ""}{d.file_name} · {formatBytes(d.size_bytes)}
                </p>
                <p className="text-xs text-muted">Uploaded {formatDate(d.created_at)}{d.uploaded_by_name ? ` by ${d.uploaded_by_name}` : ""}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPreview(d)} aria-label={`View ${docName(d)}`} data-testid="view-document"><Eye className="size-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => download(d)} aria-label={`Download ${docName(d)}`}><Download className="size-4" /></Button>
              <ActionMenu label={`More actions for ${docName(d)}`} actions={[
                { label: "Edit details", onSelect: () => setEditing(d) },
                { label: "Delete…", onSelect: () => setDeleting(d), tone: "danger" },
              ]} />
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-5 py-3 text-xs text-muted">Only school administrators can open these files. Every view and download is recorded.</p>
      <UploadModal schoolId={schoolId} kind={kind} ownerId={ownerId} open={upload !== null} preset={upload?.preset} onClose={() => setUpload(null)}
        onDone={(list) => { setUpload(null); onChange(list); toast.success("Document uploaded."); }} />
      <EditDocModal schoolId={schoolId} doc={editing} onClose={() => setEditing(null)} onDone={(list) => { setEditing(null); onChange(list); toast.success("Saved."); }} />
      {preview && <PreviewModal schoolId={schoolId} doc={preview} onClose={() => setPreview(null)} />}
      <ConfirmDialog open={deleting !== null} title={`Delete ${deleting ? docName(deleting) : ""}?`} message="The file is removed from storage. This can't be undone."
        confirmLabel="Delete document" loading={busy} onConfirm={remove} onCancel={() => setDeleting(null)} />
    </Section>
  );
}

// ------------------------------------------------------------------ students on routes
function StudentPicker({ schoolId, onPick }: { schoolId: string; onPick: (s: StudentListItem) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<StudentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setItems(null); return; }
    const t = window.setTimeout(() => {
      apiFetch<StudentList>("/students", { schoolId, query: { search: term, status: "active", page_size: 8 } })
        .then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errorMessage(e)));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, schoolId]);
  return (
    <div>
      <label htmlFor="tr-student-search" className="mb-1.5 block text-sm font-medium">Student</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input id="tr-student-search" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, student ID or admission no." data-testid="assign-student-search"
          className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
      </div>
      {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
      {items && (items.length === 0 ? <p className="mt-2 text-sm text-muted">No active student in the current session matches.</p> : (
        <ul className="mt-2 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line" data-testid="assign-student-results">
          {items.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onPick(s)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-paper">
                <span className="min-w-0 truncate font-medium">{s.full_name}</span>
                <span className="shrink-0 text-xs text-muted">{s.enrollment.class_name} – {s.enrollment.section_name} · {s.student_code}</span>
              </button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

/** Put a student on a route from a date. If they already ride, the current trip ends the day before. */
export function AssignModal({ schoolId, open, student, routeId, stopId, onClose, onDone }: {
  schoolId: string; open: boolean; student?: { id: string; name: string } | null; routeId?: string; stopId?: string;
  onClose: () => void; onDone: (a: Assignment) => void;
}) {
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [route, setRoute] = useState("");
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [stop, setStop] = useState("");
  const [trip, setTrip] = useState<Trip>("both");
  const [start, setStart] = useState(todayISO());
  const [charge, setCharge] = useState(true);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWho(student ?? null); setRoute(routeId ?? ""); setStop(stopId ?? ""); setTrip("both"); setStart(todayISO()); setCharge(true); setNotes(""); setError(null);
    apiFetch<Route[]>("/transport/routes", { schoolId }).then((r) => setRoutes(r.filter((x) => x.status === "active"))).catch((e) => setError(errorMessage(e)));
  }, [open, student, routeId, stopId, schoolId]);
  useEffect(() => {
    if (!route) { setDetail(null); return; }
    apiFetch<RouteDetail>(`/transport/routes/${route}`, { schoolId }).then(setDetail).catch((e) => setError(errorMessage(e)));
  }, [route, schoolId]);

  const chosenStop = detail?.stop_list.find((s) => s.id === stop);
  const full = detail && detail.seating_capacity !== null && detail.riders >= detail.seating_capacity;

  async function save() {
    setError(null);
    if (!who) return setError("Choose the student.");
    if (!route || !stop) return setError("Choose the route and the stop.");
    if (!start) return setError("Enter the date transport starts.");
    setBusy(true);
    try {
      onDone(await apiFetch<Assignment>("/transport/assignments", { schoolId, method: "POST",
        body: { student_id: who.id, route_id: route, stop_id: stop, trip, start_date: start, charge_fee: charge, notes: notes.trim() || null } }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" title={student ? `Transport for ${student.name}` : "Assign a student to a route"} onClose={busy ? () => {} : onClose}
      description="If the student already uses school transport, that trip ends the day before the new one starts."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="confirm-assign">Assign</Button></>}>
      <div className="space-y-4">
        <FormError error={error} testId="assign-error" />
        {who ? (
          <div className="flex items-center justify-between gap-3 rounded-md bg-paper px-3 py-2 text-sm">
            <span>Student: <b data-testid="assign-student">{who.name}</b></span>
            {!student && <Button size="sm" variant="ghost" onClick={() => setWho(null)}>Change</Button>}
          </div>
        ) : <StudentPicker schoolId={schoolId} onPick={(s) => setWho({ id: s.id, name: s.full_name })} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Route" value={route} onChange={(e) => { setRoute(e.target.value); setStop(""); }} data-testid="assign-route">
            <option value="">{routes ? (routes.length ? "Choose a route" : "No active routes yet") : "Loading…"}</option>
            {routes?.map((r) => <option key={r.id} value={r.id}>{r.name}{r.code ? ` (${r.code})` : ""}{r.seating_capacity !== null ? ` · ${r.riders}/${r.seating_capacity} seats` : ""}</option>)}
          </SelectField>
          <SelectField label="Stop" value={stop} onChange={(e) => setStop(e.target.value)} disabled={!detail} data-testid="assign-stop">
            <option value="">{detail && detail.stop_list.length === 0 ? "This route has no stops yet" : "Choose a stop"}</option>
            {detail?.stop_list.map((s) => <option key={s.id} value={s.id}>{s.sequence}. {s.name}{s.pickup_time ? ` · ${clock(s.pickup_time)}` : ""}</option>)}
          </SelectField>
          <SelectField label="Uses" value={trip} onChange={(e) => setTrip(e.target.value as Trip)} data-testid="assign-trip">
            {(Object.keys(TRIP_LABEL) as Trip[]).map((t) => <option key={t} value={t}>{TRIP_LABEL[t]}</option>)}
          </SelectField>
          <TextField label="Starts on" type="date" value={start} onChange={(e) => setStart(e.target.value)} data-testid="assign-start" />
        </div>
        {full && <p className="text-sm text-danger-600">This route&apos;s vehicle is full today ({detail!.riders}/{detail!.seating_capacity}).</p>}
        {detail && !detail.vehicle_id && <p className="text-sm text-muted">No vehicle is assigned to this route yet, so seats aren&apos;t counted.</p>}
        {chosenStop && (
          <p className="rounded-md bg-leaf-50 px-3 py-2 text-sm" data-testid="assign-fare">
            Fare zone <b>{chosenStop.fare_zone}</b>: {formatINR(chosenStop.fare)} {FREQUENCY_LABEL[chosenStop.fare_frequency]}. The dues are added to the student&apos;s fees for the months they ride.
          </p>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={charge} onChange={(e) => setCharge(e.target.checked)} data-testid="assign-charge" />
          <span>Charge the transport fee<span className="block text-xs text-muted">Untick for free transport (e.g. a staff child). No transport dues are created.</span></span>
        </label>
        <TextArea label="Notes (optional)" value={notes} onChange={setNotes} maxLength={300} />
      </div>
    </Modal>
  );
}

/** Change the stop / trip / fee flag of an assignment (same route, whole period). */
export function EditAssignmentModal({ schoolId, assignment, onClose, onDone }: { schoolId: string; assignment: Assignment | null; onClose: () => void; onDone: () => void }) {
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [stop, setStop] = useState("");
  const [trip, setTrip] = useState<Trip>("both");
  const [charge, setCharge] = useState(true);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!assignment) return;
    setStop(assignment.stop_id); setTrip(assignment.trip); setCharge(assignment.charge_fee); setNotes(assignment.notes ?? ""); setError(null);
    apiFetch<RouteDetail>(`/transport/routes/${assignment.route_id}`, { schoolId }).then(setDetail).catch((e) => setError(errorMessage(e)));
  }, [assignment, schoolId]);
  if (!assignment) return null;
  async function save() {
    setBusy(true); setError(null);
    try { await apiFetch(`/transport/assignments/${assignment!.id}`, { schoolId, method: "PUT", body: { stop_id: stop, trip, charge_fee: charge, notes: notes.trim() || null } }); onDone(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open title={`Edit ${assignment.student_name}'s transport`} description={`${assignment.route_name} · from ${formatDate(assignment.start_date)}`} onClose={busy ? () => {} : onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-assignment">Save</Button></>}>
      <div className="space-y-4">
        <FormError error={error} />
        <p className="text-sm text-muted">This corrects the whole period. To move the student to another stop or route from a date, use <b>Move</b> instead, so earlier months keep their old fare.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Stop" value={stop} onChange={(e) => setStop(e.target.value)} data-testid="edit-stop">
            {detail?.stop_list.map((s) => <option key={s.id} value={s.id}>{s.sequence}. {s.name} · {s.fare_zone}</option>) ?? <option value={assignment.stop_id}>{assignment.stop_name}</option>}
          </SelectField>
          <SelectField label="Uses" value={trip} onChange={(e) => setTrip(e.target.value as Trip)}>
            {(Object.keys(TRIP_LABEL) as Trip[]).map((t) => <option key={t} value={t}>{TRIP_LABEL[t]}</option>)}
          </SelectField>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-leaf-600" checked={charge} onChange={(e) => setCharge(e.target.checked)} data-testid="edit-charge" /> Charge the transport fee
        </label>
        <TextArea label="Notes" value={notes} onChange={setNotes} maxLength={300} />
      </div>
    </Modal>
  );
}

/** Stop transport from a date, or remove an assignment that hasn't started. */
export function EndAssignmentModal({ schoolId, assignment, onClose, onDone }: { schoolId: string; assignment: Assignment | null; onClose: () => void; onDone: (removed: boolean) => void }) {
  const [end, setEnd] = useState(todayISO());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (assignment) { setEnd(assignment.start_date > todayISO() ? assignment.start_date : todayISO()); setError(null); } }, [assignment]);
  if (!assignment) return null;
  const future = assignment.start_date > todayISO();
  async function go(remove: boolean) {
    if (!remove && !end) return setError("Enter the last day.");
    setBusy(true); setError(null);
    try { await apiFetch(`/transport/assignments/${assignment!.id}/end`, { schoolId, method: "POST", body: { end_date: remove ? null : end } }); onDone(remove); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open size="sm" title={future ? "Cancel this transport?" : `Stop ${assignment.student_name}'s transport`} description={`${assignment.route_name} · ${assignment.stop_name}`} onClose={busy ? () => {} : onClose}
      footer={future
        ? <><Button variant="secondary" onClick={onClose} disabled={busy}>Keep</Button><Button variant="danger" onClick={() => go(true)} loading={busy} data-testid="confirm-remove">Remove</Button></>
        : <><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" onClick={() => go(false)} loading={busy} data-testid="confirm-end">Stop transport</Button></>}>
      <div className="space-y-4 text-sm">
        <FormError error={error} testId="end-error" />
        {future ? <p>It was due to start on {formatDate(assignment.start_date)}. Removing it deletes it and its unpaid transport dues.</p> : (
          <>
            <TextField label="Last day on the bus" type="date" value={end} min={assignment.start_date} onChange={(e) => setEnd(e.target.value)} data-testid="end-date" />
            <p className="text-muted">Unpaid transport dues for months after this date are removed. Paid dues stay as they are.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

export function AssignmentPeriod({ a }: { a: Pick<Assignment, "start_date" | "end_date" | "is_current"> }) {
  const future = a.start_date > todayISO();
  const ended = a.end_date !== null && a.end_date < todayISO();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {a.end_date ? `${formatDate(a.start_date)} – ${formatDate(a.end_date)}` : `From ${formatDate(a.start_date)}`}
      {future ? <Pill tone="warn">Starts later</Pill> : ended ? <Pill tone="muted">Ended</Pill> : <Pill tone="ok">Current</Pill>}
    </span>
  );
}
