"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { CERTIFICATE_KINDS, KIND_HINT, KIND_LABEL, type CertificateKind, type CertificateTemplate, type Placeholder, type TemplateField } from "@/lib/documents";
import { StatusPill } from "./shared";

export function TemplatesTab({ schoolId }: { schoolId: string }) {
  const toast = useToast();
  const [items, setItems] = useState<CertificateTemplate[] | null>(null);
  const [placeholders, setPlaceholders] = useState<Placeholder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CertificateTemplate | "new" | null>(null);
  const [deleting, setDeleting] = useState<CertificateTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, p] = await Promise.all([
        apiFetch<CertificateTemplate[]>("/certificates/templates", { schoolId }),
        apiFetch<Placeholder[]>("/certificates/placeholders", { schoolId }),
      ]);
      setItems(t); setPlaceholders(p);
    } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  async function remove() {
    setBusy(true);
    try { await apiFetch(`/certificates/templates/${deleting!.id}`, { schoolId, method: "DELETE" }); toast.success("Template deleted."); setDeleting(null); void load(); }
    catch (e) { toast.error(errorMessage(e)); setDeleting(null); } finally { setBusy(false); }
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState />;
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <p className="min-w-0 flex-1 text-sm text-muted">The wording of each certificate, with {"{{placeholders}}"} filled in from the student&apos;s record when it&apos;s issued. Changing a template doesn&apos;t change certificates already issued.</p>
        <Button size="sm" onClick={() => setEditing("new")} data-testid="add-template"><Plus className="size-4" /> New certificate</Button>
      </div>
      <ul className="divide-y divide-line" data-testid="template-list">
        {items.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid={`template-${t.prefix}`}>
            <div className="min-w-0 flex-1 basis-64">
              <p className="font-medium">{t.name} <span className="text-xs font-normal text-muted">{KIND_LABEL[t.kind]} · numbered {t.prefix}-YYYY-0001</span></p>
              <p className="line-clamp-1 text-xs text-muted">{t.body}</p>
            </div>
            <span className="text-xs text-muted">{t.issued_count} issued</span>
            {!t.is_active && <StatusPill tone="muted">Not in use</StatusPill>}
            <span className="inline-flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`} data-testid="edit-template"><Pencil className="size-4" /></Button>
              {t.issued_count === 0 && <Button variant="ghost" size="sm" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}><Trash2 className="size-4 text-danger-600" /></Button>}
            </span>
          </li>
        ))}
      </ul>
      <TemplateEditor schoolId={schoolId} template={editing} placeholders={placeholders} onClose={() => setEditing(null)}
        onSaved={(t) => { toast.success(`${t.name} saved.`); setEditing(null); void load(); }} />
      <ConfirmDialog open={!!deleting} title={`Delete ${deleting?.name ?? ""}?`} message="No certificates have been issued from it, so it can be deleted." confirmLabel="Delete"
        loading={busy} onConfirm={remove} onCancel={() => setDeleting(null)} />
    </section>
  );
}

const EMPTY = { kind: "custom" as CertificateKind, name: "", title: "", prefix: "", body: "", fields: [] as TemplateField[], show_logo: true, show_photo: false, show_qr: true, is_active: true };

