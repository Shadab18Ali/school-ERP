"use client";

import { BookOpen, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import type { HomeworkKind, SettableSection, StaffHomework } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";
import { HomeworkFormModal } from "./homework-form-modal";
import { DueText, KindBadge } from "./shared";

interface Page { items: StaffHomework[]; total: number; page: number; page_size: number }

/** Homework list for staff. With `sectionId` it is one class's list (teacher class page); otherwise it has filters. */
export function StaffHomeworkList({ schoolId, sectionId, kind: fixedKind }: { schoolId: string; sectionId?: string; kind?: HomeworkKind }) {
  const { can, currentSchool } = useAuth();
  const router = useRouter();
  const manage = can("homework:manage");
  const isTeacher = currentSchool?.roles.includes("teacher") ?? false;
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<string>(fixedKind ?? "");
  const [state, setState] = useState("open");
  const [section, setSection] = useState(sectionId ?? "");
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [sections, setSections] = useState<SettableSection[]>([]);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const latest = useRef(0);
  const filters = !sectionId;

  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (filters && manage) apiFetch<SettableSection[]>("/homework/sections", { schoolId }).then(setSections).catch(() => setSections([]));
  }, [filters, manage, schoolId]);

  const load = useCallback(async () => {
    const mine_ = ++latest.current;
    setError(null);
    try {
      const r = await apiFetch<Page>("/homework", { schoolId, query: {
        section_id: section || undefined, kind: kind || undefined, state: sectionId ? "all" : state, mine: mine ? "true" : undefined,
        search: search || undefined, page, page_size: 20 } });
      if (mine_ === latest.current) setData(r);
    } catch (e) { if (mine_ === latest.current) setError(errorMessage(e)); }
  }, [schoolId, section, kind, state, mine, search, page, sectionId]);
  useEffect(() => { void load(); }, [load]);

  const label = fixedKind === "assignment" ? "assignment" : fixedKind === "homework" ? "homework" : "homework or assignment";
  return (
    <section className="rounded-lg border border-line bg-white" data-testid="homework-list-card">
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        {filters ? (
          <>
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <label htmlFor="homework-search" className="sr-only">Search homework</label>
              <input id="homework-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title or subject"
                className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
            </div>
            {sections.length > 0 && (
              <SelectField label="Class" value={section} onChange={(e) => { setSection(e.target.value); setPage(1); }}>
                <option value="">All classes</option>
                {sections.map((s) => <option key={s.section_id} value={s.section_id}>{s.class_name} – {s.section_name}</option>)}
              </SelectField>
            )}
            <SelectField label="Type" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
              <option value="">All types</option><option value="homework">Homework</option><option value="assignment">Assignments</option>
            </SelectField>
            <SelectField label="Status" value={state} onChange={(e) => { setState(e.target.value); setPage(1); }}>
              <option value="open">Open</option><option value="closed">Closed</option><option value="all">All</option>
            </SelectField>
            {isTeacher && (
              <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }}
                className="size-4 accent-leaf-600" /> Set by me</label>
            )}
          </>
        ) : <p className="flex-1 text-sm text-muted">{data ? `${data.total} ${fixedKind === "assignment" ? "assignment" : "homework"}${data.total === 1 || fixedKind !== "assignment" ? "" : "s"}` : ""}</p>}
        {manage && <Button onClick={() => setAdding(true)} data-testid="new-homework"><Plus className="size-4" /> New {fixedKind === "assignment" ? "assignment" : fixedKind ? "homework" : ""}</Button>}
      </div>
      {error ? <ErrorState message={error} onRetry={load} />
        : !data ? <LoadingState />
        : data.items.length === 0 ? <EmptyState icon={BookOpen} title={`No ${label} yet`} message={manage ? `Use New to set ${label === "assignment" ? "an assignment" : "homework"} for a class.` : "Nothing has been set yet."} />
        : (
          <>
            <ul className="divide-y divide-line" data-testid="homework-list">
              {data.items.map((h) => (
                <li key={h.id} data-testid={`homework-row-${h.title}`}>
                  <Link href={`/homework/${h.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-paper">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{h.title}</span><KindBadge kind={h.kind} />
                      </div>
                      <p className="text-xs text-muted">{h.class_name} – {h.section_name}{h.subject_name ? ` · ${h.subject_name}` : ""}{h.teacher_name ? ` · ${h.teacher_name}` : ""}</p>
                    </div>
                    <DueText dueAt={h.due_at} closed={h.is_closed} allowLate={h.allow_late} />
                    <span className="tabular w-36 text-right text-sm" data-testid="homework-counts">
                      {h.submitted}/{h.students} submitted{h.submitted ? <span className="block text-xs text-muted">{h.reviewed} reviewed</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {data.total > data.page_size && <div className="border-t border-line p-3"><Pagination page={data.page} pageSize={data.page_size} total={data.total} onChange={setPage} /></div>}
          </>
        )}
      <HomeworkFormModal schoolId={schoolId} open={adding} onClose={() => setAdding(false)} defaults={{ sectionId, kind: fixedKind }}
        onSaved={(h) => { setAdding(false); router.push(`/homework/${h.id}`); }} />
    </section>
  );
}
