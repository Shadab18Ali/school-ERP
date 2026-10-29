"use client";

import { clsx } from "clsx";
import { Layers, ListPlus, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SelectField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession, ClassList, RecordStatus, SchoolClass } from "@/lib/types";
import { ClassFormModal, StandardClassesModal } from "./class-modals";
import { AssignSectionsModal } from "./section-modals";
import { plural, RecordStatusBadge } from "./status";

type Pending = { kind: "deactivate" | "delete"; cls: SchoolClass } | null;

export function ClassesTab({ schoolId, session, canManage, onOpenSections }: {
  schoolId: string; session: AcademicSession | null; canManage: boolean; onOpenSections: (classId: string) => void;
}) {
  const toast = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | RecordStatus>("");
  const [data, setData] = useState<ClassList | null>(null);
  const [all, setAll] = useState<SchoolClass[]>([]); // unfiltered live classes, for modals
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SchoolClass | null>(null);
  const [standardOpen, setStandardOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = { session_id: session?.id, search, status };
      const [filtered, live] = await Promise.all([
        apiFetch<ClassList>("/classes", { schoolId, query }),
        apiFetch<ClassList>("/classes", { schoolId, query: { session_id: session?.id } }),
      ]);
      setData(filtered);
      setAll(live.items);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [schoolId, session?.id, search, status]);

  useEffect(() => { void load(); }, [load]);

  const writable = canManage && session !== null && !session.is_archived;

  async function act(cls: SchoolClass, action: "activate" | "deactivate" | "delete" | "restore") {
    setBusy(true);
    try {
      if (action === "delete") await apiFetch(`/classes/${cls.id}`, { method: "DELETE", schoolId });
      else if (action === "restore") await apiFetch(`/classes/${cls.id}/restore`, { method: "POST", schoolId });
      else await apiFetch(`/classes/${cls.id}`, { method: "PATCH", schoolId, body: { is_active: action === "activate" } });
      toast.success(`${cls.name} ${action === "delete" ? "deleted" : action === "restore" ? "restored" : `${action}d`}.`);
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

  const liveCount = all.length;
  const sectionTotal = all.reduce((n, c) => n + c.sections.length, 0);

  return (
    <>
      <div className="rounded-lg border border-line bg-white">
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="class-search" className="sr-only">Search classes</label>
            <input id="class-search" type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search classes"
              className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </div>
          <SelectField label="Class status" hideLabel className="lg:w-40" value={status} onChange={(e) => setStatus(e.target.value as "" | RecordStatus)}>
            <option value="">All classes</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="deleted">Deleted</option>
          </SelectField>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setStandardOpen(true)}><ListPlus className="size-4" /> Standard classes</Button>
              {writable && <Button variant="secondary" onClick={() => setAssignFor([])} disabled={liveCount === 0}><Layers className="size-4" /> Assign sections</Button>}
              <Button onClick={() => { setEditing(null); setFormOpen(true); }}><Plus className="size-4" /> Add class</Button>
            </div>
          )}
        </div>

        <p className="tabular border-b border-line px-4 py-2.5 text-sm text-muted" data-testid="classes-summary">
          {plural(liveCount, "class", "classes")} · {plural(sectionTotal, "section")} · {plural(data.total_students, "student")}
          {session ? ` in ${session.name}` : ""}
        </p>

        {data.items.length === 0 ? (
          search || status ? (
            <EmptyState icon={Search} title="No classes match" message="Try a different search or status."
              action={<Button variant="secondary" onClick={() => { setSearchInput(""); setStatus(""); }}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={Layers} title="No classes yet"
              message={canManage ? "Start with the standard list (Nursery to Class 12) or add your own." : "An administrator hasn't added classes yet."}
              action={canManage ? <Button onClick={() => setStandardOpen(true)}><ListPlus className="size-4" /> Add standard classes</Button> : undefined} />
          )
        ) : (
          <div className={clsx("overflow-x-auto", loading && "opacity-60")} aria-busy={loading}>
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-xs font-medium text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5">Class</th>
                  <th scope="col" className="px-4 py-2.5">Sections{session ? ` (${session.name})` : ""}</th>
                  <th scope="col" className="hidden px-4 py-2.5 text-right sm:table-cell">Students</th>
                  <th scope="col" className="hidden px-4 py-2.5 text-right md:table-cell">Capacity</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  {canManage && <th scope="col" className="w-12 px-4 py-2.5"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((c) => (
                  <tr key={c.id} data-testid={`class-row-${c.name}`} className={clsx(c.is_deleted && "bg-paper/60 text-muted")}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{c.name}</p>
                      <p className="text-xs text-muted">Order {c.display_order}</p>
                    </td>
                    <td className="px-4 py-3">
                      {c.sections.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <button onClick={() => onOpenSections(c.id)} className="flex flex-wrap gap-1" aria-label={`View sections of ${c.name}`}>
                          {c.sections.map((s) => (
                            <span key={s.id} title={s.is_active ? undefined : "Inactive"}
                              className={clsx("min-w-7 rounded border px-1.5 py-0.5 text-center text-xs font-semibold",
                                s.is_active ? "border-leaf-600/30 bg-leaf-50 text-leaf-700" : "border-line bg-paper text-muted line-through")}>
                              {s.name}
                            </span>
                          ))}
                        </button>
                      )}
                    </td>
                    <td className="tabular hidden px-4 py-3 text-right sm:table-cell" data-testid="student-count">{c.student_count}</td>
                    <td className="tabular hidden px-4 py-3 text-right text-muted md:table-cell">{c.capacity_total ?? "—"}</td>
                    <td className="px-4 py-3"><RecordStatusBadge active={c.is_active} deleted={c.is_deleted} /></td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <ActionMenu label={`Actions for ${c.name}`} actions={c.is_deleted ? [
                          { label: "Restore", onSelect: () => act(c, "restore") },
                        ] : [
                          { label: "Edit", onSelect: () => { setEditing(c); setFormOpen(true); } },
                          { label: "Assign sections", onSelect: () => setAssignFor([c.id]), hidden: !writable || !c.is_active },
                          { label: "Activate", onSelect: () => act(c, "activate"), hidden: c.is_active },
                          { label: "Deactivate", onSelect: () => setPending({ kind: "deactivate", cls: c }), hidden: !c.is_active },
                          { label: "Delete…", onSelect: () => setPending({ kind: "delete", cls: c }), tone: "danger" },
                        ]} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ClassFormModal open={formOpen} schoolId={schoolId} cls={editing} onClose={() => setFormOpen(false)}
        onSaved={async (c) => { setFormOpen(false); toast.success(editing ? `${c.name} saved.` : `${c.name} added.`); await load(); }} />
      <StandardClassesModal open={standardOpen} schoolId={schoolId} existing={all} onClose={() => setStandardOpen(false)}
        onDone={async (r) => { setStandardOpen(false); toast.success(`${plural(r.created, "class", "classes")} added.`); await load(); }} />
      {session && (
        <AssignSectionsModal open={assignFor !== null} schoolId={schoolId} session={session} classes={all} preselect={assignFor ?? []}
          onClose={() => setAssignFor(null)}
          onDone={async (r) => {
            setAssignFor(null);
            toast.success(`${plural(r.created, "section")} added${r.skipped.length ? `, ${r.skipped.length} already existed` : ""}.`);
            await load();
          }} />
      )}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === "delete" ? `Delete ${pending.cls.name}?` : `Deactivate ${pending?.cls.name}?`}
        message={pending?.kind === "delete"
          ? "The class is hidden from lists but kept for history, and you can restore it later. A class that still has sections can't be deleted. Delete its sections first."
          : "Inactive classes stay visible with their sections and students, but no new sections can be added until it's activated again."}
        confirmLabel={pending?.kind === "delete" ? "Delete class" : "Deactivate"}
        tone={pending?.kind === "delete" ? "danger" : "primary"}
        loading={busy}
        onConfirm={() => pending && act(pending.cls, pending.kind)}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
