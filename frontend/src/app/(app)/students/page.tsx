
"use client";

import { clsx } from "clsx";
import { Plus, Search, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { RecordStatusBadge } from "@/components/classes/status";
import { PageHeader } from "@/components/layout/app-shell";
import { StudentAvatar } from "@/components/students/student-avatar";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatPhone } from "@/lib/format";
import type { AcademicSession, ClassList, SchoolClass, StudentList } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

const PAGE_SIZE = 25;
const FILTERS = ["session", "class", "section", "status", "gender", "sort", "q", "page"] as const;

function StudentsView() {
  console.log("[Students] component rendered");
  const { currentSchool, can } = useAuth();
  const schoolId = currentSchool!.school_id;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const get = (k: (typeof FILTERS)[number]) => params.get(k) ?? "";

  const [sessions, setSessions] = useState<AcademicSession[] | null>(null);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [data, setData] = useState<StudentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(get("q"));

  const setParams = useCallback(
    (
      next: Partial<Record<(typeof FILTERS)[number], string>>,
      resetPage = true,
    ) => {
      const p = new URLSearchParams(params.toString());

      for (const [k, v] of Object.entries(next)) {
        if (v) {
          p.set(k, v);
        } else {
          p.delete(k);
        }
      }

      if (resetPage && !("page" in next)) {
        p.delete("page");
      }

      router.replace(`${pathname}${p.toString() ? `?${p}` : ""}`, {
        scroll: false,
      });
    },
    [params, pathname, router],
  );

  // Search is debounced in state, not written to the URL.
  // ?q= still pre-fills the search input.
  const [search, setSearch] = useState(get("q").trim());
  const [page, setPage] = useState(Number(get("page")) || 1);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);

    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [params]);

  // Load academic sessions and log the request for debugging.
  useEffect(() => {
    console.log("[Students] schoolId:", schoolId);
    console.log("[Students] requesting /sessions");

    apiFetch<AcademicSession[]>("/sessions", { schoolId })
      .then((data) => {
        console.log("[Students] sessions response:", data);
        setSessions(data);
      })
      .catch((e) => {
        console.error("[Students] sessions request failed:", e);
        setError(errorMessage(e));
      });
  }, [schoolId]);

  const session = useMemo(
    () =>
      sessions?.find((s) => s.id === get("session")) ??
      sessions?.find((s) => s.is_current) ??
      null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, params],
  );

  // Load classes for the selected academic session.
  useEffect(() => {
    if (!session) return;

    apiFetch<ClassList>("/classes", {
      schoolId,
      query: { session_id: session.id },
    })
      .then((r) => setClasses(r.items))
      .catch(() => setClasses([]));
  }, [schoolId, session]);

  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;

    if (!sessions) return;

    setLoading(true);
    setError(null);

    try {
      const result = await apiFetch<StudentList>("/students", {
        schoolId,
        query: {
          session_id: session?.id,
          class_id: get("class"),
          section_id: get("section"),
          status: get("status"),
          gender: get("gender"),
          search,
          sort: get("sort") || "class",
          page,
          page_size: PAGE_SIZE,
        },
      });

      if (mine === latest.current) {
        setData(result);
      }
    } catch (err) {
      if (mine === latest.current) {
        setError(errorMessage(err));
      }
    } finally {
      if (mine === latest.current) {
        setLoading(false);
      }
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, sessions, session, params, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return <ErrorState message={error} onRetry={load} />;
  }

  if (!sessions || !data) {
    return <LoadingState />;
  }

  const sectionsOfClass =
    classes.find((c) => c.id === get("class"))?.sections ?? [];

  const filtered =
    Boolean(search) ||
    FILTERS.some(
      (k) =>
        k !== "session" &&
        k !== "sort" &&
        k !== "page" &&
        k !== "q" &&
        Boolean(get(k)),
    );

  const canManage = can("students:manage");

  return (
    <>
      <PageHeader
        title="Students"
        description={session ? `Enrolled in ${session.name}` : undefined}
        actions={
          canManage && session && !session.is_archived ? (
            <Link href="/students/new">
              <Button>
                <Plus className="size-4" />
                Add student
              </Button>
            </Link>
          ) : undefined
        }
      />

      {!session ? (
        <div className="rounded-lg border border-line bg-white">
          <EmptyState
            icon={Users}
            title="No academic session yet"
            message="Students are admitted into an academic session. Set one up first."
          />
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-white">
          <div className="space-y-3 border-b border-line p-4">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
                aria-hidden
              />

              <label htmlFor="student-search" className="sr-only">
                Search students
              </label>

              <input
                id="student-search"
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                maxLength={100}
                placeholder="Search by name, parent, mobile, admission number or Student ID"
                className="h-10 w-full rounded-md border border-line pl-9 pr-3 text-sm focus:border-leaf-600 focus:outline-none focus:ring-2 focus:ring-leaf-600/20"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <SelectField
                label="Session"
                hideLabel
                value={session.id}
                onChange={(e) =>
                  setParams({
                    session: e.target.value,
                    class: "",
                    section: "",
                  })
                }
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.is_current
                      ? " (current)"
                      : s.is_archived
                        ? " (archived)"
                        : ""}
                  </option>
                ))}
              </SelectField>

              <SelectField
                label="Class"
                hideLabel
                value={get("class")}
                onChange={(e) =>
                  setParams({ class: e.target.value, section: "" })
                }
              >
                <option value="">All classes</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectField>

              <SelectField
                label="Section"
                hideLabel
                value={get("section")}
                disabled={!get("class")}
                onChange={(e) => setParams({ section: e.target.value })}
              >
                <option value="">All sections</option>
                {sectionsOfClass.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectField>

              <SelectField
                label="Status"
                hideLabel
                value={get("status")}
                onChange={(e) => setParams({ status: e.target.value })}
              >
                <option value="">Any status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </SelectField>

              <SelectField
                label="Gender"
                hideLabel
                value={get("gender")}
                onChange={(e) => setParams({ gender: e.target.value })}
              >
                <option value="">Any gender</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="other">Other</option>
              </SelectField>

              <SelectField
                label="Sort by"
                hideLabel
                value={get("sort") || "class"}
                onChange={(e) =>
                  setParams({
                    sort: e.target.value === "class" ? "" : e.target.value,
                  })
                }
              >
                <option value="class">Sort: class</option>
                <option value="name">Sort: name</option>
                <option value="admission_number">Sort: admission no.</option>
                <option value="newest">Sort: newest</option>
              </SelectField>
            </div>
          </div>

          {data.items.length === 0 ? (
            filtered ? (
              <EmptyState
                icon={Search}
                title="No students match"
                message="Try a different search or fewer filters."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearchInput("");
                      router.replace(`${pathname}?session=${session.id}`);
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={Users}
                title={`No students in ${session.name} yet`}
                message={
                  canManage
                    ? "Add your first student. You'll need a class with sections in this session."
                    : "Students will appear here once they're admitted."
                }
                action={
                  canManage && !session.is_archived ? (
                    <Link href="/students/new">
                      <Button>
                        <Plus className="size-4" />
                        Add student
                      </Button>
                    </Link>
                  ) : undefined
                }
              />
            )
          ) : (
            <div className={clsx(loading && "opacity-60")} aria-busy={loading}>
              <p
                className="tabular border-b border-line px-4 py-2 text-sm text-muted"
                data-testid="students-total"
              >
                {data.total.toLocaleString("en-IN")}{" "}
                {data.total === 1 ? "student" : "students"}
              </p>

              <div className="relative overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-paper text-left text-xs font-medium text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2.5">
                        Student
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        Class
                      </th>
                      <th
                        scope="col"
                        className="hidden px-4 py-2.5 md:table-cell"
                      >
                        Admission no.
                      </th>
                      <th
                        scope="col"
                        className="hidden px-4 py-2.5 lg:table-cell"
                      >
                        Parent
                      </th>
                      <th
                        scope="col"
                        className="hidden px-4 py-2.5 sm:table-cell"
                      >
                        Mobile
                      </th>
                      <th scope="col" className="px-4 py-2.5">
                        Status
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-line">
                    {data.items.map((s) => (
                      <tr
                        key={s.id}
                        className="hover:bg-paper/60"
                        data-testid={`student-row-${s.enrollment.admission_number}`}
                      >
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/students/${s.id}`}
                            className="flex items-center gap-3 hover:underline"
                          >
                            <StudentAvatar
                              name={s.full_name}
                              url={s.photo_url}
                            />
                            <span>
                              <span className="block font-medium">
                                {s.full_name}
                              </span>
                              <span className="block text-xs text-muted">
                                {s.student_code}
                              </span>
                            </span>
                          </Link>
                        </td>

                        <td className="whitespace-nowrap px-4 py-2.5">
                          {s.enrollment.class_name} –{" "}
                          {s.enrollment.section_name}
                        </td>

                        <td className="tabular hidden px-4 py-2.5 md:table-cell">
                          {s.enrollment.admission_number}
                        </td>

                        <td className="hidden px-4 py-2.5 text-muted lg:table-cell">
                          {s.father_name || s.mother_name}
                        </td>

                        <td className="tabular hidden whitespace-nowrap px-4 py-2.5 text-muted sm:table-cell">
                          {formatPhone(s.mobile)}
                        </td>

                        <td className="px-4 py-2.5">
                          <RecordStatusBadge active={s.status === "active"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Pagination
                page={data.page}
                pageSize={data.page_size}
                total={data.total}
                onChange={setPage}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function StudentsPage() {
  return (
    <RequirePermission permission="students:view">
      <Suspense fallback={<LoadingState />}>
        <StudentsView />
      </Suspense>
    </RequirePermission>
  );
}

