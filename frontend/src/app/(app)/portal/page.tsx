"use client";

import { useCallback, useEffect, useState } from "react";
import { RequirePermission } from "@/components/auth/require-permission";
import { PageHeader } from "@/components/layout/app-shell";
import { ChildrenCards } from "@/components/portal/children-cards";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { apiFetch, errorMessage } from "@/lib/api";
import type { PortalChild } from "@/lib/types";
import { useAuth } from "@/providers/auth-provider";

function MyChildren() {
  const { currentSchool } = useAuth();
  const schoolId = currentSchool!.school_id;
  const [items, setItems] = useState<PortalChild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems(await apiFetch<PortalChild[]>("/portal/children", { schoolId })); } catch (e) { setError(errorMessage(e)); }
  }, [schoolId]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState />;
  return (
    <>
      <PageHeader title="My children" description="Attendance, fees, receipts and school notices for your children." />
      <ChildrenCards items={items} />
    </>
  );
}

export default function PortalPage() {
  return <RequirePermission permission="portal:view"><MyChildren /></RequirePermission>;
}
