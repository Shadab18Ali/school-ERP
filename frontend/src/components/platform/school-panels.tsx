"use client";

import { UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { UsageView } from "@/components/platform/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Usage } from "@/lib/platform";
import type { School, SchoolAdmin } from "@/lib/types";

// ---------------------------------------------------------------- usage
export function UsagePanel({ school }: { school: School }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setUsage(await apiFetch<Usage>(`/admin/schools/${school.id}/usage`)); } catch (e) { setError(errorMessage(e)); }
  }, [school.id]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!usage) return <LoadingState />;
  return <UsageView usage={usage} />;
}

// ---------------------------------------------------------------- administrators
export function AdminsPanel({ school, onInvite, reloadKey }: { school: School; onInvite: () => void; reloadKey: number }) {
  const toast = useToast();
  const [admins, setAdmins] = useState<SchoolAdmin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SchoolAdmin | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setAdmins(await apiFetch<SchoolAdmin[]>(`/admin/schools/${school.id}/admins`)); } catch (e) { setError(errorMessage(e)); }
  }, [school.id]);
  useEffect(() => { void load(); }, [load, reloadKey]);

  async function toggle(a: SchoolAdmin) {
    setBusy(true);
    try {
      const next = a.status === "active" ? "disabled" : "active";
      const r = await apiFetch<{ active_admins: number }>(`/admin/schools/${school.id}/admins/${a.user_id}`, { method: "PATCH", body: { status: next } });
      toast.success(next === "disabled"
        ? `${a.full_name || a.email} can no longer manage ${school.name}.${r.active_admins === 0 ? " The school has no active administrator now." : ""}`
        : `${a.full_name || a.email} can manage ${school.name} again.`);
      setConfirm(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!admins) return <LoadingState />;
  const activeCount = admins.filter((a) => a.status === "active").length;
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div>
          <h2 className="font-semibold">Administrators</h2>
          <p className="text-xs text-muted">They run the school: staff, classes, fees and settings. Only the platform adds or removes them.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={onInvite}><UserPlus className="size-4" /> Invite</Button>
      </div>
      <div className="p-5">
        {admins.length === 0 ? <p className="text-sm text-muted">No administrator yet. Invite one so the school can start using the system.</p> : (
          <ul className="divide-y divide-line" data-testid="admin-list">
            {admins.map((a) => (
              <li key={a.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0" data-testid="admin-row">
                <div>
                  <p className="text-sm font-medium">{a.full_name || a.email}</p>
                  <p className="text-xs text-muted">{a.email} · {a.status === "active" ? `added ${formatDate(a.added_at)}` : "turned off"}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setConfirm(a)} data-testid="toggle-admin">
                  {a.status === "active" ? "Turn off" : "Turn on"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog open={confirm !== null}
        title={confirm?.status === "active" ? "Turn off this administrator?" : "Turn this administrator back on?"}
        message={confirm?.status === "active"
          ? `${confirm.full_name || confirm.email} will immediately lose access to ${school.name}.${activeCount === 1 ? " They are its only active administrator." : ""}`
          : `${confirm?.full_name || confirm?.email} will be able to manage ${school.name} again.`}
        confirmLabel={confirm?.status === "active" ? "Turn off" : "Turn on"} tone={confirm?.status === "active" ? "danger" : "primary"}
        loading={busy} onConfirm={() => confirm && toggle(confirm)} onCancel={() => setConfirm(null)} />
    </section>
  );
}
