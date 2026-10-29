"use client";

import { clsx } from "clsx";
import { Archive, CalendarRange } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { ClassesTab } from "@/components/classes/classes-tab";
import { SectionsTab } from "@/components/classes/sections-tab";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import type { AcademicSession } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function ClassesView() {
  const { currentSchool, can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get("tab") === "sections" ? "sections" : "classes";
  const classFilter = params.get("class") ?? "";
  const [sessions, setSessions] = useState<AcademicSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schoolId = currentSchool!.school_id;
  const canManage = can("classes:manage");

  const setParams = useCallback((next: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  const load = useCallback(async () => {
    setError(null);
    try { setSessions(await apiFetch<AcademicSession[]>("/sessions", { schoolId })); } catch (err) { setError(errorMessage(err)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!sessions) return <LoadingState />;

  const current = sessions.find((s) => s.is_current) ?? null;
  const session = sessions.find((s) => s.id === params.get("session")) ?? current ?? sessions[0] ?? null;

  return (
    <>
      <PageHeader
        title="Classes & sections"
        description={canManage ? "Set up your classes once; sections are set up for each academic session." : "Classes and sections of this school."}
        actions={session ? (
          <SelectField label="Academic session" hideLabel className="w-48" value={session.id} onChange={(e) => setParams({ session: e.target.value })}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.is_current ? " (current)" : s.is_archived ? " (archived)" : ""}</option>
            ))}
          </SelectField>
        ) : undefined}
      />

      {!session ? (
        <div className="rounded-lg border border-line bg-white">
          <EmptyState icon={CalendarRange} title="Set up an academic session first"
            message="Sections belong to an academic session, e.g. 2026-27."
            action={can("sessions:manage") ? <Link href="/sessions"><Button>Go to academic sessions</Button></Link> : undefined} />
        </div>
      ) : (
        <>
          {session.is_archived && (
            <p className="mb-4 flex items-center gap-2 rounded-md bg-pencil-100 px-4 py-3 text-sm" role="status" data-testid="archived-notice">
              <Archive className="size-4 shrink-0" aria-hidden />
              {session.name} is archived, so its sections are read-only. Restore it on the Academic sessions page to make changes.
            </p>
          )}
          <div role="tablist" aria-label="Classes and sections" className="mb-4 flex gap-1 border-b border-line">
            {(["classes", "sections"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams({ tab: t === "classes" ? "" : t })}
                className={clsx("-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize",
                  tab === t ? "border-leaf-600 text-ink" : "border-transparent text-muted hover:text-ink")}>
                {t}
              </button>
            ))}
          </div>
          {tab === "classes" ? (
            <ClassesTab schoolId={schoolId} session={session} canManage={canManage}
              onOpenSections={(id) => setParams({ tab: "sections", class: id })} />
          ) : (
            <SectionsTab schoolId={schoolId} session={session} sessions={sessions} canManage={canManage}
              classFilter={classFilter} onClassFilter={(id) => setParams({ class: id })} />
          )}
        </>
      )}
    </>
  );
}

export default function ClassesPage() {
  return (
    <RequirePermission permission="classes:view">
      <Suspense fallback={<LoadingState />}>
        <ClassesView />
      </Suspense>
    </RequirePermission>
  );
}
