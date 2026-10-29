"use client";

import { ArrowLeft, Pencil, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { HomeworkFormModal } from "@/components/homework/homework-form-modal";
import { ACCEPT, DueText, FILE_HINT, HomeworkFiles, KindBadge } from "@/components/homework/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { HomeworkDetail, HomeworkFile, HomeworkSubmission, RosterRow } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function ReviewModal({ schoolId, hw, row, onClose, onSaved }: {
  schoolId: string; hw: HomeworkDetail; row: RosterRow; onClose: () => void; onSaved: () => void;
}) {
  const [sub, setSub] = useState<HomeworkSubmission | null>(null);
  const [marks, setMarks] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiFetch<HomeworkSubmission>(`/homework/${hw.id}/submissions/${row.submission_id}`, { schoolId })
      .then((s) => { setSub(s); setMarks(s.marks ?? ""); setFeedback(s.feedback ?? ""); })
      .catch((e) => setError(errorMessage(e)));
  }, [hw.id, row.submission_id, schoolId]);

  async function save() {
    if (marks && (!(Number(marks) >= 0) || (hw.max_marks && Number(marks) > Number(hw.max_marks)))) {
      setError(`Marks must be between 0 and ${hw.max_marks}.`); return;
    }
    setBusy(true); setError(null);
    try {
      await apiFetch(`/homework/${hw.id}/submissions/${row.submission_id}/review`, { schoolId, method: "PUT",
        body: { marks: marks.trim() || null, feedback: feedback.trim() || null } });
      onSaved();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Modal open size="lg" title={row.full_name} onClose={busy ? () => {} : onClose}
      description={sub ? `Submitted ${formatDateTime(sub.submitted_at)}${sub.is_late ? " · late" : ""}` : undefined}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
        {!hw.session_is_archived && <Button onClick={save} loading={busy} disabled={!sub} data-testid="save-review">Save review</Button>}</>}>
      {!sub ? (error ? <p className="text-sm text-danger-600">{error}</p> : <LoadingState />) : (
        <div className="space-y-4">
          <div>
            <h3 className="mb-1 text-sm font-medium">Answer</h3>
            {sub.answer ? <p className="whitespace-pre-wrap break-words rounded-md bg-paper p-3 text-sm" data-testid="submission-answer">{sub.answer}</p>
              : <p className="text-sm text-muted">No written answer.</p>}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">Files</h3>
            <HomeworkFiles files={sub.files} schoolId={schoolId} path={(f) => `/homework/${hw.id}/submissions/${sub.id}/files/${f.id}`} testId="submission-files" />
          </div>
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            {hw.max_marks ? (
              <TextField label={`Marks (out of ${hw.max_marks})`} inputMode="decimal" value={marks} onChange={(e) => setMarks(e.target.value)} />
            ) : <p className="text-sm text-muted">Not marked: maximum marks weren&apos;t set.</p>}
            <label className="block text-sm font-medium">Feedback
              <textarea value={feedback} maxLength={2000} rows={4} onChange={(e) => setFeedback(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
            </label>
          </div>
          <p className="text-xs text-muted">Once reviewed, the student can no longer change this submission. The student and their parents see the marks and feedback.</p>
          {error && <p className="text-sm text-danger-600" role="alert" data-testid="review-error">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function Detail({ id }: { id: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const router = useRouter();
  const [hw, setHw] = useState<HomeworkDetail | null>(null);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<RosterRow | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const h = await apiFetch<HomeworkDetail>(`/homework/${id}`, { schoolId });
      setHw(h);
      setRoster(h.can_manage ? await apiFetch<RosterRow[]>(`/homework/${id}/submissions`, { schoolId }) : null);
    } catch (e) { setError({ message: errorMessage(e), missing: e instanceof ApiError && (e.status === 404 || e.status === 422) }); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    setBusy("upload");
    try { setHw(await apiFetch<HomeworkDetail>(`/homework/${id}/attachments`, { schoolId, method: "POST", body: form })); toast.success("Files added."); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); if (fileInput.current) fileInput.current.value = ""; }
  }
  async function removeFile(f: HomeworkFile) {
    setBusy(f.id);
    try { setHw(await apiFetch<HomeworkDetail>(`/homework/${id}/attachments/${f.id}`, { schoolId, method: "DELETE" })); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  async function remove() {
    setBusy("delete");
    try { await apiFetch(`/homework/${id}`, { schoolId, method: "DELETE" }); toast.success("Deleted."); router.push("/homework"); }
    catch (e) { toast.error(errorMessage(e)); setDeleting(false); } finally { setBusy(null); }
  }

  if (error) return <ErrorState message={error.missing ? "This homework doesn't exist or isn't shared with you." : error.message} onRetry={error.missing ? undefined : load} />;
  if (!hw) return <LoadingState />;
  const editable = hw.can_manage && !hw.session_is_archived;
  const notSubmitted = roster ? roster.filter((r) => !r.submission_id).length : 0;

  return (
    <>
      <Link href="/homework" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Homework</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">{hw.title}</h1><KindBadge kind={hw.kind} /></div>
          <p className="text-sm text-muted" data-testid="homework-meta">
            {hw.class_name} – {hw.section_name}{hw.subject_name ? ` · ${hw.subject_name}` : ""}{hw.teacher_name ? ` · set by ${hw.teacher_name}` : ""}
            {hw.max_marks ? ` · out of ${hw.max_marks}` : " · not marked"}{hw.allow_late ? " · late work accepted" : ""}
          </p>
          <DueText dueAt={hw.due_at} closed={hw.is_closed} allowLate={hw.allow_late} />
        </div>
        {editable && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit</Button>
            <Button variant="secondary" onClick={() => setDeleting(true)} disabled={hw.submitted > 0}
              title={hw.submitted > 0 ? "Students have already submitted work" : undefined}><Trash2 className="size-4" /> Delete</Button>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <section className="space-y-4 rounded-lg border border-line bg-white p-5">
          <div>
            <h2 className="mb-1 text-sm font-semibold">Instructions</h2>
            {hw.description ? <p className="whitespace-pre-wrap break-words text-sm" data-testid="homework-description">{hw.description}</p> : <p className="text-sm text-muted">No description.</p>}
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Files for students</h2>
              {editable && (
                <>
                  <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => upload(e.target.files)} data-testid="attachment-input" aria-label="Attachment files" />
                  <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()} loading={busy === "upload"}><Upload className="size-4" /> Add files</Button>
                </>
              )}
            </div>
            <HomeworkFiles files={hw.attachments} schoolId={schoolId} path={(f) => `/homework/${id}/attachments/${f.id}`}
              onRemove={editable ? removeFile : undefined} removing={busy} testId="attachments" />
            {editable && <p className="mt-1 text-xs text-muted">{FILE_HINT}</p>}
          </div>
        </section>

        <section className="rounded-lg border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
            <h2 className="font-semibold">Submissions</h2>
            <p className="text-sm text-muted" data-testid="submission-summary">{hw.submitted} of {hw.students} submitted · {hw.reviewed} reviewed{roster ? ` · ${notSubmitted} not submitted` : ""}</p>
          </div>
          {!roster ? (
            <p className="p-5 text-sm text-muted">Only the teacher who set this, or a school admin, can see and review submissions.</p>
          ) : roster.length === 0 ? <p className="p-5 text-sm text-muted">No students in this class yet.</p> : (
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm" data-testid="roster">
                <thead className="bg-paper text-left text-xs text-muted">
                  <tr><th className="px-4 py-2">Student</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">Submitted</th><th className="px-4 py-2 text-right">Marks</th><th className="px-4 py-2"><span className="sr-only">Review</span></th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {roster.map((r) => (
                    <tr key={r.student_id} data-testid={`roster-${r.admission_number}`}>
                      <td className="px-4 py-2"><span className="font-medium">{r.full_name}</span><span className="block text-xs text-muted">{r.admission_number}</span></td>
                      <td className="px-4 py-2" data-testid="roster-status">
                        {!r.submission_id ? <span className={hw.is_closed ? "text-danger-600" : "text-muted"}>{hw.is_closed ? "Missed" : "Not submitted"}</span>
                          : r.reviewed ? "Reviewed" : r.is_late ? "Submitted late" : "Submitted"}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted">{r.submitted_at ? formatDateTime(r.submitted_at) : "—"}{r.file_count ? ` · ${r.file_count} file${r.file_count === 1 ? "" : "s"}` : ""}</td>
                      <td className="tabular px-4 py-2 text-right" data-testid="roster-marks">{r.marks ?? "—"}</td>
                      <td className="px-4 py-2 text-right">
                        {r.submission_id && <button className="text-sm font-medium text-leaf-700 hover:underline" onClick={() => setReviewing(r)}>{r.reviewed ? "View" : "Review"}</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <HomeworkFormModal schoolId={schoolId} open={editing} editing={hw} onClose={() => setEditing(false)} onSaved={(h) => { setHw(h); setEditing(false); toast.success("Saved."); }} />
      <ConfirmDialog open={deleting} title={`Delete "${hw.title}"?`} message="It will be removed for students and parents, with its files. This can't be undone."
        confirmLabel="Delete" loading={busy === "delete"} onConfirm={remove} onCancel={() => setDeleting(false)} />
      {reviewing && hw && <ReviewModal schoolId={schoolId} hw={hw} row={reviewing} onClose={() => setReviewing(null)}
        onSaved={() => { setReviewing(null); toast.success("Review saved."); void load(); }} />}
    </>
  );
}

export default function HomeworkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="homework:view"><Detail id={id} /></RequirePermission>;
}
