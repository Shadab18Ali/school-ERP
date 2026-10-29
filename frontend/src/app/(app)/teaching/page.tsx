"use client";

import { Presentation } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { MyItemsCard } from "@/components/inventory/my-items";
import { PageHeader } from "@/components/layout/app-shell";
import { MyClassesGrid } from "@/components/teachers/my-classes-grid";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, ApiError, errorMessage } from "@/lib/api";
import type { MyClass } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

interface Data { session_name: string | null; today: string; items: MyClass[] }

function MyClasses() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<{ message: string; notLinked: boolean } | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setD(await apiFetch<Data>("/teaching/classes", { schoolId })); }
    catch (e) { setError({ message: errorMessage(e), notLinked: e instanceof ApiError && e.status === 404 }); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <PageHeader title="My classes" description={d?.session_name ? `Classes assigned to you in ${d.session_name}. You can only see these classes' students.` : undefined} />
      {error ? <ErrorState message={error.message} onRetry={error.notLinked ? undefined : load} />
        : !d ? <LoadingState />
        : d.items.length === 0 ? <div className="rounded-lg border border-line bg-white"><EmptyState icon={Presentation} title="No classes assigned yet" message="Your school office assigns your classes. Once they do, they appear here." /></div>
        : <MyClassesGrid items={d.items} today={d.today} />}
      <div className="mt-6"><MyItemsCard schoolId={schoolId} /></div>
    </>
  );
}

export default function TeachingPage() {
  return <RequirePermission permission="teaching:view"><MyClasses /></RequirePermission>;
}
