"use client";

import { ArrowLeft, BookOpen, CheckCircle2, Send } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { HomeworkFile, HomeworkKind, StudentHomework, StudentHomeworkDetail } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";
import { ACCEPT, DueText, FILE_HINT, HomeworkFiles, HomeworkStatusBadge, KindBadge } from "./shared";

/**
 * A student's homework (or one kind of it) for the student themself (`base` = /my)
 * or a parent (`base` = /portal/children/{id}). `linkBase` is the page route prefix.
 */
export function StudentHomeworkList({ base, linkBase, kind }: { base: string; linkBase: string; kind?: HomeworkKind }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [d, setD] = useState<{ items: StudentHomework[]; counts: Record<string, number> } | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch(`${base}/homework`, { schoolId, query: { kind } })); }
    catch (e) { setError({ message: errorMessage(e), missing: e instanceof ApiError && e.status === 404 }); }
  }, [base, schoolId, kind]);
  useEffect(() => { void load(); }, [load]);

  const what = kind === "assignment" ? "assignments" : "homework";
  if (error) return error.missing
    ? <p className="rounded-lg border border-line bg-white p-6 text-sm text-muted" data-testid="homework-missing">Not enrolled in a class this session, so there is no {what}.</p>
    : <ErrorState message={error.message} onRetry={load} />;
  if (!d) return <LoadingState />;
  if (d.items.length === 0) return (
    <div className="rounded-lg border border-line bg-white" data-testid="homework-empty">
      <EmptyState icon={BookOpen} title={`No ${what} yet`} message={`When teachers set ${what}, it appears here.`} />
    </div>
  );
  const todo = (d.counts.pending ?? 0);
  return (
    <section className="rounded-lg border border-line bg-white" data-testid="student-homework">
      <p className="border-b border-line px-5 py-3 text-sm" data-testid="homework-counts">
        {todo ? <><span className="font-semibold">{todo}</span> to do</> : "Nothing to do right now"}
        {d.counts.missing ? <> · <span className="text-danger-600">{d.counts.missing} missed</span></> : null}
        {d.counts.reviewed ? <> · {d.counts.reviewed} reviewed</> : null}
      </p>
      <ul className="divide-y divide-line">
        {d.items.map((h) => (
          <li key={h.id} data-testid={`my-homework-${h.title}`}>
            <Link href={`${linkBase}/homework/${h.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-paper">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{h.title}</span>{!kind && <KindBadge kind={h.kind} />}</div>
                <p className="text-xs text-muted">{h.subject_name ?? "General"}{h.teacher_name ? ` · ${h.teacher_name}` : ""}{h.attachment_count ? ` · ${h.attachment_count} file${h.attachment_count === 1 ? "" : "s"}` : ""}</p>
              </div>
              <DueText dueAt={h.due_at} closed={h.is_closed} allowLate={h.allow_late} />
              <span className="flex w-36 items-center justify-end gap-2">
                {h.marks && h.max_marks ? <span className="tabular text-sm font-semibold">{h.marks}/{h.max_marks}</span> : null}
                <HomeworkStatusBadge status={h.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One homework: instructions, teacher's files, the student's own submission, marks and feedback. */
export function StudentHomeworkView({ base, homeworkId, backHref, backLabel }: {
  base: string; homeworkId: string; backHref: (kind: HomeworkKind | null) => string; backLabel: string;
}) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const [h, setH] = useState<StudentHomeworkDetail | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [answer, setAnswer] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await apiFetch<StudentHomeworkDetail>(`${base}/homework/${homeworkId}`, { schoolId });
      setH(d); setAnswer(d.submission?.answer ?? "");
    } catch (e) { setError({ message: errorMessage(e), missing: e instanceof ApiError && (e.status === 404 || e.status === 422) }); }
  }, [base, homeworkId, schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function submit() {
    const have = h?.submission?.files.length ?? 0;
    if (!answer.trim() && files.length === 0 && have === 0) { setFormError("Write an answer or attach at least one file."); return; }
    if (have + files.length > 5) { setFormError("You can attach at most 5 files."); return; }
    const big = files.find((f) => f.size > 10 * 1024 * 1024);
    if (big) { setFormError(`${big.name} is larger than 10 MB.`); return; }
    setBusy("submit"); setFormError(null);
    const form = new FormData();
    form.append("answer", answer);
    files.forEach((f) => form.append("files", f));
    try {
      const d = await apiFetch<StudentHomeworkDetail>(`/my/homework/${homeworkId}/submission`, { schoolId, method: "POST", body: form });
      setH(d); setFiles([]); if (input.current) input.current.value = "";
      toast.success(h?.submission ? "Your submission was updated." : "Submitted. Your teacher can see it now.");
    } catch (e) { setFormError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function removeFile(f: HomeworkFile) {
    setBusy(f.id);
    try { setH(await apiFetch<StudentHomeworkDetail>(`/my/homework/${homeworkId}/submission/files/${f.id}`, { schoolId, method: "DELETE" })); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }

  const back = <Link href={backHref(h?.kind ?? null)} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> {backLabel}</Link>;
  if (error) return <>{back}<ErrorState message={error.missing ? "This homework doesn't exist or isn't for this class." : error.message} onRetry={error.missing ? undefined : load} /></>;
  if (!h) return <LoadingState />;
  const sub = h.submission;
  const isSelf = base === "/my";

  return (
    <>
      {back}
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{h.title}</h1><KindBadge kind={h.kind} /><HomeworkStatusBadge status={h.status} />
        </div>
        <p className="text-sm text-muted">{h.subject_name ?? "General"}{h.teacher_name ? ` · ${h.teacher_name}` : ""}{h.max_marks ? ` · out of ${h.max_marks}` : ""}</p>
        <DueText dueAt={h.due_at} closed={h.is_closed} allowLate={h.allow_late} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4 rounded-lg border border-line bg-white p-5">
          <div>
            <h2 className="mb-1 text-sm font-semibold">Instructions</h2>
            {h.description ? <p className="whitespace-pre-wrap break-words text-sm" data-testid="homework-description">{h.description}</p> : <p className="text-sm text-muted">No description.</p>}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold">Files from the teacher</h2>
            <HomeworkFiles files={h.attachments} schoolId={schoolId} path={(f) => `${base}/homework/${h.id}/attachments/${f.id}`} testId="attachments" />
          </div>
        </section>

        <section className="space-y-4 rounded-lg border border-line bg-white p-5" data-testid="my-submission">
          <h2 className="font-semibold">{isSelf ? "Your work" : "Submitted work"}</h2>
          {sub?.reviewed_at && (
            <div className="rounded-md bg-leaf-50 p-4" data-testid="review">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-leaf-700"><CheckCircle2 className="size-4" /> Reviewed {formatDateTime(sub.reviewed_at)}</p>
              {sub.marks && <p className="mt-1 text-2xl font-semibold tabular" data-testid="review-marks">{sub.marks}{h.max_marks ? <span className="text-base font-normal text-muted"> / {h.max_marks}</span> : null}</p>}
              {sub.feedback && <p className="mt-1 whitespace-pre-wrap break-words text-sm" data-testid="review-feedback">{sub.feedback}</p>}
            </div>
          )}
          {sub && <p className="text-xs text-muted" data-testid="submitted-at">Submitted {formatDateTime(sub.submitted_at)}{sub.is_late ? " (late)" : ""}</p>}

          {h.can_submit ? (
            <>
              <label className="block text-sm font-medium">Answer
                <textarea value={answer} maxLength={5000} rows={6} onChange={(e) => setAnswer(e.target.value)} placeholder="Type your answer here (optional if you attach files)"
                  className="mt-1.5 w-full rounded-md border border-line px-3 py-2 text-sm font-normal focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
              </label>
              {sub && sub.files.length > 0 && (
                <HomeworkFiles files={sub.files} schoolId={schoolId} path={(f) => `/my/homework/${h.id}/files/${f.id}`} onRemove={removeFile} removing={busy} testId="my-files" />
              )}
              <div>
                <label htmlFor="submission-files" className="block text-sm font-medium">Attach files</label>
                <input id="submission-files" ref={input} type="file" multiple accept={ACCEPT} onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                  className="mt-1.5 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-leaf-50 file:px-3 file:py-2 file:text-sm file:font-medium" />
                <p className="mt-1 text-xs text-muted">{FILE_HINT}. Photos of handwritten work are fine.</p>
              </div>
              {formError && <p className="text-sm text-danger-600" role="alert" data-testid="submit-error">{formError}</p>}
              <div className="flex items-center gap-3">
                <Button onClick={submit} loading={busy === "submit"} data-testid="submit-homework"><Send className="size-4" /> {sub ? "Update submission" : "Submit"}</Button>
                <p className="text-xs text-muted">{h.status === "pending" && new Date(h.due_at).getTime() < Date.now() ? "The deadline has passed; this will be marked late." : "You can change it until your teacher reviews it."}</p>
              </div>
            </>
          ) : sub ? (
            <>
              {sub.answer ? <p className="whitespace-pre-wrap break-words rounded-md bg-paper p-3 text-sm" data-testid="submission-answer">{sub.answer}</p> : null}
              <HomeworkFiles files={sub.files} schoolId={schoolId} path={(f) => `${base}/homework/${h.id}/files/${f.id}`} testId="my-files" />
            </>
          ) : (
            <p className="text-sm text-muted" data-testid="not-submitted">
              {h.status === "missing" ? "Not submitted, and the deadline has passed." : isSelf ? "This can't be submitted." : "Not submitted yet."}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
