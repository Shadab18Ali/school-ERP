"use client";

import { clsx } from "clsx";
import { Download, Plus, Search, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { todayISO } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { clock, FREQUENCY_LABEL, TRIP_LABEL, type Assignment, type AssignmentList, type AssignState, type Route } from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";
import { AssignModal, AssignmentPeriod, EditAssignmentModal, EndAssignmentModal, Pill } from "./shared";

const PAGE_SIZE = 50;
const STATES: [AssignState, string][] = [["current", "Riding now"], ["future", "Starting later"], ["ended", "Ended"], ["all", "All"]];

/** One student on a route: who, where, when, what it costs, and (for admins) Move / Edit / Stop. */
export function AssignmentRow({ schoolId, a, onChange, showStudent = true, showRoute = true }: {
  schoolId: string; a: Assignment; onChange: () => void; showStudent?: boolean; showRoute?: boolean;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [modal, setModal] = useState<"move" | "edit" | "end" | null>(null);
  const ended = a.end_date !== null && a.end_date < todayISO();
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1.5 px-4 py-3 text-sm" data-testid="assignment-row">
      <div className="min-w-0 flex-1 basis-60">
        {showStudent && (
          <p className="font-medium">
            <Link href={`/students/${a.student_id}?tab=Transport`} className="hover:underline">{a.student_name}</Link>
            <span className="ml-2 text-xs font-normal text-muted">{a.class_section ?? "—"} · {a.student_code}</span>
          </p>
        )}
        <p className={clsx(!showStudent && "font-medium")}>
          {showRoute && <><Link href={`/transport/routes/${a.route_id}`} className="hover:underline">{a.route_name}</Link> · </>}
          {a.stop_sequence}. {a.stop_name}
          <span className="text-muted"> · {TRIP_LABEL[a.trip]}{a.trip !== "drop" && a.pickup_time ? ` · pickup ${clock(a.pickup_time)}` : ""}{a.trip !== "pickup" && a.drop_time ? ` · drop ${clock(a.drop_time)}` : ""}</span>
        </p>
        <p className="text-xs text-muted"><AssignmentPeriod a={a} />{a.notes ? ` · ${a.notes}` : ""}</p>
      </div>
      <div className="text-right">
        {a.charge_fee ? <p className="tabular">{formatINR(a.fare)} <span className="text-xs text-muted">{FREQUENCY_LABEL[a.fare_frequency]}</span></p> : <Pill tone="muted">No fee</Pill>}
        <p className="text-xs text-muted">{a.fare_zone}</p>
      </div>
      {can("transport:manage") && !ended && (
        <ActionMenu label={`Actions for ${a.student_name}`} actions={[
          { label: "Move to another stop or route…", onSelect: () => setModal("move") },
          { label: "Edit stop, trip or fee…", onSelect: () => setModal("edit") },
          { label: a.start_date > todayISO() ? "Remove…" : "Stop transport…", onSelect: () => setModal("end"), tone: "danger" },
        ]} />
      )}
      <AssignModal schoolId={schoolId} open={modal === "move"} student={{ id: a.student_id, name: a.student_name }} onClose={() => setModal(null)}
        onDone={(x) => { setModal(null); toast.success(`${x.student_name} moved to ${x.route_name} · ${x.stop_name}.`); onChange(); }} />
      <EditAssignmentModal schoolId={schoolId} assignment={modal === "edit" ? a : null} onClose={() => setModal(null)} onDone={() => { setModal(null); toast.success("Saved."); onChange(); }} />
      <EndAssignmentModal schoolId={schoolId} assignment={modal === "end" ? a : null} onClose={() => setModal(null)}
        onDone={(removed) => { setModal(null); toast.success(removed ? "Removed." : "Transport stopped."); onChange(); }} />
    </li>
  );
}

export function StudentsTab({ schoolId, initialRoute = "" }: { schoolId: string; initialRoute?: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<AssignState>("current");
  const [routes, setRoutes] = useState<Route[]>([]);
  const [route, setRoute] = useState(initialRoute);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AssignmentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => { apiFetch<Route[]>("/transport/routes", { schoolId }).then(setRoutes).catch(() => setRoutes([])); }, [schoolId]);
  useEffect(() => { const t = window.setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);
  const query = { state, route_id: route || undefined, q: term || undefined };
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiFetch<AssignmentList>("/transport/students", { schoolId, query: { state, route_id: route || undefined, q: term || undefined, page, page_size: PAGE_SIZE } })); }
    catch (e) { setError(errorMessage(e)); }
  }, [schoolId, state, route, term, page]);
  useEffect(() => { void load(); }, [load]);

  async function csv() {
    setDownloading(true);
    try { const { blob } = await apiFetchBlob("/transport/students", { schoolId, query: { ...query, format: "csv" } }); saveBlob(blob, `transport-students-${state}.csv`); }
    catch (e) { toast.error(errorMessage(e)); } finally { setDownloading(false); }
  }

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Which students">
          {STATES.map(([s, label]) => (
            <button key={s} role="tab" aria-selected={state === s} onClick={() => { setState(s); setPage(1); }} data-testid={`riders-${s}`}
              className={clsx("rounded-full border px-3 py-1 text-sm", state === s ? "border-leaf-600 bg-leaf-50 font-medium text-leaf-700" : "border-line text-muted hover:text-ink")}>{label}</button>
          ))}
        </div>
        <SelectField label="Route" hideLabel className="w-full sm:w-48" value={route} onChange={(e) => { setRoute(e.target.value); setPage(1); }} data-testid="riders-route">
          <option value="">All routes</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </SelectField>
        <div className="relative w-full sm:ml-auto sm:w-60">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="rider-search" className="sr-only">Search students on transport</label>
          <input id="rider-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Student, student ID or stop" data-testid="riders-search"
            className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
        </div>
        <Button variant="secondary" size="sm" onClick={csv} loading={downloading} aria-label="Download CSV"><Download className="size-4" /> CSV</Button>
        {can("transport:manage") && <Button size="sm" onClick={() => setAssigning(true)} data-testid="assign-student"><Plus className="size-4" /> Assign student</Button>}
      </div>
      {error ? <div className="p-4"><ErrorState message={error} onRetry={load} /></div>
        : !data ? <LoadingState />
        : data.items.length === 0 ? (
          <div className="p-4"><EmptyState icon={UserRound} title="No students here" message={term || route ? "No student matches the filters." : state === "current" ? "No student is using school transport yet. Add routes and stops, then assign students." : "Nothing in this list."} /></div>
        ) : (
          <>
            <ul className="divide-y divide-line" data-testid="riders-list">
              {data.items.map((a) => <AssignmentRow key={a.id} schoolId={schoolId} a={a} onChange={() => void load()} />)}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onChange={setPage} />
          </>
        )}
      <AssignModal schoolId={schoolId} open={assigning} routeId={route || undefined} onClose={() => setAssigning(false)}
        onDone={(a) => { setAssigning(false); toast.success(`${a.student_name} assigned to ${a.route_name} · ${a.stop_name}.`); void load(); }} />
    </section>
  );
}
