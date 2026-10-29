"use client";

import { clsx } from "clsx";
import { Megaphone, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { NoticeList } from "@/components/portal/notice-list";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { ClassList, Notice, NoticeAudience, SchoolClass } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const AUDIENCE: Record<NoticeAudience, string> = { everyone: "Everyone", parents: "Parents", students: "Students", staff: "Staff only" };
const STATE_TONE = { live: "bg-leaf-50 text-leaf-700", scheduled: "bg-pencil-100 text-ink", expired: "bg-paper text-muted" };
const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

function NoticeForm({ open, notice, classes, schoolId, onClose, onSaved }: {
  open: boolean; notice: Notice | null; classes: SchoolClass[]; schoolId: string; onClose: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<NoticeAudience>("everyone");
  const [classIds, setClassIds] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [publishAt, setPublishAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setTitle(notice?.title ?? ""); setBody(notice?.body ?? ""); setAudience(notice?.audience ?? "everyone");
    setClassIds(notice?.class_ids ?? []); setPinned(notice?.is_pinned ?? false);
    setPublishAt(local(notice?.publish_at ?? null)); setExpiresAt(local(notice?.expires_at ?? null)); setError(null);
  }, [open, notice]);

  async function save() {
    if (title.trim().length < 3) return setError("Give the notice a title (at least 3 characters).");
    if (!body.trim()) return setError("Write the notice.");
    if (publishAt && expiresAt && expiresAt <= publishAt) return setError("The notice must expire after it's published.");
    setBusy(true);
    setError(null);
    try {
      const payload = { title: title.trim(), body: body.trim(), audience, class_ids: classIds.length ? classIds : null, is_pinned: pinned,
        publish_at: publishAt ? new Date(publishAt).toISOString() : null, expires_at: expiresAt ? new Date(expiresAt).toISOString() : null };
      await apiFetch(notice ? `/notices/${notice.id}` : "/notices", { method: notice ? "PUT" : "POST", schoolId, body: payload });
      onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} size="lg" onClose={busy ? () => {} : onClose} title={notice ? "Edit notice" : "New notice"}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-notice">{notice ? "Save" : "Publish"}</Button></>}>
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert">{error}</p>}
        <TextField label="Title" maxLength={150} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="block text-sm font-medium">Notice
          <textarea value={body} maxLength={5000} rows={6} onChange={(e) => setBody(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Who can see it" value={audience} onChange={(e) => setAudience(e.target.value as NoticeAudience)}>
            {(Object.keys(AUDIENCE) as NoticeAudience[]).map((a) => <option key={a} value={a}>{AUDIENCE[a]}</option>)}
          </SelectField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to top</label>
          <TextField label="Publish at (optional)" type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} hint="Leave empty to publish now" />
          <TextField label="Expires at (optional)" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
        {audience !== "staff" && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Only for these classes <span className="font-normal text-muted">(none ticked = whole school)</span></legend>
            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {classes.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--color-leaf-600)]" checked={classIds.includes(c.id)}
                    onChange={(e) => setClassIds((x) => (e.target.checked ? [...x, c.id] : x.filter((i) => i !== c.id)))} /> {c.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}

function ManageNotices() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const [items, setItems] = useState<Notice[] | null>(null);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Notice | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<Notice | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [n, c] = await Promise.all([apiFetch<Notice[]>("/notices", { schoolId, query: { include_inactive: "true" } }),
        apiFetch<ClassList>("/classes", { schoolId, query: { status: "active" } })]);
      setItems(n); setClasses(c.items);
    } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState />;
  return (
    <>
      <PageHeader title="Notices" description="Announcements for parents, staff or everyone, optionally only for some classes."
        actions={<Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="size-4" /> New notice</Button>} />
      {items.length === 0 ? <div className="rounded-lg border border-line bg-white"><EmptyState icon={Megaphone} title="No notices yet" message="Publish a notice and parents will see it in their portal." /></div> : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-white" data-testid="manage-notices">
          {items.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <p className="font-medium">{n.title}</p>
                <p className="text-xs text-muted">{AUDIENCE[n.audience]}{n.class_names.length ? ` · ${n.class_names.join(", ")}` : ""} · {formatDate(n.publish_at.slice(0, 10))}{n.expires_at ? ` – ${formatDate(n.expires_at.slice(0, 10))}` : ""}{n.is_pinned ? " · pinned" : ""}</p>
              </div>
              <span className="flex items-center gap-2">
                <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATE_TONE[n.state])}>{n.state}</span>
                <ActionMenu label={`Actions for ${n.title}`} actions={[
                  { label: "Edit", onSelect: () => { setEditing(n); setFormOpen(true); } },
                  { label: "Delete", onSelect: () => setDeleting(n), tone: "danger" },
                ]} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <NoticeForm open={formOpen} notice={editing} classes={classes} schoolId={schoolId} onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); toast.success(editing ? "Notice saved." : "Notice published."); void load(); }} />
      <ConfirmDialog open={deleting !== null} title={`Delete "${deleting?.title}"?`} message="It disappears for everyone straight away." confirmLabel="Delete"
        onCancel={() => setDeleting(null)} onConfirm={async () => {
          try { await apiFetch(`/notices/${deleting!.id}`, { method: "DELETE", schoolId }); toast.success("Notice deleted."); setDeleting(null); void load(); }
          catch (e) { toast.error(errorMessage(e)); }
        }} />
    </>
  );
}

function NoticesHome() {
  const { currentSchool, can } = useAuth();
  if (can("notices:manage")) return <ManageNotices />;
  return <><PageHeader title="Notices" description="Announcements from your school." /><NoticeList schoolId={currentSchool!.school_id} /></>;
}

export default function NoticesPage() {
  return <RequirePermission permission="notices:view"><NoticesHome /></RequirePermission>;
}
