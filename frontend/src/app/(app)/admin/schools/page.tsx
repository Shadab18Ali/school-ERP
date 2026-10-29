"use client";

import { Building2, Plus, Search, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { SubStatus } from "@/lib/platform";
import type { Paginated, School, SchoolStatus } from "@/lib/types";
import { StateBadge } from "@/components/platform/shared";
import { InviteAdminModal } from "./invite-admin-modal";
import { SchoolFormModal } from "./school-form-modal";

const PAGE_SIZE = 20;

function SchoolsView() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | SchoolStatus>("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<School> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(params.get("new") === "1");
  const [editing, setEditing] = useState<School | null>(null);
  const [inviting, setInviting] = useState<School | null>(null);
  const [toggling, setToggling] = useState<School | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch<Paginated<School>>("/admin/schools", { query: { search, status, page, page_size: PAGE_SIZE }, signal }));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(errorMessage(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [search, status, page]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
    if (params.get("new")) router.replace("/admin/schools");
  }

  async function confirmToggle() {
    if (!toggling) return;
    const next: SchoolStatus = toggling.status === "active" ? "suspended" : "active";
    setToggleBusy(true);
    try {
      await apiFetch<School>(`/admin/schools/${toggling.id}`, { method: "PATCH", body: { status: next } });
      toast.success(next === "suspended" ? `${toggling.name} deactivated.` : `${toggling.name} activated.`);
      setToggling(null);
      void load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setToggleBusy(false);
    }
  }

  const filtered = Boolean(search || status);

  return (
    <>
      <PageHeader title="Schools" description="Create schools, invite their administrators and control access."
        actions={<Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="size-4" /> Add school</Button>} />

      <div className="rounded-lg border border-line bg-white">
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="school-search" className="sr-only">Search schools</label>
            <input id="school-search" type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name, code or city" maxLength={100}
              className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </div>
          <SelectField label="Status" hideLabel className="sm:w-44" value={status} onChange={(e) => { setStatus(e.target.value as "" | SchoolStatus); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Inactive</option>
          </SelectField>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={() => load()} />
        ) : loading && !data ? (
          <LoadingState />
        ) : data && data.items.length === 0 ? (
          filtered ? (
            <EmptyState icon={Search} title="No schools match" message="Try a different search term or status."
              action={<Button variant="secondary" onClick={() => { setSearchInput(""); setStatus(""); }}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={Building2} title="No schools yet" message="Add a school to give it its own workspace, then invite its administrator."
              action={<Button onClick={() => setFormOpen(true)}><Plus className="size-4" /> Add school</Button>} />
          )
        ) : data ? (
          <div className={loading ? "opacity-60 transition-opacity" : ""} aria-busy={loading}>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper text-left text-xs font-medium text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">School</th>
                    <th scope="col" className="hidden px-4 py-2.5 md:table-cell">Location</th>
                    <th scope="col" className="hidden px-4 py-2.5 sm:table-cell">Admins</th>
                    <th scope="col" className="px-4 py-2.5">Status</th>
                    <th scope="col" className="hidden px-4 py-2.5 md:table-cell">Plan</th>
                    <th scope="col" className="hidden px-4 py-2.5 text-right lg:table-cell">Students</th>
                    <th scope="col" className="hidden px-4 py-2.5 xl:table-cell">Last active</th>
                    <th scope="col" className="w-12 px-4 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((s) => (
                    <tr key={s.id} className="hover:bg-paper/60">
                      <td className="px-4 py-3">
                        <Link href={`/admin/schools/${s.id}`} className="flex items-center gap-3 hover:underline">
                          <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-paper text-xs font-semibold text-muted">
                            {s.logo_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={s.logo_url} alt="" className="size-full object-contain p-0.5" />
                            ) : (
                              s.code.slice(0, 2)
                            )}
                          </span>
                          <span>
                            <span className="block font-medium">{s.name}</span>
                            <span className="block text-xs text-muted">{s.code}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="hidden px-4 py-3 text-muted md:table-cell">{[s.city, s.state].filter(Boolean).join(", ") || "—"}</td>
                      <td className="tabular hidden px-4 py-3 sm:table-cell">
                        {s.admin_count > 0 ? s.admin_count : (
                          <button onClick={() => setInviting(s)} className="inline-flex items-center gap-1 text-leaf-700 hover:underline">
                            <UserPlus className="size-3.5" /> Invite
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                      <td className="hidden px-4 py-3 md:table-cell" data-testid="school-plan">
                        <span className="flex flex-col items-start gap-1">
                          {s.plan_name && <span className="text-sm">{s.plan_name}</span>}
                          <StateBadge state={s.subscription_state as SubStatus | null} />
                        </span>
                      </td>
                      <td className="tabular hidden px-4 py-3 text-right lg:table-cell" data-testid="school-students">
                        {s.students_active?.toLocaleString("en-IN") ?? "—"}
                        {s.max_students != null && <span className="block text-xs text-muted">of {s.max_students.toLocaleString("en-IN")}</span>}
                      </td>
                      <td className="tabular hidden px-4 py-3 text-muted xl:table-cell">
                        {s.last_activity_at ? formatDate(s.last_activity_at) : "Never"}
                      </td>
                      <td className="px-4 py-3">
                        <ActionMenu
                          label={`Actions for ${s.name}`}
                          actions={[
                            { label: "Open", onSelect: () => router.push(`/admin/schools/${s.id}`) },
                            { label: "Edit details", onSelect: () => { setEditing(s); setFormOpen(true); } },
                            { label: "Invite admin", onSelect: () => setInviting(s) },
                            s.status === "active"
                              ? { label: "Deactivate", onSelect: () => setToggling(s), tone: "danger" }
                              : { label: "Activate", onSelect: () => setToggling(s) },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.page_size} total={data.total} onChange={setPage} />
          </div>
        ) : null}
      </div>

      <SchoolFormModal
        open={formOpen}
        school={editing}
        onClose={closeForm}
        onSaved={(saved, created) => {
          closeForm();
          if (created) router.push(`/admin/schools/${saved.id}`);
          else void load();
        }}
      />
      <InviteAdminModal school={inviting} onClose={() => setInviting(null)} onInvited={() => { setInviting(null); void load(); }} />
      <ConfirmDialog
        open={toggling !== null}
        title={toggling?.status === "active" ? "Deactivate this school?" : "Activate this school?"}
        message={toggling?.status === "active"
          ? `Staff, parents and students of ${toggling?.name} will immediately lose access. Their data is kept, and access returns when you activate it again.`
          : `Members of ${toggling?.name} will be able to sign in and use it again.`}
        confirmLabel={toggling?.status === "active" ? "Deactivate" : "Activate"}
        tone={toggling?.status === "active" ? "danger" : "primary"}
        loading={toggleBusy}
        onConfirm={confirmToggle}
        onCancel={() => setToggling(null)}
      />
    </>
  );
}

export default function SchoolsPage() {
  return (
    <RequirePermission permission="platform:schools.manage">
      <Suspense fallback={<LoadingState />}><SchoolsView /></Suspense>
    </RequirePermission>
  );
}
