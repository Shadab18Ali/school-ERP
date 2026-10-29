"use client";

import { clsx } from "clsx";
import { CheckCircle2, Circle, Download, Eye, FileText, Image as ImageIcon, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { DOCUMENT_TYPE_LABELS, type DocumentType, type StudentDocument } from "@/lib/types";

const TYPES = Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[];
const CHECKLIST = TYPES.filter((t) => t !== "other");
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const MAX_BYTES = 10 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const label = (d: StudentDocument) => d.title || DOCUMENT_TYPE_LABELS[d.document_type];

function UploadForm({ base, schoolId, onUploaded }: { base: string; schoolId: string; onUploaded: (d: StudentDocument) => void }) {
  const toast = useToast();
  const [type, setType] = useState<DocumentType>("birth_certificate");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!ACCEPT.split(",").includes(f.type)) return setError("Upload a PDF, JPEG, PNG or WebP file.");
    if (f.size > MAX_BYTES) return setError("Documents must be 10 MB or smaller.");
    setFile(f);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose a file to upload.");
    if (type === "other" && !title.trim()) return setError("Describe the document (e.g. Medical certificate).");
    const body = new FormData();
    body.append("file", file);
    body.append("document_type", type);
    if (title.trim()) body.append("title", title.trim());
    setBusy(true);
    setError(null);
    try {
      const doc = await apiFetch<StudentDocument>(base, { method: "POST", schoolId, body });
      toast.success(`${label(doc)} uploaded.`);
      setFile(null);
      setTitle("");
      onUploaded(doc);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-label="Upload a document">
      {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="upload-error">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Document type" value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
          {TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>)}
        </SelectField>
        <TextField label={type === "other" ? "Description" : "Description (optional)"} required={type === "other"} maxLength={120}
          value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === "other" ? "e.g. Medical certificate" : "e.g. Class 5 marksheet"} />
      </div>
      <div
        onDragOver={(e: DragEvent) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]); }}
        className={clsx("flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm",
          dragging ? "border-leaf-600 bg-leaf-50" : "border-line")}
      >
        <Upload className="size-6 text-muted" aria-hidden />
        {file ? (
          <p><span className="font-medium">{file.name}</span> <span className="text-muted">({formatBytes(file.size)})</span></p>
        ) : (
          <p className="text-muted">Drag a file here, or</p>
        )}
        <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>{file ? "Choose another" : "Choose file"}</Button>
        <p className="text-xs text-muted">PDF, JPEG, PNG or WebP · up to 10 MB</p>
        <input ref={input} type="file" accept={ACCEPT} className="sr-only" data-testid="document-input" aria-label="Document file"
          onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={busy} disabled={!file}>Upload</Button>
      </div>
    </form>
  );
}

