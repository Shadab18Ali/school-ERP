"use client";

import { ArrowDown, ArrowLeft, ArrowUp, Download, Pencil, Plus, Printer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { RouteFormModal, StopFormModal } from "@/components/transport/routes";
import { AssignModal, LicenceState, Pill, Section } from "@/components/transport/shared";
import { AssignmentRow } from "@/components/transport/students";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, apiFetchBlob, errorMessage, saveBlob } from "@/lib/api";
import { formatDate, formatPhone, todayISO } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { clock, FREQUENCY_LABEL, showReg, TRIP_LABEL, VEHICLE_TYPE_LABEL, type AssignmentList, type RouteDetail, type RouteSheet, type Stop } from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";

function PrintSheet({ s }: { s: RouteSheet }) {
  return (
    <div className="hidden text-sm print:block" data-testid="route-sheet">
      <h1 className="text-xl font-semibold">{s.name}{s.code ? ` (${s.code})` : ""} — riders on {formatDate(todayISO())}</h1>
      <p className="mb-4">
        Vehicle {s.registration_number ? showReg(s.registration_number) : "—"} · Driver {s.driver_name ?? "—"}{s.driver_phone ? ` (${formatPhone(s.driver_phone)})` : ""}
        {s.attendant_name ? ` · Attendant ${s.attendant_name}${s.attendant_phone ? ` (${formatPhone(s.attendant_phone)})` : ""}` : ""}
      </p>
      {s.stop_list.map((st) => (
        <div key={st.id} className="mb-3 break-inside-avoid">
          <p className="font-semibold">{st.sequence}. {st.name} · pickup {clock(st.pickup_time)} · drop {clock(st.drop_time)}</p>
          {st.students.length === 0 ? <p className="text-muted">No students.</p> : (
            <table className="w-full border-collapse">
              <tbody>
                {st.students.map((a) => (
                  <tr key={a.id} className="border-b border-line">
                    <td className="w-6 py-1">☐</td>
                    <td className="py-1">{a.student_name}</td>
                    <td className="py-1">{a.class_section ?? ""}</td>
                    <td className="py-1">{TRIP_LABEL[a.trip]}</td>
                    <td className="py-1">{formatPhone(a.mobile)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

function RouteView({ id }: { id: string }) {
  const { can, currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const toast = useToast();
  const manage = can("transport:manage");
  const [r, setR] = useState<RouteDetail | null>(null);
  const [riders, setRiders] = useState<AssignmentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [stopModal, setStopModal] = useState<Stop | "new" | null>(null);
  const [assignAt, setAssignAt] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Stop | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<RouteSheet | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [route, list] = await Promise.all([
        apiFetch<RouteDetail>(`/transport/routes/${id}`, { schoolId }),
        apiFetch<AssignmentList>("/transport/students", { schoolId, query: { route_id: id, state: "current", page_size: 200 } }),
      ]);
      setR(route); setRiders(list);
    } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);

  async function move(index: number, by: -1 | 1) {
    if (!r) return;
    const ids = r.stop_list.map((s) => s.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    try { setR(await apiFetch<RouteDetail>(`/transport/routes/${id}/stops/order`, { schoolId, method: "PUT", body: { stop_ids: ids } })); }
    catch (e) { toast.error(errorMessage(e)); }
  }
  async function removeStop() {
    if (!removing) return;
    setBusy(true);
    try { setR(await apiFetch<RouteDetail>(`/transport/stops/${removing.id}`, { schoolId, method: "DELETE" })); toast.success(`${removing.name} removed.`); setRemoving(null); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }
  async function removeRoute() {
    setBusy(true);
    try { await apiFetch(`/transport/routes/${id}`, { schoolId, method: "DELETE" }); toast.success("Route deleted."); router.push("/transport?tab=Routes"); }
    catch (e) { toast.error(errorMessage(e)); setDeleting(false); } finally { setBusy(false); }
  }
  async function print() {
    try {
      setSheet(await apiFetch<RouteSheet>(`/transport/routes/${id}/sheet`, { schoolId }));
      window.setTimeout(() => window.print(), 50);
    } catch (e) { toast.error(errorMessage(e)); }
  }
  async function csv() {
    try { const { blob } = await apiFetchBlob("/transport/students", { schoolId, query: { route_id: id, state: "current", format: "csv" } }); saveBlob(blob, `route-${r?.code ?? r?.name ?? "riders"}.csv`.replace(/\s+/g, "-").toLowerCase()); }
    catch (e) { toast.error(errorMessage(e)); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!r || !riders) return <LoadingState />;
  const full = r.seating_capacity !== null && r.riders >= r.seating_capacity;

  return (
    <>
      <div className="space-y-6 print:hidden">
        <Link href="/transport?tab=Routes" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Routes</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="route-heading">{r.name}{r.code && <span className="ml-2 align-middle text-base font-normal text-muted">{r.code}</span>}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              {r.status === "inactive" && <Pill tone="muted">Not running</Pill>}
              <span data-testid="route-seats" className={full ? "font-medium text-danger-600" : ""}>{r.riders}{r.seating_capacity !== null ? ` of ${r.seating_capacity} seats taken` : " students"}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={print} data-testid="print-sheet"><Printer className="size-4" /> Print route sheet</Button>
            <Button variant="secondary" size="sm" onClick={csv}><Download className="size-4" /> CSV</Button>
            {manage && <Button variant="secondary" size="sm" onClick={() => setEditing(true)} data-testid="edit-route"><Pencil className="size-4" /> Edit</Button>}
            {manage && <ActionMenu label="More route actions" actions={[{ label: "Delete route…", onSelect: () => setDeleting(true), tone: "danger" }]} />}
          </div>
        </div>

        <dl className="grid gap-4 rounded-lg border border-line bg-white p-5 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Vehicle</dt>
            <dd className="font-medium">{r.vehicle_id ? <Link href={`/transport/vehicles/${r.vehicle_id}`} className="hover:underline">{showReg(r.registration_number)}</Link> : "Not assigned"}</dd>
            {r.vehicle_type && <dd className="text-muted">{VEHICLE_TYPE_LABEL[r.vehicle_type]} · {r.seating_capacity} seats {r.vehicle_status === "maintenance" && <Pill tone="warn">In maintenance</Pill>}</dd>}
          </div>
          <div>
            <dt className="text-muted">Driver</dt>
            <dd className="font-medium">{r.driver_id ? (manage ? <Link href={`/transport/staff/${r.driver_id}`} className="hover:underline">{r.driver_name}</Link> : r.driver_name) : "Not assigned"}</dd>
            {r.driver_phone && <dd className="text-muted">{formatPhone(r.driver_phone)}</dd>}
            {manage && r.driver_id && <dd className="mt-1"><LicenceState until={r.driver_license_valid_until} /></dd>}
          </div>
          <div>
            <dt className="text-muted">Attendant</dt>
            <dd className="font-medium">{r.attendant_id ? (manage ? <Link href={`/transport/staff/${r.attendant_id}`} className="hover:underline">{r.attendant_name}</Link> : r.attendant_name) : "None"}</dd>
            {r.attendant_phone && <dd className="text-muted">{formatPhone(r.attendant_phone)}</dd>}
          </div>
          {r.notes && <div className="sm:col-span-3"><dt className="text-muted">Notes</dt><dd>{r.notes}</dd></div>}
        </dl>

        <Section title={`Stops (${r.stop_list.length})`} testId="stops"
          action={manage ? <Button size="sm" onClick={() => setStopModal("new")} data-testid="add-stop"><Plus className="size-4" /> Add stop</Button> : undefined}>
          {r.stop_list.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No stops yet.{manage ? " Add them in the order the vehicle reaches them in the morning." : ""}</p> : (
            <ol className="divide-y divide-line" data-testid="stop-list">
              {r.stop_list.map((s, i) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm" data-testid={`stop-${s.name}`}>
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-paper text-xs font-medium">{s.sequence}</span>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-xs text-muted">{s.landmark ? `${s.landmark} · ` : ""}pickup {clock(s.pickup_time)} · drop {clock(s.drop_time)}</p>
                  </div>
                  <span className="text-xs text-muted">{s.fare_zone} · {formatINR(s.fare)} {FREQUENCY_LABEL[s.fare_frequency]}</span>
                  <span className="tabular w-20 text-right text-muted" data-testid="stop-riders">{s.riders} student{s.riders === 1 ? "" : "s"}</span>
                  {manage && (
                    <span className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.name} up`}><ArrowUp className="size-4" /></Button>
                      <Button variant="ghost" size="sm" disabled={i === r.stop_list.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.name} down`}><ArrowDown className="size-4" /></Button>
                      <ActionMenu label={`Actions for ${s.name}`} actions={[
                        ...(r.status === "active" ? [{ label: "Add a student here…", onSelect: () => setAssignAt(s.id) }] : []),
                        { label: "Edit stop…", onSelect: () => setStopModal(s) },
                        { label: "Remove stop…", onSelect: () => setRemoving(s), tone: "danger" as const },
                      ]} />
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title={`Students riding today (${riders.total})`} testId="route-riders-list"
          action={manage && r.status === "active" && r.stop_list.length > 0 ? <Button size="sm" onClick={() => setAssignAt("")} data-testid="route-assign"><Plus className="size-4" /> Add student</Button> : undefined}>
          {riders.items.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No student rides this route today.</p> : (
            <ul className="divide-y divide-line">
              {riders.items.map((a) => <AssignmentRow key={a.id} schoolId={schoolId} a={a} showRoute={false} onChange={() => void load()} />)}
            </ul>
          )}
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            Students starting later or who have stopped are on the <Link href={`/transport?tab=Students&route=${id}`} className="underline">Students</Link> tab.
          </p>
        </Section>
      </div>
      {sheet && <PrintSheet s={sheet} />}

      <RouteFormModal schoolId={schoolId} open={editing} route={r} onClose={() => setEditing(false)} onSaved={(x) => { setEditing(false); setR(x); toast.success("Route saved."); }} />
      <StopFormModal schoolId={schoolId} open={stopModal !== null} routeId={id} stop={stopModal === "new" ? null : stopModal} onClose={() => setStopModal(null)}
        onSaved={(x) => { const added = stopModal === "new"; setStopModal(null); setR(x); toast.success(added ? "Stop added." : "Stop saved."); void load(); }} />
      <AssignModal schoolId={schoolId} open={assignAt !== null} routeId={id} stopId={assignAt || undefined} onClose={() => setAssignAt(null)}
        onDone={(a) => { setAssignAt(null); toast.success(`${a.student_name} assigned to ${a.stop_name}.`); void load(); }} />
      <ConfirmDialog open={removing !== null} title={`Remove ${removing?.name ?? ""}?`}
        message="A stop that students have used can't be removed; move them to another stop first, or edit the stop instead." confirmLabel="Remove stop"
        loading={busy} onConfirm={removeStop} onCancel={() => setRemoving(null)} />
      <ConfirmDialog open={deleting} title={`Delete ${r.name}?`} message="Only a route that no student has ever used can be deleted. Otherwise mark it as not running."
        confirmLabel="Delete route" loading={busy} onConfirm={removeRoute} onCancel={() => setDeleting(false)} />
    </>
  );
}

export default function TransportRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="transport:view"><RouteView id={id} /></RequirePermission>;
}
