"use client";

import { GraduationCap, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { RecordStatusBadge } from "@/components/classes/status";
import { PageHeader } from "@/components/layout/app-shell";
import { StudentAvatar } from "@/components/students/student-avatar";
import { TeacherFormModal } from "@/components/teachers/teacher-form-modal";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Paginated, TeacherSummary } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function Teachers() {
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const toast = useToast();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<TeacherSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setError(null);
    try {
      const r = await apiFetch<Paginated<TeacherSummary>>("/teachers", { schoolId, query: { search, status, page } });
      if (mine === latest.current) setData(r);
    } catch (e) { if (mine === latest.current) setError(errorMessage(e)); }
  }, [schoolId, search, status, page]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  return (
    <>
      <PageHeader title="Teachers" description="Staff records, logins and the classes each teacher is assigned to."
        actions={can("teachers:manage") ? <Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add teacher</Button> : undefined} />
      <div className="rounded-lg border border-line bg-white">
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[1fr_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <label htmlFor="teacher-search" className="sr-only">Search teachers</label>
            <input id="teacher-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Employee ID, email, subject or phone"
              className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20" />
          </div>
          <SelectField label="Status" hideLabel value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="active">Active</option><option value="inactive">Inactive</option><option value="">Any status</option>
          </SelectField>
        </div>
        {data.items.length === 0 ? (
          <EmptyState icon={GraduationCap} title={search || status !== "active" ? "No teachers match" : "No teachers yet"}
            message={search ? "Try another search." : "Add your teaching staff, then assign them their classes."} />
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper text-left text-xs font-medium text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Teacher</th>
                    <th scope="col" className="hidden px-4 py-2.5 md:table-cell">Subject</th>
                    <th scope="col" className="hidden px-4 py-2.5 lg:table-cell">Phone</th>
                    <th scope="col" className="hidden px-4 py-2.5 lg:table-cell">Joined</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Classes</th>
                    <th scope="col" className="px-4 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((t) => (
                    <tr key={t.id} className="hover:bg-paper/60" data-testid={`teacher-row-${t.employee_id}`}>
                      <td className="px-4 py-2.5">
                        <Link href={`/teachers/${t.id}`} className="flex items-center gap-3">
                          <StudentAvatar name={t.full_name} url={t.photo_url} />
                          <span className="min-w-0"><span className="block truncate font-medium hover:underline">{t.full_name}</span>
                            <span className="text-xs text-muted">{t.employee_id} · {t.email}</span></span>
                        </Link>
                      </td>
                      <td className="hidden px-4 py-2.5 md:table-cell">{t.subject ?? t.designation ?? "—"}<span className="block text-xs text-muted">{t.staff_type === "non_teaching" ? "Non-teaching" : t.qualification}</span></td>
                      <td className="hidden px-4 py-2.5 lg:table-cell">{t.phone}</td>
                      <td className="hidden whitespace-nowrap px-4 py-2.5 lg:table-cell">{formatDate(t.joining_date)}</td>
                      <td className="tabular px-4 py-2.5 text-right" data-testid="teacher-sections">{t.assigned_sections}</td>
                      <td className="px-4 py-2.5"><RecordStatusBadge active={t.status === "active"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={data.page} pageSize={data.page_size} total={data.total} onChange={setPage} />
          </>
        )}
      </div>
      <TeacherFormModal open={adding} schoolId={schoolId} teacher={null} onClose={() => setAdding(false)}
        onSaved={(t) => { setAdding(false); toast.success(`${t.full_name} added as ${t.employee_id}.`); router.push(`/teachers/${t.id}`); }} />
    </>
  );
}

export default function TeachersPage() {
  return <RequirePermission permission="teachers:view"><Teachers /></RequirePermission>;
}