function PreviewModal({ doc, base, schoolId, onClose }: { doc: StudentDocument; base: string; schoolId: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    apiFetchBlob(`${base}/${doc.id}/file`, { schoolId })
      .then(({ blob: b }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([b], { type: doc.mime_type }));
        setBlob(b);
        setUrl(objectUrl);
      })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); }; // never keep files in memory longer than needed
  }, [base, doc.id, doc.mime_type, schoolId]);

  const isImage = doc.mime_type.startsWith("image/");
  return (
    <Modal open size="lg" onClose={onClose} title={label(doc)} description={`${doc.file_name} · ${formatBytes(doc.size_bytes)}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={() => blob && saveBlob(blob, doc.file_name)} disabled={!blob}><Download className="size-4" /> Download</Button>
      </>}>
      <div className="grid min-h-64 place-items-center rounded-md bg-paper" data-testid="document-preview">
        {error ? (
          <p className="p-6 text-sm text-danger-600" role="alert">{error}</p>
        ) : !url ? (
          <Loader2 className="size-6 animate-spin text-muted" aria-label="Loading preview" />
        ) : isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label(doc)} className="max-h-[70vh] w-auto object-contain" data-testid="preview-image" />
        ) : (
          <object data={url} type="application/pdf" className="h-[70vh] w-full" data-testid="preview-pdf" aria-label={label(doc)}>
            <p className="p-6 text-center text-sm text-muted">
              This browser can&apos;t show PDFs here. Use <span className="font-medium">Download</span> to open it.
            </p>
          </object>
        )}
      </div>
    </Modal>
  );
}

function EditModal({ doc, base, schoolId, onClose, onSaved }: {
  doc: StudentDocument; base: string; schoolId: string; onClose: () => void; onSaved: (d: StudentDocument) => void;
}) {
  const [type, setType] = useState<DocumentType>(doc.document_type);
  const [title, setTitle] = useState(doc.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (type === "other" && !title.trim()) return setError("Describe the document (e.g. Medical certificate).");
    setBusy(true);
    setError(null);
    try {
      onSaved(await apiFetch<StudentDocument>(`${base}/${doc.id}`, { method: "PATCH", schoolId, body: { document_type: type, title: title.trim() || null } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open size="sm" onClose={busy ? () => {} : onClose} title="Edit document details" description={doc.file_name}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={save} loading={busy}>Save</Button>
      </>}>
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
        <SelectField label="Document type" value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
          {TYPES.map((t) => <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>)}
        </SelectField>
        <TextField label="Description" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
    </Modal>
  );
}

export function DocumentsPanel({ studentId, schoolId, canManage }: { studentId: string; schoolId: string; canManage: boolean }) {
  const toast = useToast();
  const base = `/students/${studentId}/documents`;
  const [docs, setDocs] = useState<StudentDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<StudentDocument | null>(null);
  const [editing, setEditing] = useState<StudentDocument | null>(null);
  const [deleting, setDeleting] = useState<StudentDocument | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setDocs(await apiFetch<StudentDocument[]>(base, { schoolId })); } catch (err) { setError(errorMessage(err)); }
  }, [base, schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function download(d: StudentDocument) {
    try {
      const { blob, filename } = await apiFetchBlob(`${base}/${d.id}/file`, { schoolId, query: { download: "true" } });
      saveBlob(blob, filename ?? d.file_name);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await apiFetch(`${base}/${deleting.id}`, { method: "DELETE", schoolId });
      toast.success(`${label(deleting)} deleted.`);
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!docs) return <LoadingState label="Loading documents…" />;
  const present = new Set(docs.map((d) => d.document_type));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]" role="tabpanel">
      <div className="space-y-6">
        {canManage && (
          <section className="rounded-lg border border-line bg-white p-5">
            <h2 className="mb-4 font-semibold">Upload a document</h2>
            <UploadForm base={base} schoolId={schoolId} onUploaded={() => void load()} />
          </section>
        )}
        <section className="rounded-lg border border-line bg-white">
          <h2 className="border-b border-line px-5 py-3.5 font-semibold">Documents ({docs.length})</h2>
          {docs.length === 0 ? (
            <EmptyState icon={FileText} title="No documents yet"
              message={canManage ? "Upload the birth certificate, previous marksheet, transfer certificate and other records here." : "No documents have been uploaded."} />
          ) : (
            <ul className="divide-y divide-line" data-testid="documents-list">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-5 py-3" data-testid={`document-${d.file_name}`}>
                  <span className="grid size-10 shrink-0 place-items-center rounded-md bg-paper text-muted">
                    {d.mime_type.startsWith("image/") ? <ImageIcon className="size-5" aria-hidden /> : <FileText className="size-5" aria-hidden />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{label(d)}</p>
                    <p className="truncate text-xs text-muted">
                      {d.title ? `${DOCUMENT_TYPE_LABELS[d.document_type]} · ` : ""}{d.file_name} · {formatBytes(d.size_bytes)}
                    </p>
                    <p className="text-xs text-muted" data-testid="uploaded-on">
                      Uploaded {formatDate(d.uploaded_at)}{d.uploaded_by_name ? ` by ${d.uploaded_by_name}` : ""}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setPreviewing(d)} aria-label={`Preview ${label(d)}`}><Eye className="size-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => download(d)} aria-label={`Download ${label(d)}`}><Download className="size-4" /></Button>
                  {canManage && (
                    <ActionMenu label={`More actions for ${label(d)}`} actions={[
                      { label: "Edit details", onSelect: () => setEditing(d) },
                      { label: "Delete…", onSelect: () => setDeleting(d), tone: "danger" },
                    ]} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="h-fit rounded-lg border border-line bg-white p-5" aria-label="Document checklist">
        <h2 className="mb-3 font-semibold">Checklist</h2>
        <ul className="space-y-2 text-sm" data-testid="document-checklist">
          {CHECKLIST.map((t) => (
            <li key={t} className="flex items-center gap-2">
              {present.has(t)
                ? <CheckCircle2 className="size-4 text-leaf-600" aria-label="Uploaded" />
                : <Circle className="size-4 text-line" aria-label="Missing" />}
              <span className={present.has(t) ? "" : "text-muted"}>{DOCUMENT_TYPE_LABELS[t]}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted">Documents are private. Only school administrators can open them, and every view and download is recorded.</p>
      </aside>

      {previewing && <PreviewModal doc={previewing} base={base} schoolId={schoolId} onClose={() => setPreviewing(null)} />}
      {editing && (
        <EditModal doc={editing} base={base} schoolId={schoolId} onClose={() => setEditing(null)}
          onSaved={async (d) => { setEditing(null); toast.success(`${label(d)} saved.`); await load(); }} />
      )}
      <ConfirmDialog open={deleting !== null} title={`Delete ${deleting ? label(deleting) : ""}?`}
        message="The file is permanently removed from storage. This can't be undone; the audit log keeps a record that it existed."
        confirmLabel="Delete document" loading={busy} onConfirm={confirmDelete} onCancel={() => setDeleting(null)} />
    </div>
  );
}
