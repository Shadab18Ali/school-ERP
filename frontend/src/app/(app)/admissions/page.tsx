"use client";

import { clsx } from "clsx";
import { Copy, ExternalLink, Inbox, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdmissionStatusBadge, type AdmissionListItem, type AdmissionWindowRow, STATUS_ORDER, staffLabel } from "@/components/admissions/shared";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, formatPhone } from "@/lib/format";
import { STATUS_LABEL, type AdmissionStatus } from "@/lib/public-api";
import type { AcademicSession } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const PAGE_SIZE = 25;

function useSessions(schoolId: string) {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  useEffect(() => { apiFetch<AcademicSession[]>("/sessions", { schoolId }).then(setSessions).catch(() => setSessions([])); }, [schoolId]);
  return sessions;
}
const sessionLabel = (s: AcademicSession) => `${s.name}${s.is_current ? " (current)" : s.is_archived ? " (archived)" : ""}`;

function Applications({ schoolId }: { schoolId: string }) {
  const sessions = useSessions(schoolId);
  const [session, setSession] = useState("");
  const [status, setStatus] = useState<AdmissionStatus | "">("");
  const [classes, setClasses] = useState<AdmissionWindowRow[]>([]);
  const [cls, setCls] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ items: AdmissionListItem[]; total: number; counts: Record<AdmissionStatus, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (!session && sessions.length) setSession((sessions.find((s) => s.is_current) ?? sessions[0]).id);
  }, [sessions, session]);
  useEffect(() => {
    const st = new URLSearchParams(window.location.search).get("status");
    if (st && st in STATUS_LABEL) setStatus(st as AdmissionStatus);
  }, []);
  useEffect(() => {
    if (!session) return;
    apiFetch<AdmissionWindowRow[]>("/admissions/windows", { schoolId, query: { session_id: session } }).then(setClasses).catch(() => setClasses([]));
  }, [schoolId, session]);
  useEffect(() => { const t = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);

  const load = useCallback(async () => {
    if (!session) return;
    const mine = ++latest.current;
    setError(null);
    try {
      const r = await apiFetch<NonNullable<typeof d>>("/admissions", {
        schoolId, query: { session_id: session, status: status || undefined, class_id: cls || undefined, search: query || undefined, page, page_size: PAGE_SIZE },
      });
      if (mine === latest.current) setD(r);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [schoolId, session, status, cls, query, page]);
  useEffect(() => { void load(); }, [load]);

  const all = d ? Object.values(d.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <SelectField label="Academic session" value={session} onChange={(e) => { setSession(e.target.value); setCls(""); setPage(1); }}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
        </SelectField>
        <SelectField label="Class" value={cls} onChange={(e) => { setCls(e.target.value); setPage(1); }}>
          <option value="">All classes</option>
          {classes.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
        </SelectField>
        <div className="relative min-w-56 flex-1">
          <TextField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, application number or mobile" maxLength={100} />
          <Search className="pointer-events-none absolute right-3 top-9 size-4 text-muted" aria-hidden />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3" role="tablist" aria-label="Status">
        {(["", ...STATUS_ORDER] as const).map((s) => (
          <button key={s || "all"} role="tab" aria-selected={status === s} data-testid={`status-tab-${s || "all"}`}
            onClick={() => { setStatus(s); setPage(1); }}
            className={clsx("rounded-full border px-3 py-1 text-xs font-medium", status === s ? "border-leaf-600 bg-leaf-600 text-white" : "border-line text-muted hover:text-ink")}>
            {s ? staffLabel(s) : "All"} <span className="tabular">({d ? (s ? d.counts[s] : all) : "…"})</span>
          </button>
        ))}
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : !d ? <LoadingState /> : d.items.length === 0 ? (
        <EmptyState icon={Inbox} title="No applications" message={all === 0 ? "Open admissions for some classes under Settings and share the application link with parents." : "No applications match these filters."} />
      ) : (
        <>
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm" data-testid="application-list">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2">Application</th><th className="px-4 py-2">Child</th><th className="px-4 py-2">Class</th><th className="px-4 py-2">Parent</th><th className="px-4 py-2">Submitted</th><th className="px-4 py-2">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.items.map((x) => (
                  <tr key={x.id} className="hover:bg-paper" data-testid={`application-row-${x.application_number}`}>
                    <td className="px-4 py-2.5"><Link href={`/admissions/${x.id}`} className="font-medium text-leaf-700 hover:underline">{x.application_number}</Link></td>
                    <td className="px-4 py-2.5">{x.student_name}<span className="block text-xs text-muted">Born {formatDate(x.date_of_birth)} · {x.documents} document{x.documents === 1 ? "" : "s"}</span></td>
                    <td className="px-4 py-2.5">{x.class_name}</td>
                    <td className="px-4 py-2.5">{x.parent_name ?? "—"}<span className="block text-xs text-muted">{formatPhone(x.contact_phone)}</span></td>
                    <td className="px-4 py-2.5 whitespace-nowrap">{formatDate(x.submitted_at)}</td>
                    <td className="px-4 py-2.5"><AdmissionStatusBadge status={x.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={d.total} onChange={setPage} />
        </>
      )}
    </section>
  );
}

function WindowRow({ schoolId, sessionId, row, readOnly, onSaved }: { schoolId: string; sessionId: string; row: AdmissionWindowRow; readOnly: boolean; onSaved: (rows: AdmissionWindowRow[]) => void }) {
  const toast = useToast();
  const [v, setV] = useState({
    is_open: row.is_open, seats: row.seats?.toString() ?? "", fee: row.admission_fee ?? "", last_date: row.last_date ?? "", instructions: row.instructions ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setError(null);
    if (v.fee === "" || Number.isNaN(Number(v.fee)) || Number(v.fee) < 0) { setError("Enter the admission fee (0 if there is none)."); return; }
    if (v.seats && (!/^\d+$/.test(v.seats) || Number(v.seats) < 1)) { setError("Seats must be a whole number, or empty for no limit."); return; }
    setBusy(true);
    try {
      const rows = await apiFetch<AdmissionWindowRow[]>("/admissions/windows", {
        schoolId, method: "PUT",
        body: { academic_session_id: sessionId, class_id: row.class_id, is_open: v.is_open, seats: v.seats ? Number(v.seats) : null, admission_fee: v.fee, last_date: v.last_date || null, instructions: v.instructions || null },
      });
      toast.success(`${row.class_name}: admission settings saved.`);
      onSaved(rows);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <li className="p-4" data-testid={`window-row-${row.class_name}`}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-32">
          <p className="font-medium">{row.class_name}</p>
          <p className="text-xs text-muted">{row.applications} applied · {row.admitted} admitted</p>
        </div>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-leaf-600" checked={v.is_open} disabled={readOnly} onChange={(e) => setV({ ...v, is_open: e.target.checked })} aria-label={`Open admissions for ${row.class_name}`} />
          Open
        </label>
        <TextField label="Admission fee (₹)" className="w-36" inputMode="decimal" value={v.fee} disabled={readOnly} onChange={(e) => setV({ ...v, fee: e.target.value })} />
        <TextField label="Seats" className="w-24" inputMode="numeric" value={v.seats} disabled={readOnly} placeholder="No limit" onChange={(e) => setV({ ...v, seats: e.target.value })} />
        <TextField label="Last date" type="date" className="w-40" value={v.last_date} disabled={readOnly} onChange={(e) => setV({ ...v, last_date: e.target.value })} />
        <TextField label="Instructions for parents" className="min-w-56 flex-1" value={v.instructions} maxLength={1000} disabled={readOnly} placeholder="Optional, e.g. interview dates" onChange={(e) => setV({ ...v, instructions: e.target.value })} />
        {!readOnly && <Button variant="secondary" onClick={save} loading={busy} data-testid="save-window">Save</Button>}
      </div>
      {error && <p className="mt-2 text-sm text-danger-600" role="alert">{error}</p>}
    </li>
  );
}

function Settings({ schoolId, schoolCode }: { schoolId: string; schoolCode: string }) {
  const toast = useToast();
  const sessions = useSessions(schoolId);
  const [session, setSession] = useState("");
  const [rows, setRows] = useState<AdmissionWindowRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  useEffect(() => { setLink(`${window.location.origin}/apply/${schoolCode.toLowerCase()}`); }, [schoolCode]);
  useEffect(() => {
    const usable = sessions.filter((s) => !s.is_archived);
    if (!session && usable.length) setSession((usable.find((s) => s.is_current) ?? usable[0]).id);
  }, [sessions, session]);
  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    try { setRows(await apiFetch<AdmissionWindowRow[]>("/admissions/windows", { schoolId, query: { session_id: session } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, session]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const archived = sessions.find((s) => s.id === session)?.is_archived ?? false;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-line bg-white p-4">
        <h2 className="font-semibold">Application link</h2>
        <p className="mt-1 text-sm text-muted">Share this link with parents (website, WhatsApp, notice board). It shows only the classes that are open.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="rounded-md bg-paper px-3 py-2 text-sm" data-testid="apply-link">{link}</code>
          <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard?.writeText(link).then(() => toast.success("Link copied."), () => toast.error("Couldn't copy. Select the link and copy it.")); }}>
            <Copy className="size-4" /> Copy
          </Button>
          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-leaf-700 hover:underline">Open <ExternalLink className="size-3.5" /></a>
        </div>
      </section>
      <section className="rounded-lg border border-line bg-white">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4">
          <div>
            <h2 className="font-semibold">Classes open for admission</h2>
            <p className="text-sm text-muted">The admission fee is charged once, when an application is approved. Seats limit how many can be approved.</p>
          </div>
          <SelectField label="Academic session" value={session} onChange={(e) => setSession(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
          </SelectField>
        </div>
        {archived && <p className="border-b border-line bg-pencil-100/60 px-4 py-2 text-sm">This session is archived; its admissions can&apos;t be opened.</p>}
        {error ? <ErrorState message={error} onRetry={load} /> : !rows ? <LoadingState /> : rows.length === 0 ? (
          <EmptyState icon={Inbox} title="No classes" message="Add classes first under Classes & sections." />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => <WindowRow key={`${session}-${r.class_id}`} schoolId={schoolId} sessionId={session} row={r} readOnly={archived} onSaved={setRows} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function Admissions() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const tabs = ["Applications", ...(can("admissions:manage") ? ["Settings"] : [])];
  const [tab, setTab] = useState("Applications");
  return (
    <>
      <PageHeader title="Admissions" description="Online applications: review, verify, approve, collect the admission fee and create the student." />
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Admissions" className="mb-4 flex gap-1 border-b border-line">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === t ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>{t}</button>
          ))}
        </div>
      )}
      {tab === "Applications" ? <Applications schoolId={schoolId} /> : <Settings schoolId={schoolId} schoolCode={currentSchool!.school_code} />}
    </>
  );
}

export default function AdmissionsPage() {
  return <RequirePermission permission="admissions:view"><Admissions /></RequirePermission>;
}
