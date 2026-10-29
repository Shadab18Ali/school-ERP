"use client";

import { clsx } from "clsx";
import { CheckCircle2, FileBadge, Search, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, apiFetchBlob, errorMessage } from "@/lib/api";
import { CERTIFICATE_KINDS, KIND_HINT, KIND_LABEL, type Certificate, type CertificateTemplate } from "@/lib/documents";
import { todayISO } from "@/lib/format";
import type { AcademicSession, StudentDetail, StudentList, StudentListItem } from "@/lib/types";
import { CertificatePaper, PdfActions } from "./shared";

interface Picked { id: string; full_name: string; student_code: string; status: string; class_section: string | null }

/** Issue a certificate: pick the kind, the student and the session, fill in what the template asks, preview, issue. */
export function IssueTab({ schoolId, initialStudent }: { schoolId: string; initialStudent?: string | null }) {
  const [templates, setTemplates] = useState<CertificateTemplate[] | null>(null);
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [student, setStudent] = useState<Picked | null>(null);
  const [issuedOn, setIssuedOn] = useState(todayISO());
  const [purpose, setPurpose] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [markLeft, setMarkLeft] = useState(true);
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "issue" | null>(null);
  const [issued, setIssued] = useState<Certificate | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, s] = await Promise.all([
        apiFetch<CertificateTemplate[]>("/certificates/templates", { schoolId }),
        apiFetch<AcademicSession[]>("/sessions", { schoolId }),
      ]);
      setTemplates(t.filter((x) => x.is_active));
      setSessions(s);
      setSessionId((cur) => cur || s.find((x) => x.is_current)?.id || s[0]?.id || "");
    } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => { // /certificates?student=<id> (from a student's page)
    if (!initialStudent) return;
    apiFetch<StudentDetail>(`/students/${initialStudent}`, { schoolId })
      .then((s) => setStudent({ id: s.id, full_name: s.full_name, student_code: s.student_code, status: s.status,
        class_section: s.current_enrollment ? `${s.current_enrollment.class_name} – ${s.current_enrollment.section_name}` : null }))
      .catch(() => undefined);
  }, [initialStudent, schoolId]);

  const template = templates?.find((t) => t.id === templateId) ?? null;
  const usesPurpose = !!template && /\{\{\s*purpose\s*\}\}/.test(template.body + template.title);
  useEffect(() => { setPreview(null); setFormError(null); }, [templateId, student, sessionId, issuedOn, purpose, fields, markLeft]);
  useEffect(() => { setFields({}); }, [templateId]);

  function body() {
    return {
      template_id: templateId, student_id: student!.id, session_id: sessionId || null, issued_on: issuedOn,
      purpose: usesPurpose ? purpose.trim() || null : null,
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim() || null])),
      mark_left: template?.kind === "transfer" ? markLeft : false,
    };
  }
  function check(): boolean {
    if (!template || !student) { setFormError("Choose the certificate and the student."); return false; }
    if (usesPurpose && purpose.trim().length < 2) { setFormError("Write the purpose (e.g. passport application)."); return false; }
    const missing = template.fields.find((f) => f.required && !(fields[f.key] ?? "").trim());
    if (missing) { setFormError(`Fill in “${missing.label}”.`); return false; }
    return true;
  }
  async function doPreview() {
    if (!check()) return;
    setBusy("preview"); setFormError(null);
    try { setPreview(await apiFetch<{ title: string; body: string }>("/certificates/preview", { schoolId, method: "POST", body: body() })); }
    catch (e) { setFormError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function doIssue() {
    if (!check()) return;
    setBusy("issue"); setFormError(null);
    try { setIssued(await apiFetch<Certificate>("/certificates", { schoolId, method: "POST", body: body() })); }
    catch (e) { setFormError(errorMessage(e)); } finally { setBusy(null); }
  }
  function again() {
    setIssued(null); setPreview(null); setStudent(null); setPurpose(""); setFields({}); setIssuedOn(todayISO());
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!templates) return <LoadingState />;
  if (issued) return (
    <section className="rounded-lg border border-line bg-white p-5" data-testid="issued-result">
      <p className="flex items-center gap-2 font-semibold text-leaf-700"><CheckCircle2 className="size-5" /> {issued.title} issued</p>
      <p className="mt-1 text-sm text-muted">
        <span className="font-medium text-ink" data-testid="issued-number">{issued.certificate_number}</span> for {issued.student_name} ({issued.student_code}).
        {issued.kind === "transfer" && markLeft && " The student has been marked as having left the school."}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PdfActions size="md" label={`certificate ${issued.certificate_number}`} fileName={`${issued.certificate_number}.pdf`}
          fetchPdf={async () => (await apiFetchBlob(`/certificates/${issued.id}/certificate.pdf`, { schoolId })).blob} />
        <Button variant="ghost" onClick={again} data-testid="issue-another">Issue another</Button>
      </div>
      <p className="mt-3 text-xs text-muted">Anyone can check it by scanning the QR code on the certificate. It can&apos;t be edited; if something is wrong, revoke it (Issued tab) and issue a new one.</p>
      <div className="mt-4 max-w-3xl"><CertificatePaper title={issued.title} body={issued.body} number={issued.certificate_number} /></div>
    </section>
  );
  if (templates.length === 0) return <EmptyState icon={FileBadge} title="No certificates in use" message="Turn a certificate template on (Templates tab) to issue it." />;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="space-y-5 rounded-lg border border-line bg-white p-5">
        <div>
          <h2 className="mb-2 text-sm font-semibold">1. Certificate</h2>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Certificate">
            {CERTIFICATE_KINDS.flatMap((k) => templates.filter((t) => t.kind === k)).map((t) => (
              <button key={t.id} role="radio" aria-checked={templateId === t.id} onClick={() => setTemplateId(t.id)} data-testid={`pick-template-${t.prefix}`}
                className={clsx("rounded-md border p-3 text-left text-sm", templateId === t.id ? "border-leaf-600 bg-leaf-50" : "border-line hover:bg-paper")}>
                <span className="block font-medium">{t.name}</span>
                <span className="block text-xs text-muted">{KIND_LABEL[t.kind]} · {t.prefix}-…{t.kind !== "custom" ? ` · ${KIND_HINT[t.kind]}` : ""}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold">2. Student</h2>
          <SelectField label="Academic session" value={sessionId} onChange={(e) => { setSessionId(e.target.value); setStudent(null); }} data-testid="issue-session">
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : ""}</option>)}
          </SelectField>
          <p className="mt-1 text-xs text-muted">The class and admission number on the certificate come from this session.</p>
          <div className="mt-3">
            {student ? (
              <div className="flex items-center gap-3 rounded-md border border-leaf-600 bg-leaf-50 px-3 py-2 text-sm" data-testid="picked-student">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{student.full_name} <span className="text-xs text-muted">{student.student_code}</span></p>
                  <p className="text-xs text-muted">{student.class_section ?? "Not enrolled in this session"}{student.status !== "active" ? " · has left" : ""}</p>
                </div>
                <button onClick={() => setStudent(null)} aria-label="Choose another student" className="rounded p-1 text-muted hover:bg-white"><X className="size-4" /></button>
              </div>
            ) : <StudentPicker schoolId={schoolId} sessionId={sessionId} onPick={setStudent} />}
          </div>
        </div>
        {template && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold">3. Details</h2>
            <TextField label="Date of issue" type="date" required max={todayISO()} value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
            {usesPurpose && <TextField label="Purpose" required maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. passport application" data-testid="issue-purpose" />}
            {template.fields.map((f) => (
              <TextField key={f.key} label={f.label} required={f.required} type={f.type === "date" ? "date" : "text"} maxLength={300}
                value={fields[f.key] ?? ""} onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))} data-testid={`field-${f.key}`}
                hint={!f.required ? "Optional — left empty, its line isn't printed" : undefined} />
            ))}
            {template.kind === "transfer" && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={markLeft} onChange={(e) => setMarkLeft(e.target.checked)} className="mt-0.5 size-4 accent-leaf-600" data-testid="mark-left" />
                <span>Mark the student as having left the school<span className="block text-xs text-muted">They stay on record (inactive), with the TC number as the reason.</span></span>
              </label>
            )}
          </div>
        )}
        {formError && <p className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-600" role="alert" data-testid="issue-error">{formError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={doPreview} loading={busy === "preview"} disabled={!template || !student} data-testid="preview-certificate">Preview</Button>
          <Button onClick={doIssue} loading={busy === "issue"} disabled={!template || !student || !preview} data-testid="issue-certificate">Issue certificate</Button>
        </div>
        {!preview && template && student && <p className="text-xs text-muted">Preview first: the wording is filled in from the student&apos;s record and can&apos;t be changed after issuing.</p>}
      </section>
      <section aria-label="Preview">
        {preview ? <CertificatePaper title={preview.title} body={preview.body} number={`${template?.prefix}-${issuedOn.slice(0, 4)}-…`} testId="certificate-preview" />
          : <div className="grid h-full min-h-48 place-items-center rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">The certificate will appear here when you preview it.</div>}
      </section>
    </div>
  );
}

