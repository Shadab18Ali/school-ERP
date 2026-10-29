"use client";

import { clsx } from "clsx";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useState, type ReactNode } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { AdminsPanel, UsagePanel } from "@/components/platform/school-panels";
import { SubscriptionPanel } from "@/components/platform/subscription-panel";
import { SessionsManager } from "@/components/sessions/sessions-manager";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState, LoadingState, StatusBadge } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { School } from "@/lib/types";
import { InviteAdminModal } from "../invite-admin-modal";
import { SchoolFormModal } from "../school-form-modal";
import { LogoUploader } from "./logo-uploader";

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Detail({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{value || <span className="text-muted">—</span>}</dd>
    </div>
  );
}

const TABS = [["overview", "Overview"], ["subscription", "Subscription"], ["usage", "Usage"], ["admins", "Administrators"]] as const;
type Tab = (typeof TABS)[number][0];

function SchoolDetail({ id }: { id: string }) {
  const toast = useToast();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (TABS.find(([k]) => k === params.get("tab"))?.[0] ?? "overview"));
  const [school, setSchool] = useState<School | null>(null);
  const [adminsKey, setAdminsKey] = useState(0);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSchool(await apiFetch<School>(`/admin/schools/${id}`));
    } catch (err) {
      setError({ message: errorMessage(err), notFound: err instanceof ApiError && (err.status === 404 || err.status === 422) });
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error.notFound ? "This school doesn't exist or was removed." : error.message} onRetry={error.notFound ? undefined : load} />;
  if (!school) return <LoadingState />;
  function choose(t: Tab) {
    setTab(t);
    try { window.history.replaceState(null, "", t === "overview" ? `/admin/schools/${id}` : `/admin/schools/${id}?tab=${t}`); } catch { /* ignore */ }
  }

  const active = school.status === "active";
  async function toggle() {
    if (!school) return;
    setToggleBusy(true);
    try {
      setSchool(await apiFetch<School>(`/admin/schools/${school.id}`, { method: "PATCH", body: { status: active ? "suspended" : "active" } }));
      toast.success(active ? `${school.name} deactivated.` : `${school.name} activated.`);
      setToggling(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setToggleBusy(false);
    }
  }

  const address = [school.address, school.city, school.state, school.postal_code, school.country].filter(Boolean).join(", ");

  return (
    <>
      <Link href="/admin/schools" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> All schools
      </Link>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <LogoUploader school={school} onChange={setSchool} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{school.name}</h1>
            <StatusBadge status={school.status} />
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {school.code}{school.affiliation_board ? ` · ${school.affiliation_board}` : ""}{school.city ? ` · ${school.city}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit details</Button>
          <Button variant={active ? "secondary" : "primary"} onClick={() => setToggling(true)} data-testid="toggle-status">
            {active ? "Deactivate" : "Activate"}
          </Button>
        </div>
      </div>

      {!active && (
        <p className="mb-6 rounded-md bg-pencil-100 px-4 py-3 text-sm" role="status">
          This school is inactive. Its staff, parents and students can&apos;t sign in to it. All data is kept.
        </p>
      )}

      <div role="tablist" aria-label="School" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => choose(k)} data-testid={`school-tab-${k}`}
            className={clsx("-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium", tab === k ? "border-leaf-600" : "border-transparent text-muted hover:text-ink")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <>
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card title="Contact">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Detail label="Email" value={school.email} />
              <Detail label="Phone" value={school.phone} />
              <Detail className="sm:col-span-2" label="Address" value={address} />
            </dl>
          </Card>
          <Card title="Registration">
            <dl className="grid gap-4 sm:grid-cols-2" data-testid="registration-details">
              <Detail label="Board" value={school.affiliation_board} />
              <Detail label="Affiliation number" value={school.affiliation_number} />
              <Detail label="Registration number" value={school.registration_number} />
              <Detail label="UDISE+ code" value={school.udise_code} />
              <Detail label="Established" value={school.established_year} />
              <Detail label="Added to platform" value={formatDate(school.created_at)} />
            </dl>
          </Card>
        </div>
        <div className="mt-6">
          <h2 className="mb-3 font-semibold">Academic sessions</h2>
          <SessionsManager schoolId={school.id} canManage />
        </div>
      </>}
      {tab === "subscription" && <SubscriptionPanel school={school} />}
      {tab === "usage" && <UsagePanel school={school} />}
      {tab === "admins" && <AdminsPanel school={school} onInvite={() => setInviting(true)} reloadKey={adminsKey} />}

      <SchoolFormModal open={editing} school={school} onClose={() => setEditing(false)} onSaved={(s) => { setSchool(s); setEditing(false); }} />
      <InviteAdminModal school={inviting ? school : null} onClose={() => setInviting(false)} onInvited={() => { setInviting(false); setAdminsKey((k) => k + 1); }} />
      <ConfirmDialog
        open={toggling}
        title={active ? "Deactivate this school?" : "Activate this school?"}
        message={active
          ? `Staff, parents and students of ${school.name} will immediately lose access. Their data is kept, and access returns when you activate it again.`
          : `Members of ${school.name} will be able to sign in and use it again.`}
        confirmLabel={active ? "Deactivate" : "Activate"}
        tone={active ? "danger" : "primary"}
        loading={toggleBusy}
        onConfirm={toggle}
        onCancel={() => setToggling(false)}
      />
    </>
  );
}

export default function SchoolDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <RequirePermission permission="platform:schools.manage">
      <Suspense fallback={<LoadingState />}><SchoolDetail id={id} /></Suspense>
    </RequirePermission>
  );
}
