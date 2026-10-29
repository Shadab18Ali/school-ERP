"use client";

import { clsx } from "clsx";
import { FileCheck2, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { ExamSetup } from "@/components/exams/exam-setup";
import { ExamStatusBadge } from "@/components/exams/shared";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { AcademicSession, ExamDetail, ExamSummary, ExamType } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function NewExam({ schoolId, sessionId, open, onClose }: { schoolId: string; sessionId: string; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [types, setTypes] = useState<ExamType[]>([]);
  const [type, setType] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null); setName(""); setType("");
    apiFetch<{ types: ExamType[] }>("/exams/setup", { schoolId }).then((s) => setTypes(s.types.filter((t) => t.is_active))).catch(() => setTypes([]));
  }, [open, schoolId]);
  const typeName = types.find((t) => t.id === type)?.name;
  async function save() {
    if (!type) { setError("Choose the exam type."); return; }
    if (name.trim().length < 2) { setError("Enter a name."); return; }
    setBusy(true); setError(null);
    try {
      const x = await apiFetch<ExamDetail>("/exams", { schoolId, method: "POST", body: { academic_session_id: sessionId, exam_type_id: type, name } });
      router.push(`/exams/${x.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="New exam"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} data-testid="save-exam">Create</Button></>}>
      <div className="space-y-4">
        <SelectField label="Exam type" value={type} onChange={(e) => {
          setType(e.target.value);
          const t = types.find((x) => x.id === e.target.value);
          if (t && !name) setName(t.name);
        }}>
          <option value="">Choose type</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </SelectField>
        {types.length === 0 && <p className="text-sm text-muted">No exam types yet. Add them under the Setup tab.</p>}
        <TextField label="Name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={typeName ? `${typeName} 1` : "e.g. Unit Test 1"}
          hint="Unique within the session, e.g. Unit Test 1, Half Yearly" />
        {error && <p className="text-sm text-danger-600" role="alert" data-testid="exam-form-error">{error}</p>}
      </div>
    </Modal>
  );
}

function ExamList({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [session, setSession] = useState("");
  const [d, setD] = useState<{ session: { id: string; name: string; is_archived: boolean } | null; items: ExamSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const latest = useRef(0);
  useEffect(() => { apiFetch<AcademicSession[]>("/sessions", { schoolId }).then(setSessions).catch(() => setSessions([])); }, [schoolId]);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setError(null);
    try { const r = await apiFetch<typeof d>("/exams", { schoolId, query: { session_id: session || undefined } }); if (mine === latest.current) setD(r); }
    catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [schoolId, session]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return <LoadingState />;
  const manage = can("exams:manage") && d.session && !d.session.is_archived;
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4">
        <SelectField label="Academic session" value={session || d.session?.id || ""} onChange={(e) => setSession(e.target.value)}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : s.is_archived ? " (archived)" : ""}</option>)}
        </SelectField>
        {manage && <Button onClick={() => setAdding(true)} data-testid="new-exam"><Plus className="size-4" /> New exam</Button>}
      </div>
      {d.items.length === 0 ? (
        <EmptyState icon={FileCheck2} title="No exams yet" message={manage ? "Create an exam, then add its date sheet." : "Exams appear here once the school sets them up."} />
      ) : (
        <ul className="divide-y divide-line" data-testid="exam-list">
          {d.items.map((x) => (
            <li key={x.id} data-testid={`exam-row-${x.name}`}>
              <Link href={`/exams/${x.id}`} className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 hover:bg-paper">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{x.name}</span><ExamStatusBadge status={x.status} /></div>
                  <p className="text-xs text-muted">{x.type_name} · {x.papers} paper{x.papers === 1 ? "" : "s"} · {x.classes} class{x.classes === 1 ? "" : "es"}</p>
                </div>
                <span className="text-sm">{x.first_date ? (x.first_date === x.last_date ? formatDate(x.first_date) : `${formatDate(x.first_date)} – ${formatDate(x.last_date)}`) : <span className="text-muted">No dates yet</span>}</span>
                <span className="tabular w-40 text-right text-sm" data-testid="exam-progress">
                  {x.marks_expected ? <>{x.marks_entered}/{x.marks_expected} marks<span className="block text-xs text-muted">{Math.round((100 * x.marks_entered) / x.marks_expected)}% entered</span></> : "—"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {d.session && <NewExam schoolId={schoolId} sessionId={d.session.id} open={adding} onClose={() => setAdding(false)} />}
    </section>
  );
}

function Exams() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const tabs = ["Exams", ...(can("exams:manage") ? ["Setup"] : [])];
  const [tab, setTab] = useState("Exams");
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeader title="Exams" description="Exams, date sheets, marks and results." />
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Exams" className="mb-4 flex gap-1 border-b border-line">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
          ))}
        </div>
      )}
      {tab === "Exams" ? <ExamList key={version} schoolId={schoolId} /> : <ExamSetup schoolId={schoolId} onChange={() => setVersion((v) => v + 1)} />}
    </>
  );
}

export default function ExamsPage() {
  return <RequirePermission permission="exams:view"><Exams /></RequirePermission>;
}
