"use client";

import { clsx } from "clsx";
import { Download, Inbox, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EnquiryStatusBadge, FollowUpDate, sessionLabel, useClassesAndSessions } from "@/components/enquiries/shared";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { type Enquiry, type EnquiryStatus, ENQUIRY_SOURCES, ENQUIRY_STATUS_LABEL, ENQUIRY_STATUSES, SOURCE_LABEL } from "@/lib/enquiries";
import { formatDate, formatPhone } from "@/lib/format";

const PAGE_SIZE = 25;
export type ListFilters = { session: string; status: EnquiryStatus | ""; followUp: "" | "overdue" | "today" | "week" | "none" };
const FOLLOW_UPS: [ListFilters["followUp"], string][] = [["", "Any"], ["overdue", "Overdue"], ["today", "Due today"], ["week", "Next 7 days"], ["none", "Open, no date"]];

export function EnquiryList({ schoolId, initial }: { schoolId: string; initial: ListFilters }) {
  const toast = useToast();
  const { classes, sessions } = useClassesAndSessions(schoolId);
  const [session, setSession] = useState(initial.session);
  const [status, setStatus] = useState<EnquiryStatus | "">(initial.status);
  const [followUp, setFollowUp] = useState<ListFilters["followUp"]>(initial.followUp);
  const [source, setSource] = useState("");
  const [cls, setCls] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "follow_up">(initial.followUp ? "follow_up" : "newest");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ items: Enquiry[]; total: number; counts: Record<EnquiryStatus, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!session && sessions.length) setSession((sessions.find((s) => s.is_current) ?? sessions[0]).id);
  }, [sessions, session]);
  useEffect(() => { const t = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [search]);
  const filters = { session_id: session || undefined, status: status || undefined, follow_up: followUp || undefined, source: source || undefined, class_id: cls || undefined, search: query || undefined };

  const load = useCallback(async () => {
    if (!session) return;
    const mine = ++latest.current;
    setError(null);
    try {
      const r = await apiFetch<NonNullable<typeof d>>("/enquiries", { schoolId, query: { ...filters, sort, page, page_size: PAGE_SIZE } });
      if (mine === latest.current) setD(r);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, session, status, followUp, source, cls, query, sort, page]);
  useEffect(() => { void load(); }, [load]);

  async function exportCsv() {
    setExporting(true);
    try { const { blob, filename } = await apiFetchBlob("/enquiries/export.csv", { schoolId, query: filters }); saveBlob(blob, filename ?? "enquiries.csv"); }
    catch (e) { toast.error(errorMessage(e)); } finally { setExporting(false); }
  }
  const reset = (fn: () => void) => { fn(); setPage(1); };
  const all = d ? Object.values(d.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <SelectField label="Session" value={session} onChange={(e) => reset(() => setSession(e.target.value))}>
          {sessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
        </SelectField>
        <SelectField label="Follow-up" value={followUp} onChange={(e) => reset(() => { setFollowUp(e.target.value as ListFilters["followUp"]); if (e.target.value) setSort("follow_up"); })} data-testid="filter-follow-up">
          {FOLLOW_UPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </SelectField>
        <SelectField label="Source" value={source} onChange={(e) => reset(() => setSource(e.target.value))}>
          <option value="">All sources</option>
          {ENQUIRY_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </SelectField>
        <SelectField label="Class" value={cls} onChange={(e) => reset(() => setCls(e.target.value))}>
          <option value="">All classes</option>
          {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <div className="relative min-w-52 flex-1">
          <TextField label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, enquiry number or mobile" maxLength={100} />
          <Search className="pointer-events-none absolute right-3 top-9 size-4 text-muted" aria-hidden />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Status">
          {(["", ...ENQUIRY_STATUSES] as const).map((s) => (
            <button key={s || "all"} role="tab" aria-selected={status === s} data-testid={`enquiry-tab-${s || "all"}`} onClick={() => reset(() => setStatus(s))}
              className={clsx("rounded-full border px-3 py-1 text-xs font-medium", status === s ? "border-leaf-600 bg-leaf-600 text-white" : "border-line text-muted hover:text-ink")}>
              {s ? ENQUIRY_STATUS_LABEL[s] : "All"} <span className="tabular">({d ? (s ? d.counts[s] : all) : "…"})</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <SelectField label="Sort" hideLabel value={sort} onChange={(e) => reset(() => setSort(e.target.value as typeof sort))}>
            <option value="newest">Newest first</option><option value="follow_up">By follow-up date</option>
          </SelectField>
          <Button variant="secondary" size="sm" onClick={exportCsv} loading={exporting} data-testid="export-enquiries"><Download className="size-4" /> CSV</Button>
        </div>
      </div>
      {error ? <ErrorState message={error} onRetry={load} /> : !d ? <LoadingState /> : d.items.length === 0 ? (
        <EmptyState icon={Inbox} title="No enquiries" message={all === 0 && !query && !followUp && !source && !cls ? "Add an enquiry whenever a parent calls, visits or writes." : "No enquiries match these filters."} />
      ) : (
        <>
          <ul className="divide-y divide-line sm:hidden" data-testid="enquiry-cards">
            {d.items.map((e) => (
              <li key={e.id}>
                <Link href={`/enquiries/${e.id}`} className="block px-4 py-3 text-sm hover:bg-paper">
                  <span className="flex items-start justify-between gap-2">
                    <span className="font-medium text-leaf-700">{e.student_name}</span><EnquiryStatusBadge status={e.status} />
                  </span>
                  <span className="block text-muted">{e.parent_name} · {formatPhone(e.phone)}</span>
                  <span className="mt-0.5 flex justify-between gap-2 text-xs">
                    <span className="text-muted">{e.class_name ?? "Class not decided"} · {SOURCE_LABEL[e.source]}</span>
                    <FollowUpDate date={e.follow_up_date} status={e.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm" data-testid="enquiry-list">
              <thead className="bg-paper text-left text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2">Student</th><th className="px-4 py-2">Parent</th><th className="px-4 py-2">Class</th><th className="px-4 py-2">Source</th><th className="px-4 py-2">Follow-up</th><th className="px-4 py-2">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.items.map((e) => (
                  <tr key={e.id} className="hover:bg-paper" data-testid={`enquiry-row-${e.enquiry_number}`}>
                    <td className="px-4 py-2.5">
                      <Link href={`/enquiries/${e.id}`} className="font-medium text-leaf-700 hover:underline">{e.student_name}</Link>
                      <span className="block text-xs text-muted">{e.enquiry_number} · {formatDate(e.enquiry_date)}</span>
                    </td>
                    <td className="px-4 py-2.5">{e.parent_name}<span className="block text-xs text-muted">{formatPhone(e.phone)}</span></td>
                    <td className="px-4 py-2.5">{e.class_name ?? <span className="text-muted">Not decided</span>}</td>
                    <td className="px-4 py-2.5">{SOURCE_LABEL[e.source]}{e.source_detail && <span className="block text-xs text-muted">{e.source_detail}</span>}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><FollowUpDate date={e.follow_up_date} status={e.status} /></td>
                    <td className="px-4 py-2.5"><EnquiryStatusBadge status={e.status} />{e.application_number && <span className="block text-xs text-muted">{e.application_number}</span>}</td>
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
