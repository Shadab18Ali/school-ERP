"use client";

import { clsx } from "clsx";
import { Copy, Layers, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession, ClassList, Paginated, RecordStatus, SchoolClass, Section } from "@/lib/types";
import { AssignSectionsModal, CopySectionsModal, SectionFormModal } from "./section-modals";
import { plural, RecordStatusBadge } from "./status";

const PAGE_SIZE = 25;

export function SectionsTab({ schoolId, session, sessions, canManage, classFilter, onClassFilter }: {
  schoolId: string; session: AcademicSession; sessions: AcademicSession[]; canManage: boolean;
  classFilter: string; onClassFilter: (id: string) => void;
}) {
  const toast = useToast();
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | RecordStatus>("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<Section> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Section | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [pending, setPending] = useState<{ kind: "deactivate" | "delete"; s: Section } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => setPage(1), [classFilter, status, session.id]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, cls] = await Promise.all([
        apiFetch<Paginated<Section>>("/sections", {
          schoolId, query: { session_id: session.id, class_id: classFilter, search, status, page, page_size: PAGE_SIZE },
        }),
        apiFetch<ClassList>("/classes", { schoolId, query: { session_id: session.id } }),
      ]);
      setData(list);
      setClasses(cls.items);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [schoolId, session.id, classFilter, search, status, page]);

  useEffect(() => { void load(); }, [load]);

  const writable = canManage && !session.is_archived;

  async function act(s: Section, action: "activate" | "deactivate" | "delete" | "restore") {
    setBusy(true);
    try {
      if (action === "delete") await apiFetch(`/sections/${s.id}`, { method: "DELETE", schoolId });
      else if (action === "restore") await apiFetch(`/sections/${s.id}/restore`, { method: "POST", schoolId });
      else await apiFetch(`/sections/${s.id}`, { method: "PATCH", schoolId, body: { is_active: action === "activate" } });
      toast.success(`${s.class_name} ${s.name} ${action === "delete" ? "deleted" : action === "restore" ? "restored" : `${action}d`}.`);
      setPending(null);
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const filtered = Boolean(search || status || classFilter);

  return (
    <>
      <div className="rounded-lg border border-line bg-white">
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="section-search" className="sr-only">Search sections</label>
            <input id="section-search" type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search section, room or class"
              className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </div>
          <SelectField label="Filter by class" hideLabel className="lg:w-44" value={classFilter} onChange={(e) => onClassFilter(e.target.value)}>
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectField>
          <SelectField label="Section status" hideLabel className="lg:w-36" value={status} onChange={(e) => setStatus(e.target.value as "" | RecordStatus)}>
            <option value="">All sections</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="deleted">Deleted</option>
          </SelectField>
          {writable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setCopyOpen(true)}><Copy className="size-4" /> Copy from session</Button>
              <Button variant="secondary" onClick={() => setAssignOpen(true)}><Layers className="size-4" /> Assign</Button>
              <Button onClick={() => { setEditing(null); setFormOpen(true); }} disabled={classes.length === 0}><Plus className="size-4" /> Add section</Button>
            </div>
          )}
        </div>

        {data.items.length === 0 ? (
          filtered ? (
            <EmptyState icon={Search} title="No sections match" message="Try a different search, class or status."
              action={<Button variant="secondary" onClick={() => { setSearchInput(""); setStatus(""); onClassFilter(""); }}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={Layers} title={`No sections in ${session.name}`}
              message={writable ? "Assign sections to your classes, or copy last year's sections into this session." : "Sections for this session haven't been set up."}
              action={writable ? <Button onClick={() => setCopyOpen(true)}><Copy className="size-4" /> Copy from another session</Button> : undefined} />
          )
        ) : (
          <div className={clsx(loading && "opacity-60")} aria-busy={loading}>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper text-left text-xs font-medium text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Class</th>
                    <th scope="col" className="px-4 py-2.5">Section</th>
                    <th scope="col" className="hidden px-4 py-2.5 sm:table-cell">Room</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Students</th>
                    <th scope="col" className="px-4 py-2.5">Status</th>
                    {writable && <th scope="col" className="w-12 px-4 py-2.5"><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((s) => (
                    <tr key={s.id} data-testid={`section-row-${s.class_name}-${s.name}`} className={clsx(s.is_deleted && "bg-paper/60 text-muted")}>
                      <td className="px-4 py-3">{s.class_name}{!s.class_is_active && <span className="ml-1.5 text-xs text-muted">(inactive)</span>}</td>
                      <td className="px-4 py-3 font-medium text-ink">{s.name}</td>
                      <td className="hidden px-4 py-3 text-muted sm:table-cell">{s.room ?? "—"}</td>
                      <td className="tabular px-4 py-3 text-right" data-testid="section-students">
                        {s.student_count}{s.capacity ? <span className="text-muted"> / {s.capacity}</span> : null}
                      </td>
                      <td className="px-4 py-3"><RecordStatusBadge active={s.is_active} deleted={s.is_deleted} /></td>
                      {writable && (
                        <td className="px-4 py-3">
                          <ActionMenu label={`Actions for ${s.class_name} ${s.name}`} actions={s.is_deleted ? [
                            { label: "Restore", onSelect: () => act(s, "restore") },
                          ] : [
                            { label: "Edit", onSelect: () => { setEditing(s); setFormOpen(true); } },
                            { label: "Activate", onSelect: () => act(s, "activate"), hidden: s.is_active },
                            { label: "Deactivate", onSelect: () => setPending({ kind: "deactivate", s }), hidden: !s.is_active },
                            { label: "Delete…", onSelect: () => setPending({ kind: "delete", s }), tone: "danger" },
                          ]} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.page_size} total={data.total} onChange={setPage} />
          </div>
        )}
      </div>

      <SectionFormModal open={formOpen} schoolId={schoolId} session={session} classes={classes} section={editing}
        onClose={() => setFormOpen(false)}
        onSaved={async (s) => { setFormOpen(false); toast.success(`${s.class_name} ${s.name} ${editing ? "saved" : "added"}.`); await load(); }} />
      <AssignSectionsModal open={assignOpen} schoolId={schoolId} session={session} classes={classes} preselect={classFilter ? [classFilter] : []}
        onClose={() => setAssignOpen(false)}
        onDone={async (r) => {
          setAssignOpen(false);
          toast.success(`${plural(r.created, "section")} added${r.skipped.length ? `, ${r.skipped.length} already existed` : ""}.`);
          await load();
        }} />
      <CopySectionsModal open={copyOpen} schoolId={schoolId} target={session} sessions={sessions} onClose={() => setCopyOpen(false)}
        onDone={async (r) => {
          setCopyOpen(false);
          toast.success(`${plural(r.created, "section")} copied${r.skipped.length ? `, ${r.skipped.length} already existed` : ""}.`);
          await load();
        }} />
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "delete" ? `Delete ${pending.s.class_name} ${pending.s.name}?` : `Deactivate ${pending?.s.class_name} ${pending?.s.name}?`}
        message={pending?.kind === "delete"
          ? "The section is hidden from lists but kept for history, and you can restore it later. Sections with students can't be deleted."
          : "The section stays in the list but won't be offered for new admissions until it's activated again."}
        confirmLabel={pending?.kind === "delete" ? "Delete section" : "Deactivate"}
        tone={pending?.kind === "delete" ? "danger" : "primary"}
        loading={busy}
        onConfirm={() => pending && act(pending.s, pending.kind)}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
