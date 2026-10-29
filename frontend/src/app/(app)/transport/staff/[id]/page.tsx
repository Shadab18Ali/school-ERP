"use client";

import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { StaffFormModal } from "@/components/transport/fleet";
import { DocumentsCard, LicenceState, Pill } from "@/components/transport/shared";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate, formatPhone } from "@/lib/format";
import type { StaffDetail } from "@/lib/transport";
import { useAuth } from "@/providers/auth-provider";

function StaffView({ id }: { id: string }) {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState<StaffDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setS(await apiFetch<StaffDetail>(`/transport/staff/${id}`, { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [id, schoolId]);
  useEffect(() => { void load(); }, [load]);
  async function remove() {
    setBusy(true);
    try { await apiFetch(`/transport/staff/${id}`, { schoolId, method: "DELETE" }); toast.success("Deleted."); router.push("/transport?tab=Drivers"); }
    catch (e) { toast.error(errorMessage(e)); setDeleting(false); } finally { setBusy(false); }
  }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!s) return <LoadingState />;
  const row = (label: string, value: React.ReactNode) => <div><dt className="text-muted">{label}</dt><dd className="font-medium">{value || "—"}</dd></div>;
  return (
    <div className="space-y-6">
      <Link href="/transport?tab=Drivers" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" /> Drivers &amp; attendants</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="staff-heading">{s.full_name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {s.role === "driver" ? "Driver" : "Attendant"} · {formatPhone(s.phone)}
            {s.status === "inactive" && <Pill tone="muted">Inactive</Pill>}
            {s.role === "driver" && <LicenceState until={s.license_valid_until} />}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)} data-testid="edit-staff"><Pencil className="size-4" /> Edit</Button>
          <ActionMenu label="More actions" actions={[{ label: "Delete…", onSelect: () => setDeleting(true), tone: "danger" }]} />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <dl className="h-fit space-y-3 rounded-lg border border-line bg-white p-5 text-sm">
          {s.role === "driver" && row("Driving licence", s.license_number)}
          {s.role === "driver" && row("Licence valid until", formatDate(s.license_valid_until))}
          {row("Other phone", s.alternate_phone ? formatPhone(s.alternate_phone) : null)}
          {row("Date of birth", s.date_of_birth ? formatDate(s.date_of_birth) : null)}
          {row("Joined", s.joined_on ? formatDate(s.joined_on) : null)}
          {row("Routes", s.route_names)}
          {s.address && row("Address", s.address)}
          {s.notes && row("Notes", s.notes)}
        </dl>
        <DocumentsCard schoolId={schoolId} kind="staff" ownerId={s.id} docs={s.documents}
          missing={(["driving_license", "police_verification"] as const).filter((t) => (t === "police_verification" || s.role === "driver") && !s.documents.some((d) => d.doc_type === t))}
          onChange={(docs) => setS((x) => (x ? { ...x, documents: docs } : x))} />
      </div>
      <StaffFormModal schoolId={schoolId} open={editing} person={s} onClose={() => setEditing(false)} onSaved={(x) => { setEditing(false); setS(x); toast.success("Saved."); }} />
      <ConfirmDialog open={deleting} title={`Delete ${s.full_name}?`}
        message="Their uploaded documents are deleted too. Someone still on a route can't be deleted; mark them inactive to keep their history."
        confirmLabel="Delete" loading={busy} onConfirm={remove} onCancel={() => setDeleting(false)} />
    </div>
  );
}

export default function TransportStaffPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RequirePermission permission="transport:manage"><StaffView id={id} /></RequirePermission>;
}
