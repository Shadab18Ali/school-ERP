"use client";

import { clsx } from "clsx";
import { ArrowLeft, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { MarksEntry } from "@/components/exams/marks-entry";
import { PaperModal } from "@/components/exams/paper-modal";
import { ReportCardsTab } from "@/components/exams/report-cards-tab";
import { ResultsView } from "@/components/exams/results-view";
import { DateSheet, ExamStatusBadge } from "@/components/exams/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { ExamDetail, ExamPaper, ExamSection, ExamStatus } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

type Tab = "Date sheet" | "Marks entry" | "Results" | "Report cards";
const CONFIRM: Partial<Record<ExamStatus, { title: string; message: string; label: string }>> = {
  published: { title: "Publish results?", label: "Publish results",
    message: "Parents and students will see marks, grades and results, and marks will be locked. Every student needs marks (or absent) in every paper." },
};

function Detail({ id }: { id: string }) {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const router = useRouter();
  const [x, setX] = useState<ExamDetail | null>(null);
  const [sections, setSections] = useState<ExamSection[] | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>("Date sheet");
  const [initial, setInitial] = useState<{ section?: string; paper?: string }>({});
  const [paper, setPaper] = useState<{ open: boolean; editing: ExamPaper | null }>({ open: false, editing: null });
  const [removing, setRemoving] = useState<ExamPaper | null>(null);
  const [statusTo, setStatusTo] = useState<ExamStatus | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [e, s] = await Promise.all([apiFetch<ExamDetail>(`/exams/${id}`, { schoolId }), apiFetch<ExamSection[]>(`/exams/${id}/sections`, { schoolId })]);
      setX(e); setSections(s);
    } catch (e) { setError({ message: errorMessage(e), missing: e instanceof ApiError && (e.status === 404 || e.status === 422) }); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { // deep links from a teacher's class page: ?tab=marks&section=..&paper=..
    try {
      const q = new URLSearchParams(window.location.search);
      const t = q.get("tab");
      if (t === "marks") setTab("Marks entry"); else if (t === "results") setTab("Results"); else if (t === "report-cards") setTab("Report cards");
      setInitial({ section: q.get("section") ?? undefined, paper: q.get("paper") ?? undefined });
    } catch { /* ignore */ }
  }, []);

  async function changeStatus(to: ExamStatus) {
    setBusy(true); setStatusError(null);
    try {
      setX(await apiFetch<ExamDetail>(`/exams/${id}/status`, { schoolId, method: "POST", body: { status: to } }));
      setStatusTo(null);
      toast.success(to === "published" ? "Results published." : to === "scheduled" ? (x?.status === "published" ? "Results unpublished. Marks can be changed again." : "Date sheet published to students and parents.") : "Moved back to draft.");
      void load();
    } catch (e) { setStatusError(errorMessage(e)); setStatusTo(null); } finally { setBusy(false); }
  }
  async function removePaper() {
    if (!removing) return;
    setBusy(true);
    try { setX(await apiFetch<ExamDetail>(`/exams/${id}/papers/${removing.id}`, { schoolId, method: "DELETE" })); void load(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); setRemoving(null); }
  }
  async function rename() {
    if (!renaming || renaming.trim().length < 2) return;
    setBusy(true);
    try { setX(await apiFetch<ExamDetail>(`/exams/${id}`, { schoolId, method: "PATCH", body: { name: renaming } })); setRenaming(null); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await apiFetch(`/exams/${id}`, { schoolId, method: "DELETE" }); router.push("/exams"); }
    catch (e) { toast.error(errorMessage(e)); setDeleting(false); setBusy(false); }
  }

  if (error) return <ErrorState message={error.missing ? "This exam doesn't exist in this school." : error.message} onRetry={error.missing ? undefined : load} />;
  if (!x || !sections) return <LoadingState />;
  const manage = can("exams:manage") && !x.session_is_archived;
  const editSheet = manage && x.status !== "published";
  const tabs: Tab[] = ["Date sheet", "Marks entry", "Results", "Report cards"];

  return (
    <>
      <Link href="/exams" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink print:hidden"><ArrowLeft className="size-4" /> Exams</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-tight">{x.name}</h1><ExamStatusBadge status={x.status} /></div>
          <p className="text-sm text-muted">{x.type_name} · Session {x.session_name}{x.results_published_at ? ` · results published ${formatDateTime(x.results_published_at)}` : ""}</p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2 print:hidden">
            {x.status === "draft" && <Button onClick={() => changeStatus("scheduled")} loading={busy} data-testid="schedule-exam">Publish date sheet</Button>}
            {x.status === "scheduled" && <>
              <Button variant="secondary" onClick={() => changeStatus("draft")} disabled={busy}>Back to draft</Button>
              <Button onClick={() => setStatusTo("published")} data-testid="publish-results">Publish results</Button>
            </>}
            {x.status === "published" && <Button variant="secondary" onClick={() => changeStatus("scheduled")} loading={busy} data-testid="unpublish-results">Unpublish results</Button>}
            <Button variant="secondary" onClick={() => setRenaming(x.name)} aria-label="Rename"><Pencil className="size-4" /></Button>
            {x.status === "draft" && <Button variant="secondary" onClick={() => setDeleting(true)} aria-label="Delete exam"><Trash2 className="size-4" /></Button>}
          </div>
        )}
      </div>
      {statusError && <p className="mb-4 rounded-md bg-danger-50 p-3 text-sm text-danger-600" role="alert" data-testid="status-error">{statusError}</p>}
      {x.status === "draft" && <p className="mb-4 rounded-md border border-line bg-white p-3 text-sm text-muted print:hidden">Draft: only staff can see this exam. Publish the date sheet to show it to students and parents.</p>}

      <div role="tablist" aria-label="Exam" className="mb-4 flex gap-1 overflow-x-auto border-b border-line print:hidden">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
        ))}
      </div>

      <section className="rounded-lg border border-line bg-white print:border-0">
        {tab === "Date sheet" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 print:hidden">
              <p className="text-sm text-muted">{x.papers.length} paper{x.papers.length === 1 ? "" : "s"}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => window.print()}><Printer className="size-4" /> Print</Button>
                {editSheet && <Button size="sm" onClick={() => setPaper({ open: true, editing: null })} data-testid="add-paper"><Plus className="size-4" /> Add paper</Button>}
              </div>
            </div>
            <DateSheet papers={x.papers} onEdit={editSheet ? (p) => setPaper({ open: true, editing: p }) : undefined}
              onDelete={editSheet ? setRemoving : undefined} />
          </>
        ) : tab === "Marks entry" ? (
          <MarksEntry key={`${initial.section}-${initial.paper}`} schoolId={schoolId} exam={x} sections={sections} initial={initial} />
        ) : tab === "Results" ? (
          <ResultsView schoolId={schoolId} exam={x} sections={sections} initial={initial.section} />
        ) : (
          <ReportCardsTab schoolId={schoolId} exam={x} sections={sections} initial={initial.section} onExamChange={setX} />
        )}
      </section>

      <PaperModal schoolId={schoolId} exam={x} open={paper.open} editing={paper.editing} onClose={() => setPaper({ open: false, editing: null })}
        onSaved={(e) => { setX(e); setPaper({ open: false, editing: null }); void load(); }} />
      <ConfirmDialog open={!!removing} title="Remove paper?" message={removing ? `${removing.class_name} · ${removing.subject_name} will be removed from the date sheet.` : ""}
        confirmLabel="Remove" loading={busy} onConfirm={removePaper} onCancel={() => setRemoving(null)} />
      <ConfirmDialog open={!!statusTo} tone="primary" title={statusTo ? CONFIRM[statusTo]?.title ?? "" : ""} message={statusTo ? CONFIRM[statusTo]?.message ?? "" : ""}
        confirmLabel={statusTo ? CONFIRM[statusTo]?.label ?? "Confirm" : "Confirm"} loading={busy} onConfirm={() => statusTo && changeStatus(statusTo)} onCancel={() => setStatusTo(null)} />
      <ConfirmDialog open={deleting} title={`Delete "${x.name}"?`} message="The exam and its date sheet will be removed. Exams with marks can't be deleted."
        confirmLabel="Delete" loading={busy} onConfirm={remove} onCancel={() => setDeleting(false)} />
      <Modal open={renaming !== null} onClose={() => setRenaming(null)} title="Rename exam"
        footer={<><Button variant="secondary" onClick={() => setRenaming(null)}>Cancel</Button><Button onClick={rename} loading={busy}>Save</Button></>}>
        <TextField label="Name" value={renaming ?? ""} maxLength={100} onChange={(e) => setRenaming(e.target.value)} />
      </Modal>
    </>
  );
}

export default function ExamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="exams:view"><Detail id={id} /></RequirePermission>;
}
