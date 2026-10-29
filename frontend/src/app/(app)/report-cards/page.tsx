"use client";

import { clsx } from "clsx";
import { Copy, Download, Eye, Plus, Star, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import type { ReportCardTemplate } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

type Flag = "show_logo" | "show_photo" | "show_rank" | "show_attendance" | "show_subject_grades" | "show_pass_marks"
  | "show_grade_scale" | "show_teacher_remarks" | "show_principal_remarks";
const FLAGS: [Flag, string, string][] = [
  ["show_logo", "School logo", "From the school profile"],
  ["show_photo", "Student photo", "An empty frame when no photo is on file"],
  ["show_rank", "Rank in section", "e.g. 3 of 40"],
  ["show_attendance", "Attendance", "Days present up to the exam"],
  ["show_subject_grades", "Subject grades", "A grade for every subject"],
  ["show_pass_marks", "Pass marks column", ""],
  ["show_grade_scale", "Grading scale", "A small legend of the grades"],
  ["show_teacher_remarks", "Class teacher's remarks", ""],
  ["show_principal_remarks", "Principal's remarks", ""],
];
const COLOURS = ["#2f6b57", "#1d4ed8", "#7c2d12", "#6d28d9", "#0f766e", "#1f2937"];
type Draft = Omit<ReportCardTemplate, "id" | "is_default" | "has_signature" | "exams_using">;
const DRAFT_KEYS = ["name", "layout", "accent_color", "title", "show_logo", "show_photo", "show_rank", "show_attendance", "show_subject_grades",
  "show_pass_marks", "show_grade_scale", "show_teacher_remarks", "show_principal_remarks", "signature_1", "signature_2", "signature_3",
  "principal_name", "footer_note"] as const;
const draftOf = (t: ReportCardTemplate): Draft => Object.fromEntries(DRAFT_KEYS.map((k) => [k, t[k]])) as Draft;

function Editor({ schoolId, t, onSaved }: { schoolId: string; t: ReportCardTemplate; onSaved: (t: ReportCardTemplate) => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>(draftOf(t));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { setD(draftOf(t)); setError(null); }, [t]);

  const loadPreview = useCallback(async () => {
    try {
      const { blob } = await apiFetchBlob(`/report-cards/templates/${t.id}/preview.pdf`, { schoolId });
      setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
    } catch { setPreview(null); }
  }, [schoolId, t.id]);
  useEffect(() => { void loadPreview(); }, [loadPreview, t]);
  useEffect(() => {
    if (!t.has_signature) { setSigUrl(null); return; }
    apiFetchBlob(`/report-cards/templates/${t.id}/signature.png`, { schoolId })
      .then(({ blob }) => setSigUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); }))
      .catch(() => setSigUrl(null));
  }, [schoolId, t.id, t.has_signature]);

  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(t));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });

  async function save() {
    if (d.name.trim().length < 2) { setError("Enter a name."); return; }
    if (d.title.trim().length < 2) { setError("Enter a title."); return; }
    if (!/^#[0-9a-fA-F]{6}$/.test(d.accent_color)) { setError("Choose a colour like #2f6b57."); return; }
    setBusy("save"); setError(null);
    try {
      onSaved(await apiFetch<ReportCardTemplate>(`/report-cards/templates/${t.id}`, { schoolId, method: "PATCH", body: d }));
      toast.success("Template saved.");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function upload(files: FileList | null) {
    if (!files?.[0]) return;
    const form = new FormData();
    form.append("file", files[0]);
    setBusy("sig");
    try { onSaved(await apiFetch<ReportCardTemplate>(`/report-cards/templates/${t.id}/signature`, { schoolId, method: "PUT", body: form })); toast.success("Signature uploaded."); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); if (file.current) file.current.value = ""; }
  }
  async function removeSig() {
    setBusy("sig");
    try { onSaved(await apiFetch<ReportCardTemplate>(`/report-cards/templates/${t.id}/signature`, { schoolId, method: "DELETE" })); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  async function downloadPreview() {
    try { const { blob } = await apiFetchBlob(`/report-cards/templates/${t.id}/preview.pdf`, { schoolId }); saveBlob(blob, `preview-${t.name}.pdf`); }
    catch (e) { toast.error(errorMessage(e)); }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_minmax(0,520px)]" data-testid="template-editor">
      <section className="space-y-5 rounded-lg border border-line bg-white p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Template name" value={d.name} maxLength={60} onChange={(e) => set("name", e.target.value)} />
          <TextField label="Title on the card" value={d.title} maxLength={60} onChange={(e) => set("title", e.target.value)} hint="e.g. Report Card, Progress Report" />
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Layout</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {([["classic", "Classic", "White header, double page border"], ["modern", "Modern", "Coloured header band"]] as const).map(([v, label, hint]) => (
              <label key={v} className={clsx("flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm", d.layout === v ? "border-leaf-600 bg-leaf-50/50" : "border-line")}>
                <input type="radio" name="layout" className="mt-0.5 accent-leaf-600" checked={d.layout === v} onChange={() => set("layout", v)} />
                <span><span className="font-medium">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <span className="mb-1.5 block text-sm font-medium">Accent colour</span>
          <div className="flex flex-wrap items-center gap-2">
            {COLOURS.map((c) => (
              <button key={c} type="button" aria-label={`Colour ${c}`} onClick={() => set("accent_color", c)}
                className={clsx("size-8 rounded-full border-2", d.accent_color.toLowerCase() === c ? "border-ink" : "border-white ring-1 ring-line")} style={{ background: c }} />
            ))}
            <input type="color" aria-label="Custom colour" value={d.accent_color} onChange={(e) => set("accent_color", e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-line" />
            <input aria-label="Colour code" value={d.accent_color} maxLength={7} onChange={(e) => set("accent_color", e.target.value)} className="tabular h-8 w-24 rounded-md border border-line px-2 text-sm" />
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Show on the card</legend>
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2" data-testid="template-flags">
            {FLAGS.map(([k, label, hint]) => (
              <label key={k} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-leaf-600" checked={d[k]} onChange={(e) => set(k, e.target.checked)} />
                <span>{label}{hint && <span className="block text-xs text-muted">{hint}</span>}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Signatures</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label="Signature 1" value={d.signature_1 ?? ""} maxLength={40} onChange={(e) => set("signature_1", e.target.value)} hint="Class teacher's name printed below" />
            <TextField label="Signature 2" value={d.signature_2 ?? ""} maxLength={40} onChange={(e) => set("signature_2", e.target.value)} hint="Principal's name and signature" />
            <TextField label="Signature 3" value={d.signature_3 ?? ""} maxLength={40} onChange={(e) => set("signature_3", e.target.value)} hint="Leave empty to hide" />
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Principal's name" value={d.principal_name ?? ""} maxLength={100} onChange={(e) => set("principal_name", e.target.value)} />
          <div>
            <span className="mb-1.5 block text-sm font-medium">Principal&apos;s signature</span>
            <div className="flex items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {sigUrl ? <img src={sigUrl} alt="Principal's signature" className="h-10 max-w-40 rounded border border-line bg-white object-contain" data-testid="signature-image" />
                : <span className="text-sm text-muted">None</span>}
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files)} data-testid="signature-input" aria-label="Signature image" />
              <Button size="sm" variant="secondary" onClick={() => file.current?.click()} loading={busy === "sig"}><Upload className="size-4" /> {t.has_signature ? "Replace" : "Upload"}</Button>
              {t.has_signature && <Button size="sm" variant="secondary" onClick={removeSig} aria-label="Remove signature"><Trash2 className="size-4" /></Button>}
            </div>
            <p className="mt-1 text-xs text-muted">A scan or photo; a transparent PNG looks best.</p>
          </div>
        </div>
        <label className="block text-sm font-medium">Footer note
          <textarea value={d.footer_note ?? ""} maxLength={300} rows={2} onChange={(e) => set("footer_note", e.target.value)} placeholder="e.g. This is a computer-generated report card."
            className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </label>
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="template-error">{error}</p>}
        <div className="flex items-center gap-3">
          <Button onClick={save} loading={busy === "save"} disabled={!dirty} data-testid="save-template">Save template</Button>
          {dirty && <span className="text-xs text-muted">Unsaved changes. The preview shows the saved template.</span>}
        </div>
      </section>
      <section className="rounded-lg border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Eye className="size-4" /> Preview <span className="font-normal text-muted">(sample data)</span></h2>
          <Button size="sm" variant="secondary" onClick={downloadPreview} data-testid="download-preview"><Download className="size-4" /> PDF</Button>
        </div>
        {preview ? <iframe title="Report card preview" src={preview} className="h-[720px] w-full" data-testid="template-preview" /> : <LoadingState />}
      </section>
    </div>
  );
}

function Templates() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const [list, setList] = useState<ReportCardTemplate[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ copy: boolean } | null>(null);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const l = await apiFetch<ReportCardTemplate[]>("/report-cards/templates", { schoolId });
      setList(l);
      setCurrent((c) => (c && l.some((t) => t.id === c) ? c : l[0]?.id ?? null));
    } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);

  const t = list?.find((x) => x.id === current) ?? null;
  async function create() {
    if (name.trim().length < 2) { setFormError("Enter a name."); return; }
    setBusy(true); setFormError(null);
    try {
      const n = await apiFetch<ReportCardTemplate>("/report-cards/templates", { schoolId, method: "POST", body: { name, copy_from: creating?.copy ? current : null } });
      setCreating(null); setName(""); await load(); setCurrent(n.id);
    } catch (e) { setFormError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function makeDefault() {
    if (!t) return;
    try { setList(await apiFetch<ReportCardTemplate[]>(`/report-cards/templates/${t.id}/default`, { schoolId, method: "POST" })); toast.success(`"${t.name}" is now the default.`); }
    catch (e) { toast.error(errorMessage(e)); }
  }
  async function remove() {
    if (!t) return;
    setBusy(true);
    try { const l = await apiFetch<ReportCardTemplate[]>(`/report-cards/templates/${t.id}`, { schoolId, method: "DELETE" }); setList(l); setCurrent(l[0]?.id ?? null); setDeleting(false); }
    catch (e) { toast.error(errorMessage(e)); setDeleting(false); } finally { setBusy(false); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!list) return <LoadingState />;
  return (
    <>
      <PageHeader title="Report cards" description="Design how report cards look. Each exam uses the default template unless you choose another on the exam's Report cards tab." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Templates" className="flex flex-wrap gap-2">
          {list.map((x) => (
            <button key={x.id} role="tab" aria-selected={x.id === current} onClick={() => setCurrent(x.id)} data-testid={`template-${x.name}`}
              className={clsx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm", x.id === current ? "border-leaf-600 bg-leaf-50 font-medium" : "border-line bg-white hover:bg-paper")}>
              <span className="size-3 rounded-full" style={{ background: x.accent_color }} />{x.name}
              {x.is_default && <Star className="size-3.5 fill-pencil-400 text-pencil-400" aria-label="default" />}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => { setCreating({ copy: true }); setName(t ? `${t.name} copy` : ""); }} disabled={!t}><Copy className="size-4" /> Duplicate</Button>
        <Button size="sm" onClick={() => { setCreating({ copy: false }); setName(""); }} data-testid="new-template"><Plus className="size-4" /> New template</Button>
      </div>
      {t && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted">
            {t.is_default ? <span className="font-medium text-ink" data-testid="is-default">Default template</span>
              : <Button size="sm" variant="secondary" onClick={makeDefault} data-testid="make-default"><Star className="size-4" /> Make default</Button>}
            <span>Used by {t.exams_using} exam{t.exams_using === 1 ? "" : "s"}</span>
            {!t.is_default && <Button size="sm" variant="secondary" onClick={() => setDeleting(true)} aria-label="Delete template"><Trash2 className="size-4" /></Button>}
          </div>
          <Editor schoolId={schoolId} t={t} onSaved={(n) => setList(list.map((x) => (x.id === n.id ? n : x)))} />
        </>
      )}
      <Modal open={!!creating} onClose={() => setCreating(null)} title={creating?.copy ? "Duplicate template" : "New template"}
        footer={<><Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button><Button onClick={create} loading={busy} data-testid="create-template">Create</Button></>}>
        <TextField label="Name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} error={formError} placeholder="e.g. Annual – blue" />
      </Modal>
      <ConfirmDialog open={deleting} title={`Delete "${t?.name}"?`} message="Exams using it will use the default template instead."
        confirmLabel="Delete" loading={busy} onConfirm={remove} onCancel={() => setDeleting(false)} />
    </>
  );
}

export default function ReportCardsPage() {
  return <RequirePermission permission="report_cards:manage"><Templates /></RequirePermission>;
}
