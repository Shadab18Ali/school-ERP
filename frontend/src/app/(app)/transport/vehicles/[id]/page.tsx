"use client";

import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { VehicleFormModal } from "@/components/transport/fleet";
import { DocumentsCard, Pill, Section } from "@/components/transport/shared";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { showReg, VEHICLE_STATUS_LABEL, VEHICLE_TYPE_LABEL, type VehicleDetail } from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";

function VehicleView({ id }: { id: string }) {
  const { can, currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const toast = useToast();
  const manage = can("transport:manage");
  const [v, setV] = useState<VehicleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setV(await apiFetch<VehicleDetail>(`/transport/vehicles/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  async function remove() {
    setBusy(true);
    try { await apiFetch(`/transport/vehicles/${id}`, { schoolId, method: "DELETE" }); toast.success("Vehicle deleted."); router.push("/transport?tab=Vehicles"); }
    catch (e) { toast.error(errorMessage(e)); setDeleting(false); } finally { setBusy(false); }
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!v) return <LoadingState />;
  return (
    <div className="space-y-6">
      <Link href="/transport?tab=Vehicles" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Vehicles</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="vehicle-heading">{showReg(v.registration_number)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {VEHICLE_TYPE_LABEL[v.vehicle_type]}{v.make_model ? ` · ${v.make_model}` : ""} · {v.seating_capacity} student seats
            {v.status !== "active" && <Pill tone={v.status === "retired" ? "muted" : "warn"}>{VEHICLE_STATUS_LABEL[v.status]}</Pill>}
          </p>
        </div>
        {manage && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} data-testid="edit-vehicle"><Pencil className="size-4" /> Edit</Button>
            <ActionMenu label="More vehicle actions" actions={[{ label: "Delete vehicle…", onSelect: () => setDeleting(true), tone: "danger" }]} />
          </div>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-6">
          <dl className="space-y-3 rounded-lg border border-line bg-white p-5 text-sm">
            <div><dt className="text-muted">Owned by</dt><dd className="font-medium">{v.ownership === "school" ? "The school" : `Contractor: ${v.contractor_name}`}</dd></div>
            <div><dt className="text-muted">Year of manufacture</dt><dd className="font-medium">{v.manufacture_year ?? "—"}</dd></div>
            {v.notes && <div><dt className="text-muted">Notes</dt><dd>{v.notes}</dd></div>}
          </dl>
          <Section title="Routes">
            {v.route_list.length === 0 ? <p className="px-5 py-4 text-sm text-muted">Not on any route.</p> : (
              <ul className="divide-y divide-line text-sm">
                {v.route_list.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                    <Link href={`/transport/routes/${r.id}`} className="font-medium hover:underline">{r.name}{r.code ? ` (${r.code})` : ""}</Link>
                    <span className="tabular text-muted">{r.status === "active" ? `${r.riders}/${v.seating_capacity}` : "not running"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        {manage ? <DocumentsCard schoolId={schoolId} kind="vehicles" ownerId={v.id} docs={v.documents} missing={v.required_missing} onChange={() => void load()} />
          : <p className="rounded-lg border border-line bg-white p-5 text-sm text-muted">The vehicle&apos;s papers are visible to school administrators.</p>}
      </div>
      <VehicleFormModal schoolId={schoolId} open={editing} vehicle={v} onClose={() => setEditing(false)} onSaved={(x) => { setEditing(false); setV(x); toast.success("Vehicle saved."); }} />
      <ConfirmDialog open={deleting} title={`Delete ${showReg(v.registration_number)}?`}
        message="Its uploaded papers are deleted too. A vehicle still on a route can't be deleted; mark it retired instead to keep its history."
        confirmLabel="Delete vehicle" loading={busy} onConfirm={remove} onCancel={() => setDeleting(false)} />
    </div>
  );
}

export default function TransportVehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="transport:view"><VehicleView id={id} /></RequirePermission>;
}