function StudentPicker({ schoolId, sessionId, onPick }: { schoolId: string; sessionId: string; onPick: (s: Picked) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<StudentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const term = useMemo(() => q.trim(), [q]);
  useEffect(() => {
    if (term.length < 2) { setItems(null); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const r = await apiFetch<StudentList>("/students", { schoolId, signal: ctl.signal, query: { search: term, session_id: sessionId || undefined, page_size: 8, sort: "name" } });
        setItems(r.items); setError(null);
      } catch (e) { if (!ctl.signal.aborted) setError(errorMessage(e)); }
    }, 250);
    return () => { ctl.abort(); window.clearTimeout(t); };
  }, [term, schoolId, sessionId]);
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <label htmlFor="cert-student-search" className="sr-only">Find the student</label>
        <input id="cert-student-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Student's name, ID or admission number" data-testid="student-search"
          className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
      </div>
      {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
      {items && (items.length === 0 ? <p className="mt-2 text-sm text-muted">No student in this session matches “{term}”.</p> : (
        <ul className="mt-2 divide-y divide-line rounded-md border border-line" data-testid="student-results">
          {items.map((s) => (
            <li key={s.id}>
              <button className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-paper" data-testid={`student-result-${s.student_code}`}
                onClick={() => onPick({ id: s.id, full_name: s.full_name, student_code: s.student_code, status: s.status, class_section: `${s.enrollment.class_name} – ${s.enrollment.section_name}` })}>
                <span className="min-w-0 flex-1"><span className="font-medium">{s.full_name}</span> <span className="text-xs text-muted">{s.student_code} · {s.enrollment.class_name} – {s.enrollment.section_name}</span></span>
                {s.status !== "active" && <span className="text-xs text-muted">left</span>}
              </button>
            </li>
          ))}
        </ul>
      ))}
      <p className="mt-2 text-xs text-muted">Or open a student&apos;s page and choose <Link href="/students" className="underline">Certificate</Link>.</p>
    </div>
  );
}