function TemplateEditor({ schoolId, template, placeholders, onClose, onSaved }: {
  schoolId: string; template: CertificateTemplate | "new" | null; placeholders: Placeholder[]; onClose: () => void; onSaved: (t: CertificateTemplate) => void;
}) {
  const [d, setD] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const isNew = template === "new";
  useEffect(() => {
    if (!template) return;
    setError(null);
    setD(template === "new" ? EMPTY : {
      kind: template.kind, name: template.name, title: template.title, prefix: template.prefix, body: template.body, fields: template.fields,
      show_logo: template.show_logo, show_photo: template.show_photo, show_qr: template.show_qr, is_active: template.is_active,
    });
  }, [template]);
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setD((x) => ({ ...x, [k]: v }));
  function insert(key: string) {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) { set("body", d.body + token); return; }
    const [a, b] = [el.selectionStart ?? d.body.length, el.selectionEnd ?? d.body.length];
    const next = d.body.slice(0, a) + token + d.body.slice(b);
    set("body", next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  }
  function setField(i: number, patch: Partial<TemplateField>) { set("fields", d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f))); }
  async function save() {
    setBusy(true); setError(null);
    const body = { ...d, prefix: d.prefix.trim().toUpperCase(), fields: d.fields.map((f) => ({ ...f, key: f.key.trim(), label: f.label.trim() })) };
    const { kind, ...rest } = body;
    try {
      const t = await apiFetch<CertificateTemplate>(isNew ? "/certificates/templates" : `/certificates/templates/${(template as CertificateTemplate).id}`,
        { schoolId, method: isNew ? "POST" : "PUT", body: isNew ? body : rest });
      void kind;
      onSaved(t);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const fieldKeys = d.fields.filter((f) => /^[a-z][a-z0-9_]{1,29}$/.test(f.key)).map((f) => ({ key: f.key, label: f.label || f.key }));
  return (
    <Modal open={!!template} size="lg" onClose={busy ? () => {} : onClose} title={isNew ? "New certificate" : `Edit ${(template as CertificateTemplate | null)?.name ?? ""}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-template">Save</Button></>}>
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="template-error">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {isNew ? (
            <SelectField label="Type" value={d.kind} onChange={(e) => set("kind", e.target.value as CertificateKind)}>
              {CERTIFICATE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </SelectField>
          ) : <p className="text-sm"><span className="block font-medium">Type</span><span className="text-muted">{KIND_LABEL[d.kind]} — {KIND_HINT[d.kind]}</span></p>}
          <TextField label="Name (in this list)" required maxLength={60} value={d.name} onChange={(e) => set("name", e.target.value)} data-testid="template-name" />
          <TextField label="Title (printed)" required maxLength={80} value={d.title} onChange={(e) => set("title", e.target.value)} data-testid="template-title" />
          <TextField label="Number prefix" required maxLength={6} value={d.prefix} onChange={(e) => set("prefix", e.target.value.toUpperCase())}
            hint={`Letters only: ${d.prefix || "XX"}-${new Date().getFullYear()}-0001`} data-testid="template-prefix" />
        </div>
        <div>
          <label htmlFor="template-body" className="mb-1.5 block text-sm font-medium">Wording <span className="text-danger-600">*</span></label>
          <textarea id="template-body" ref={bodyRef} value={d.body} onChange={(e) => set("body", e.target.value)} rows={8} maxLength={5000} data-testid="template-body"
            className="w-full rounded-md border border-line px-3 py-2 font-mono text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          <p className="mt-1 text-xs text-muted">A blank line starts a new paragraph. Click a value to insert it. If the student&apos;s record lacks a value the wording uses, issuing stops and says which.</p>
          <div className="mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto" aria-label="Insert a value">
            {[...placeholders, ...fieldKeys].map((p) => (
              <button key={p.key} type="button" onClick={() => insert(p.key)} title={`{{${p.key}}}`}
                className="rounded-full border border-line bg-paper px-2.5 py-0.5 text-xs hover:border-leaf-600 hover:text-leaf-700">{p.label}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Extra fields asked when issuing</h3>
            <Button variant="ghost" size="sm" disabled={d.fields.length >= 12} onClick={() => set("fields", [...d.fields, { key: "", label: "", type: "text", required: false }])} data-testid="add-field"><Plus className="size-4" /> Field</Button>
          </div>
          {d.fields.length === 0 ? <p className="text-xs text-muted">None. Add one for anything not in the student&apos;s record (e.g. date of leaving, event).</p> : (
            <ul className="mt-2 space-y-2">
              {d.fields.map((f, i) => (
                <li key={i} className="grid grid-cols-2 items-end gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_1fr_auto_auto_auto]">
                  <TextField label="Key (in the wording)" value={f.key} maxLength={30} onChange={(e) => setField(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="event_name" data-testid={`field-key-${i}`} />
                  <TextField label="Label" value={f.label} maxLength={60} onChange={(e) => setField(i, { label: e.target.value })} placeholder="Event name" data-testid={`field-label-${i}`} />
                  <SelectField label="Kind" value={f.type} onChange={(e) => setField(i, { type: e.target.value as "text" | "date" })}>
                    <option value="text">Text</option><option value="date">Date</option>
                  </SelectField>
                  <label className="flex h-10 items-center gap-1.5 text-sm"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} className="size-4 accent-leaf-600" /> Required</label>
                  <Button variant="ghost" size="sm" onClick={() => set("fields", d.fields.filter((_, j) => j !== i))} aria-label={`Remove field ${f.label || i + 1}`}><Trash2 className="size-4" /></Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <legend className="mb-1 text-sm font-medium">Print</legend>
          {([["show_logo", "School logo"], ["show_photo", "Student photo"], ["show_qr", "QR code for verification"], ["is_active", "In use"]] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={d[k]} onChange={(e) => set(k, e.target.checked)} className="size-4 accent-leaf-600" data-testid={`template-${k}`} /> {label}</label>
          ))}
        </fieldset>
      </div>
    </Modal>
  );
}
